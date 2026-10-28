import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ghl-send-audio v5 (2026-10-21)
//  - `WA Homio 4` (provider 68655eb3f257d80a13a28216, slot 5) entrou no mapa nome -> id.
//  - Nome de canal fora do mapa fixo passa a ser procurado em `providers` (por nome, sem espaco
//    sobrando) antes de cair no provider padrao — provider novo nao exige deploy aqui.
//
// ghl-send-audio v2 (2026-09-03)
//
// O que mudou em relacao a v1 (2026-05-08):
//  - O telefone que o custom JS le do input do GHL vem em formato NACIONAL ("(27) 99500-8068"),
//    sem o DDI. A v1 mandava esses digitos crus pra Evolution ("27995008068@s.whatsapp.net" ->
//    exists:false) e, pior, GRAVAVA esse numero em conversations.phone_number, contaminando as
//    tentativas seguintes (caminho DB-first). Agora o telefone do input serve SO pra localizar o
//    contato; o alvo do envio vem sempre do GHL (E.164) ou de um phone_number completo do DB.
//  - Conversa aberta na URL mas ausente no DB (ou em OUTRA instancia da mesma subconta): resolve
//    contactId via GET /conversations/{id} e o telefone via GET /contacts/{id}.
//  - phone_number do DB com menos de 12 digitos e conferido contra o GHL e curado se estiver
//    incompleto (mesma ideia da cura no retry da ghl-send-message).
//  - Falha devolve HTTP 422 (nao 200) com {ok:false, errorType, message} — o custom JS v2 lia so
//    res.ok e mostrava "Audio enviado!" mesmo quando nada saiu.

type SupabaseClient = ReturnType<typeof createClient>;

// ===== inline _shared/cors.ts =====
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
};
function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  return null;
}

// ===== inline _shared/supabase.ts =====
function getSupabase(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
}

// ===== inline _shared/ghl-auth.ts (padrao deste projeto: location_tokens + HOMIO_AUTH_*) =====
const AUTH_CLIENT_ID = Deno.env.get('HOMIO_AUTH_CLIENT_ID') ?? '';
const AUTH_CLIENT_SECRET = Deno.env.get('HOMIO_AUTH_CLIENT_SECRET') ?? '';
const AUTH_COMPANY_ID = Deno.env.get('HOMIO_AUTH_COMPANY_ID') ?? '';
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';
const GHL_LOCATION_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/locationToken';
const GHL_VERSION_V2 = '2021-07-28';
const GHL_VERSION_V1 = '2021-04-15';

async function getValidAgencyToken(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.from('agency_token').select('access_token, refresh_token, expires_at').eq('key', 'agency').maybeSingle();
  if (error || !data) { console.error('[agency-token] Not found'); return null; }
  const expMs = new Date(data.expires_at).getTime();
  if (expMs - 120_000 > Date.now()) return data.access_token;
  console.log('[agency-token] Refreshing...');
  try {
    const res = await fetch(GHL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: AUTH_CLIENT_ID, client_secret: AUTH_CLIENT_SECRET, refresh_token: data.refresh_token }),
    });
    if (!res.ok) { console.error(`[agency-token] Refresh failed ${res.status}: ${await res.text()}`); return null; }
    const nd = await res.json();
    const newExpiresAt = new Date(Date.now() + (nd.expires_in || 86400) * 1000).toISOString();
    await supabase.from('agency_token').update({ access_token: nd.access_token, refresh_token: nd.refresh_token, expires_at: newExpiresAt }).eq('key', 'agency');
    return nd.access_token;
  } catch (e: any) { console.error('[agency-token] Refresh error:', e.message); return null; }
}

async function getGHLToken(supabase: SupabaseClient, locationId: string): Promise<string | null> {
  const { data: cached } = await supabase.from('location_tokens').select('access_token, expires_at').eq('location_id', locationId).maybeSingle();
  if (cached?.access_token && cached?.expires_at) {
    if (Date.now() < new Date(cached.expires_at).getTime()) return cached.access_token;
  }
  const agencyToken = await getValidAgencyToken(supabase);
  if (!agencyToken) return null;
  try {
    const res = await fetch(GHL_LOCATION_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${agencyToken}`, 'Version': GHL_VERSION_V2 },
      body: JSON.stringify({ companyId: AUTH_COMPANY_ID, locationId }),
    });
    if (!res.ok) { console.error(`[token] Location token failed ${res.status}: ${await res.text()}`); return null; }
    const data = await res.json();
    const token = data.access_token;
    if (!token) return null;
    const expiresIn = Number(data.expires_in || 86400);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    await supabase.from('location_tokens').upsert({ location_id: locationId, access_token: token, expires_at: expiresAt, updated_at: new Date().toISOString() }, { onConflict: 'location_id' });
    return token;
  } catch (e: any) { console.error('[token] Error:', e.message); return null; }
}

// ===== inline _shared/phone.ts (subset — mesma regra BR da ghl-send-message v49) =====
function getOnlyNumbers(str: string): string {
  if (!str) return '';
  return str.split('@')[0].replace(/\D/g, '');
}
// Regra BR (revisada 2026-06-16): celular = 55+DDD+9+8; fixo = 55+DDD+8 (primeiro digito 2-5).
// So ADICIONA o 9 quando falta num numero de 12 digitos que nao e fixo; nunca remove.
export function normalizePhone(phone: string): string {
  let p = getOnlyNumbers(phone);
  if (p.startsWith('55')) {
    const ddd = p.substring(2, 4);
    const rest = p.substring(4);
    if (rest.length === 8) {
      const firstDigit = parseInt(rest[0], 10);
      if (!Number.isNaN(firstDigit) && (firstDigit < 2 || firstDigit > 5)) p = `55${ddd}9${rest}`;
    }
  } else if (p.startsWith('52') && !p.startsWith('521')) {
    p = '521' + p.substring(2);
  }
  return p;
}

// Um numero com DDI tem pelo menos 12 digitos em todos os paises que a Homio atende
// (BR 12-13, PT 12, US 11 — o unico abaixo; ver isCompletePhone). Menos que isso e forma
// nacional (o input do GHL) ou DB contaminado — e vai ser conferido contra o GHL antes do envio.
export function isCompletePhone(digits: string): boolean {
  const d = getOnlyNumbers(digits);
  if (d.length >= 12) return true;
  // US/CA: 1 + area code [2-9]XX + 7 = 11 digitos. Um celular BR nacional tambem tem 11
  // (DDD 1X + 9 + 8), mas o terceiro digito e sempre 9; no NANP o terceiro e o 2o do area code.
  // Fica ambiguo so em area codes X9X — esses caem no cross-check com o GHL, sem prejuizo.
  if (d.length === 11 && d[0] === '1' && d[1] !== '1' && d[2] !== '9') return true;
  return false;
}

// Decide o alvo entre o que esta no DB e o que o GHL diz do contato. Nunca "adivinha" DDI:
// so troca quando o numero do GHL e completo e termina com os digitos do DB (mesmo numero,
// so que inteiro). Retorna tambem se deve curar o DB.
export function reconcilePhone(dbDigits: string, ghlDigits: string | null): { target: string; heal: boolean } {
  const db = normalizePhone(dbDigits);
  if (isCompletePhone(db)) return { target: db, heal: false };
  const ghl = ghlDigits ? normalizePhone(ghlDigits) : '';
  if (ghl && isCompletePhone(ghl) && ghl.length > db.length && ghl.endsWith(db)) return { target: ghl, heal: true };
  return { target: db, heal: false };
}

// ===== inline _shared/evolution-api.ts (subset) =====
const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') ?? '';
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') ?? '';
async function evolutionSendAudio(instance: string, phone: string, audioUrl: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch(`${EVOLUTION_API_URL}/message/sendWhatsAppAudio/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
      body: JSON.stringify({ number: phone, audio: audioUrl, delay: 1200 }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`sendAudio failed (${res.status}): ${await res.text()}`);
    return res.json();
  } finally { clearTimeout(t); }
}

// ===== ghl-send-audio =====
const STORAGE_BUCKET = 'whatsapp-media';
const DEFAULT_PROVIDER = '67b8e49217347407acca7fd1';
// Caminho rapido nome -> id. Nome fora daqui cai na tabela `providers` (resolveProviderId).
const PROVIDER_NAME_TO_ID: Record<string, string> = {
  'SMS': '67b8e49217347407acca7fd1',
  'WhatsApp Homio': '67b8e49217347407acca7fd1',
  'WA Homio': '67a4fa35ffae7881f31684f3',
  'WA Homio 2': '679d1e13fe8b77fa62001590',
  'WA Homio 3': '67a39b0a1d291e601c80c311',
  'WA Homio 4': '68655eb3f257d80a13a28216',
};

// Mensagens que o custom JS mostra pro atendente (campo `message` da resposta).
const USER_MESSAGES: Record<string, string> = {
  no_instance: 'Nenhum número do Whats Homio está conectado a este canal nesta subconta.',
  instance_disconnected: 'O número do Whats Homio está desconectado. Reconecte pela página de conexão.',
  missing_phone: 'Não encontrei o telefone do contato. Abra a conversa do contato e tente novamente.',
  phone_incomplete: 'O telefone do contato está sem o código do país (+55). Corrija o telefone no cadastro do contato.',
  invalid_phone: 'Este número não tem WhatsApp ou está errado no cadastro do contato.',
  contact_not_found: 'Não encontrei o contato no CRM. Abra a conversa do contato e tente novamente.',
  ghl_conversation_failed: 'Não consegui abrir a conversa no CRM. Tente novamente.',
  no_ghl_token: 'Falha de autenticação com o CRM. Avise o suporte da Homio.',
  storage_upload_failed: 'Falha ao guardar o áudio. Tente novamente.',
  evolution_error: 'Falha ao enviar pelo WhatsApp. Tente novamente em instantes.',
  resolution_failed: 'Não consegui identificar o destinatário. Abra a conversa do contato e tente novamente.',
  unhandled_exception: 'Erro inesperado ao enviar o áudio. Tente novamente.',
};

interface Instance { id: number; evolution_name: string; location_id: string; status: string; conversation_provider: string | null; number_connected: string | null; }
interface Conversation { id: number; instance_id: number; homio_id: string; phone_number: string; contact_id: string; whatsapp_lid: string | null; is_group: boolean; evo_group_id: string | null; }
const CONV_COLS = 'id, instance_id, homio_id, phone_number, contact_id, whatsapp_lid, is_group, evo_group_id';
const INST_COLS = 'id, evolution_name, location_id, status, conversation_provider, number_connected';

export function parsePageUrl(pageUrl: string): { locationId: string | null; conversationId: string | null; contactId: string | null } {
  let locationId: string | null = null, conversationId: string | null = null, contactId: string | null = null;
  try {
    const locMatch = pageUrl.match(/\/location\/([^\/?#]+)/);
    if (locMatch) locationId = locMatch[1];
    const convMatch = pageUrl.match(/\/conversations\/conversations\/([^\/?#]+)/);
    if (convMatch) conversationId = convMatch[1];
    const contactMatch = pageUrl.match(/\/contacts\/detail\/([^\/?#]+)/);
    if (contactMatch) contactId = contactMatch[1];
  } catch (_e) { /* url malformada: segue sem ids */ }
  return { locationId, conversationId, contactId };
}

// Nome do canal (como o custom JS le do composer) ou id -> id do conversation provider.
// Ordem: id cru > mapa fixo > tabela `providers` (nome sem espaco sobrando) > padrao.
async function resolveProviderId(supabase: SupabaseClient, input: string | null): Promise<string> {
  if (!input) return DEFAULT_PROVIDER;
  const trimmed = input.trim();
  if (/^[a-f0-9]{24}$/i.test(trimmed)) return trimmed;
  if (PROVIDER_NAME_TO_ID[trimmed]) return PROVIDER_NAME_TO_ID[trimmed];
  try {
    const { data } = await supabase.from('providers').select('name, provider_id');
    const row = (data || []).find((p: any) => String(p.name || '').trim() === trimmed);
    if (row?.provider_id) return String(row.provider_id).trim();
  } catch (e: any) { console.warn('[provider] lookup em providers falhou:', e.message); }
  console.warn(`[provider] canal "${trimmed}" desconhecido; usando o padrao`);
  return DEFAULT_PROVIDER;
}

function genStoragePath(locationId: string): string {
  const ts = Date.now();
  const rand = crypto.randomUUID().split('-')[0];
  return `outbound-audio/${locationId}/${ts}_${rand}.mp3`;
}

async function uploadAudioToStorage(supabase: SupabaseClient, bytes: Uint8Array, locationId: string, contentType: string): Promise<string | null> {
  try {
    const path = genStoragePath(locationId);
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, bytes, { contentType, upsert: false });
    if (error) { console.error(`[storage] Upload failed: ${error.message}`); return null; }
    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    console.log(`[storage] Uploaded: ${data?.publicUrl}`);
    return data?.publicUrl || null;
  } catch (e: any) { console.error('[storage] Error:', e.message); return null; }
}

async function findInstance(supabase: SupabaseClient, locationId: string, providerId: string): Promise<Instance | null> {
  const { data, error } = await supabase.from('instances').select(INST_COLS).eq('location_id', locationId).eq('conversation_provider', providerId).order('id', { ascending: true }).limit(1).maybeSingle();
  if (error) { console.error('[instance] Query error:', JSON.stringify(error)); return null; }
  return data as unknown as Instance | null;
}

async function findConversationByContact(supabase: SupabaseClient, contactId: string, instanceId: number): Promise<Conversation | null> {
  const { data } = await supabase.from('conversations').select(CONV_COLS).eq('contact_id', contactId).eq('instance_id', instanceId).limit(1).maybeSingle();
  return data as unknown as Conversation | null;
}

async function findConversationByHomioId(supabase: SupabaseClient, homioId: string): Promise<Conversation | null> {
  const { data } = await supabase.from('conversations').select(CONV_COLS).eq('homio_id', homioId).limit(1).maybeSingle();
  return data as unknown as Conversation | null;
}

function ghlHeaders(token: string, version: string): Record<string, string> {
  return { 'Authorization': `Bearer ${token}`, 'Version': version, 'Accept': 'application/json', 'Content-Type': 'application/json' };
}

// GET /conversations/{id} -> contactId. Cobre conversa aberta na URL que ainda nao existe no DB.
async function getGHLConversationContact(token: string, conversationId: string): Promise<string | null> {
  try {
    const res = await fetch(`${GHL_BASE}/conversations/${encodeURIComponent(conversationId)}`, { headers: ghlHeaders(token, GHL_VERSION_V1) });
    if (!res.ok) { console.warn(`[ghl-conv] GET ${conversationId} -> ${res.status}`); return null; }
    const d = await res.json();
    return d.contactId || d.conversation?.contactId || null;
  } catch (e: any) { console.error('[ghl-conv] GET error:', e.message); return null; }
}

// GET /contacts/{id} -> telefone E.164 (fonte canonica do numero do contato).
async function getGHLContactPhone(token: string, contactId: string): Promise<string | null> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}`, { headers: ghlHeaders(token, GHL_VERSION_V2) });
    if (!res.ok) { console.warn(`[contact] GET ${contactId} -> ${res.status}`); return null; }
    const d = await res.json();
    const phone = d.contact?.phone || d.phone || null;
    return phone ? String(phone) : null;
  } catch (e: any) { console.error('[contact] GET error:', e.message); return null; }
}

async function searchContact(token: string, locationId: string, phoneDigits: string): Promise<{ id: string; phone: string | null } | null> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: ghlHeaders(token, GHL_VERSION_V2),
      body: JSON.stringify({ locationId, page: 1, pageLimit: 5, filters: [{ field: 'phone', operator: 'contains', value: phoneDigits }] }),
    });
    if (!res.ok) { console.warn(`[contact] search -> ${res.status} ${await res.text()}`); return null; }
    const data = await res.json();
    const c = (data.total > 0 && data.contacts?.length > 0) ? data.contacts[0] : null;
    return c ? { id: c.id, phone: c.phone ? String(c.phone) : null } : null;
  } catch (e: any) { console.error('[contact] search error:', e.message); return null; }
}

async function upsertContact(token: string, locationId: string, phoneDigits: string): Promise<string | null> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: 'POST',
      headers: ghlHeaders(token, GHL_VERSION_V2),
      body: JSON.stringify({ locationId, phone: `+${phoneDigits}` }),
    });
    if (!res.ok) { console.error(`[contact] Upsert failed: ${res.status} ${await res.text()}`); return null; }
    const data = await res.json();
    return data.contact?.id || null;
  } catch (e: any) { console.error('[contact] Upsert error:', e.message); return null; }
}

async function findOrCreateGHLConversation(token: string, locationId: string, contactId: string): Promise<string | null> {
  try {
    const searchRes = await fetch(`${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=1&sort=desc&sortBy=last_message_date`, { headers: ghlHeaders(token, GHL_VERSION_V1) });
    if (searchRes.ok) { const d = await searchRes.json(); if (d.conversations?.length > 0) return d.conversations[0].id; }
    const createRes = await fetch(`${GHL_BASE}/conversations/`, {
      method: 'POST',
      headers: ghlHeaders(token, GHL_VERSION_V1),
      body: JSON.stringify({ locationId, contactId }),
    });
    if (createRes.ok) { const d = await createRes.json(); return d.conversation?.id || d.id || null; }
    if (createRes.status === 409) {
      const retryRes = await fetch(`${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=1`, { headers: ghlHeaders(token, GHL_VERSION_V1) });
      if (retryRes.ok) { const d = await retryRes.json(); if (d.conversations?.length > 0) return d.conversations[0].id; }
    }
    console.error(`[ghl-conv] Failed to find/create: ${createRes.status} ${await createRes.text()}`);
    return null;
  } catch (e: any) { console.error('[ghl-conv] Error:', e.message); return null; }
}

async function postInboundAudio(token: string, conversationId: string, providerId: string, attachmentUrl: string): Promise<string | null> {
  try {
    const type = providerId === '67b8e49217347407acca7fd1' ? 'SMS' : 'Custom';
    const body = { type, conversationId, message: '', conversationProviderId: providerId, direction: 'outbound', attachments: [attachmentUrl] };
    const res = await fetch(`${GHL_BASE}/conversations/messages/inbound`, {
      method: 'POST',
      headers: ghlHeaders(token, GHL_VERSION_V1),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`[inbound] ${res.status}: ${text}`);
    if (!res.ok) return null;
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* corpo nao-JSON: usa id sintetico abaixo */ }
    return data.messageId || data.id || data.message?.id || data.data?.id || `ghl_${Date.now()}`;
  } catch (e: any) { console.error('[inbound] Error:', e.message); return null; }
}

// Insere a linha da conversa no DB; se o homio_id ja existir (conversa da mesma subconta em
// OUTRA instancia — UNIQUE conversations_homio_id_unique), devolve a existente em vez de engolir.
async function insertOrGetConversation(supabase: SupabaseClient, row: { instance_id: number; homio_id: string; phone_number: string; contact_id: string }): Promise<Conversation | null> {
  const { data, error } = await supabase.from('conversations').insert({ ...row, whatsapp_lid: null, is_group: false, evo_group_id: null }).select(CONV_COLS).single();
  if (!error && data) return data as unknown as Conversation;
  if (error && error.code === '23505') {
    console.log(`[conv] homio_id ${row.homio_id} ja existe (outra instancia) — reaproveitando`);
    return findConversationByHomioId(supabase, row.homio_id);
  }
  if (error) console.error('[conv] insert error:', JSON.stringify(error));
  return null;
}

async function logSendError(supabase: SupabaseClient, locationId: string, phone: string, errorType: string, errorMessage: string, raw: any): Promise<void> {
  try {
    await supabase.from('send_errors').insert({
      location_id: locationId,
      phone,
      error_type: errorType,
      error_message: errorMessage,
      raw_payload: { source: 'ghl-send-audio', ...raw },
    });
  } catch (e: any) { console.error('[send_errors] insert failed:', e.message); }
}

// Falha visivel pro atendente: 422 + mensagem em portugues. O custom JS v2 (que so olha res.ok)
// passa a mostrar erro em vez de "Audio enviado!"; o v3 le `message`.
function failRes(errorType: string, detail: string): Response {
  return jsonRes({ ok: false, success: false, errorType, error: detail, message: USER_MESSAGES[errorType] || USER_MESSAGES.unhandled_exception }, 422);
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return jsonRes({ ok: false, error: 'Method not allowed' }, 405);

  const startTime = Date.now();
  let form: FormData;
  try { form = await req.formData(); }
  catch (e: any) { return jsonRes({ ok: false, error: 'Invalid multipart body', detail: e.message }, 400); }

  const audioFile = form.get('audioFile');
  const pageUrl = String(form.get('pageUrl') || '');
  const conversationProvider = String(form.get('conversationProvider') || '');
  const phoneNumberRaw = String(form.get('phoneNumber') || '');

  if (!(audioFile instanceof Blob) || audioFile.size === 0) return jsonRes({ ok: false, error: 'Missing audioFile' }, 400);
  if (!pageUrl) return jsonRes({ ok: false, error: 'Missing pageUrl' }, 400);

  const { locationId, conversationId: pageConvId, contactId: pageContactId } = parsePageUrl(pageUrl);
  if (!locationId) return jsonRes({ ok: false, error: 'Could not parse locationId from pageUrl' }, 400);

  const supabase = getSupabase();

  const providerId = await resolveProviderId(supabase, conversationProvider);
  console.log(`[ghl-send-audio] location=${locationId} provider=${conversationProvider}->${providerId} phone=${phoneNumberRaw} pageConvId=${pageConvId || '-'} pageContactId=${pageContactId || '-'} size=${audioFile.size}b type=${audioFile.type}`);

  // token e obtido uma vez, sob demanda
  let tokenCache: string | null | undefined;
  const getToken = async (): Promise<string | null> => {
    if (tokenCache === undefined) tokenCache = await getGHLToken(supabase, locationId);
    return tokenCache;
  };

  try {
    const instance = await findInstance(supabase, locationId, providerId);
    if (!instance) {
      await logSendError(supabase, locationId, phoneNumberRaw, 'no_instance', `No instance for provider ${providerId}`, { pageUrl, conversationProvider });
      return failRes('no_instance', 'No WhatsApp instance configured for this provider in this location');
    }
    if (instance.status !== 'open') {
      await logSendError(supabase, locationId, phoneNumberRaw, 'instance_disconnected', `Instance ${instance.evolution_name} is ${instance.status}`, { pageUrl, instance_id: instance.id });
      return failRes('instance_disconnected', 'WhatsApp instance not connected');
    }

    let dbConversation: Conversation | null = null;
    let contactId: string | null = null;
    let ghlConversationId: string | null = null;
    let targetNumber: string | null = null;
    let resolvedBy = '';

    // ---- Passo 1: conversa da URL no DB (qualquer instancia da subconta — o alvo nao depende da instancia)
    if (pageConvId) {
      dbConversation = await findConversationByHomioId(supabase, pageConvId);
      if (dbConversation) {
        contactId = dbConversation.contact_id || null;
        ghlConversationId = dbConversation.homio_id;
        if (dbConversation.is_group && dbConversation.evo_group_id) {
          targetNumber = dbConversation.evo_group_id;
          resolvedBy = 'db-group';
        } else if (dbConversation.phone_number && getOnlyNumbers(dbConversation.phone_number).length > 5) {
          const dbDigits = getOnlyNumbers(dbConversation.phone_number);
          let ghlPhone: string | null = null;
          if (!isCompletePhone(dbDigits) && contactId) {
            // DB com numero curto (forma nacional gravada pela v1, ou DDI curto): confere no GHL
            const token = await getToken();
            if (token) ghlPhone = await getGHLContactPhone(token, contactId);
          }
          const rec = reconcilePhone(dbDigits, ghlPhone);
          targetNumber = rec.target;
          resolvedBy = rec.heal ? 'db-phone-healed' : 'db-phone';
          if (rec.heal) {
            await supabase.from('conversations').update({ phone_number: rec.target }).eq('id', dbConversation.id);
            console.log(`[ghl-send-audio] Conversa ${dbConversation.id} curada: phone_number ${dbDigits} → ${rec.target}`);
          }
        } else if (dbConversation.whatsapp_lid) {
          targetNumber = dbConversation.whatsapp_lid.includes('@') ? dbConversation.whatsapp_lid : `${dbConversation.whatsapp_lid}@lid`;
          resolvedBy = 'db-lid';
        }
        if (dbConversation.instance_id !== instance.id) console.log(`[ghl-send-audio] Conversa ${dbConversation.id} e da instancia ${dbConversation.instance_id}; enviando pela ${instance.id} (${instance.evolution_name}) escolhida no composer`);
        console.log(`[ghl-send-audio] DB conversation ${dbConversation.id} resolved (${resolvedBy}) -> contact=${contactId} target=${targetNumber}`);
      }
    }

    // ---- Passo 2: sem conversa no DB — descobrir o contato pelo GHL (conversa da URL, ou contato da URL)
    if (!contactId) {
      if (pageConvId) {
        const token = await getToken();
        if (!token) { await logSendError(supabase, locationId, phoneNumberRaw, 'no_ghl_token', 'Could not obtain GHL location token', { pageUrl }); return failRes('no_ghl_token', 'GHL authentication failure'); }
        contactId = await getGHLConversationContact(token, pageConvId);
        if (contactId) { ghlConversationId = pageConvId; resolvedBy = 'ghl-conversation'; }
      }
      if (!contactId && pageContactId) { contactId = pageContactId; resolvedBy = 'url-contact'; }
    }

    // ---- Passo 3: contato conhecido, alvo ainda nao — telefone E.164 do cadastro do GHL
    if (contactId && !targetNumber) {
      const token = await getToken();
      if (!token) { await logSendError(supabase, locationId, phoneNumberRaw, 'no_ghl_token', 'Could not obtain GHL location token', { pageUrl }); return failRes('no_ghl_token', 'GHL authentication failure'); }
      const ghlPhone = await getGHLContactPhone(token, contactId);
      if (ghlPhone) { targetNumber = normalizePhone(ghlPhone); resolvedBy = resolvedBy || 'ghl-contact'; }
      else console.warn(`[ghl-send-audio] contato ${contactId} sem telefone no GHL`);
    }

    // ---- Passo 4: ultimo recurso — telefone do input do composer (formato nacional!) SO pra achar o contato
    if (!contactId) {
      const phoneDigits = getOnlyNumbers(phoneNumberRaw);
      if (!phoneDigits) {
        await logSendError(supabase, locationId, phoneNumberRaw, 'missing_phone', 'No phoneNumber in payload and no DB/GHL conversation found', { pageUrl });
        return failRes('missing_phone', 'Missing phoneNumber and no existing conversation found for this URL');
      }
      const token = await getToken();
      if (!token) { await logSendError(supabase, locationId, phoneDigits, 'no_ghl_token', 'Could not obtain GHL location token', { pageUrl }); return failRes('no_ghl_token', 'GHL authentication failure'); }

      const found = await searchContact(token, locationId, phoneDigits);
      if (found) {
        contactId = found.id;
        // o telefone do input pode vir sem DDI; o do GHL e E.164
        const rec = reconcilePhone(phoneDigits, found.phone);
        targetNumber = rec.target;
        resolvedBy = 'search-contact';
      } else if (phoneNumberRaw.trim().startsWith('+') || isCompletePhone(phoneDigits)) {
        // numero completo e contato inexistente: cria (comportamento da v1)
        const upsertedId = await upsertContact(token, locationId, normalizePhone(phoneDigits));
        if (!upsertedId) { await logSendError(supabase, locationId, phoneDigits, 'contact_not_found', 'Could not upsert contact', { pageUrl }); return failRes('contact_not_found', 'Could not find or create contact'); }
        contactId = upsertedId;
        targetNumber = normalizePhone(phoneDigits);
        resolvedBy = 'upsert-contact';
      } else {
        // sem DDI e sem contato: NAO adivinhar pais nem criar contato torto (+27... seria Africa do Sul)
        await logSendError(supabase, locationId, phoneDigits, 'phone_incomplete', `Phone "${phoneNumberRaw}" has no country code and no matching contact`, { pageUrl });
        return failRes('phone_incomplete', 'Phone has no country code and no contact matched');
      }
    }

    if (!contactId || !targetNumber) {
      await logSendError(supabase, locationId, phoneNumberRaw, 'resolution_failed', 'Could not resolve target/contact', { pageUrl, targetNumber, ghlConversationId, contactId, resolvedBy });
      return failRes('resolution_failed', 'Could not resolve send target');
    }

    // Guard final: alvo que nao e grupo nem LID precisa ter DDI. Se ainda assim vier curto, e um
    // cadastro do GHL sem DDI — erro nomeado em vez de "exists:false" cru.
    if (!targetNumber.includes('@') && !isCompletePhone(targetNumber)) {
      await logSendError(supabase, locationId, targetNumber, 'phone_incomplete', `Resolved target "${targetNumber}" (${resolvedBy}) has no country code`, { pageUrl, target_number: targetNumber, contactId, resolvedBy });
      return failRes('phone_incomplete', `Resolved phone "${targetNumber}" has no country code`);
    }

    // ---- Passo 5: conversa do GHL + linha no DB pra esta instancia
    if (!ghlConversationId) {
      const existingByContact = await findConversationByContact(supabase, contactId, instance.id);
      if (existingByContact) {
        dbConversation = existingByContact;
        ghlConversationId = existingByContact.homio_id;
      } else {
        const token = await getToken();
        if (!token) { await logSendError(supabase, locationId, targetNumber, 'no_ghl_token', 'Could not obtain GHL location token', { pageUrl }); return failRes('no_ghl_token', 'GHL authentication failure'); }
        ghlConversationId = await findOrCreateGHLConversation(token, locationId, contactId);
        if (!ghlConversationId) {
          await logSendError(supabase, locationId, targetNumber, 'ghl_conversation_failed', 'Could not find or create GHL conversation', { pageUrl, contactId });
          return failRes('ghl_conversation_failed', 'Could not create GHL conversation');
        }
      }
    }
    if (!dbConversation && !targetNumber.includes('@')) {
      dbConversation = await insertOrGetConversation(supabase, { instance_id: instance.id, homio_id: ghlConversationId, phone_number: targetNumber, contact_id: contactId });
    }

    console.log(`[ghl-send-audio] Resolved (${resolvedBy}) -> contact=${contactId} conv=${ghlConversationId} target=${targetNumber} dbConv=${dbConversation?.id ?? '-'}`);

    // ---- Passo 6: upload + envio
    const audioBytes = new Uint8Array(await audioFile.arrayBuffer());
    const contentType = audioFile.type || 'audio/webm';
    const publicUrl = await uploadAudioToStorage(supabase, audioBytes, locationId, contentType);
    if (!publicUrl) {
      await logSendError(supabase, locationId, targetNumber, 'storage_upload_failed', 'Storage upload returned null', { pageUrl });
      return failRes('storage_upload_failed', 'Failed to upload audio');
    }

    let evolutionResult: any = null;
    let sendError: string | null = null;
    try {
      evolutionResult = await evolutionSendAudio(instance.evolution_name, targetNumber, publicUrl);
    } catch (e: any) {
      sendError = e.name === 'AbortError' ? 'sendAudio timeout (45s)' : (e.message || 'Unknown Evolution error');
      console.error('[ghl-send-audio] Evolution error:', sendError);
    }

    if (sendError || !evolutionResult) {
      const errLower = (sendError || '').toLowerCase();
      const isInvalidPhone = errLower.includes('does not exist') || errLower.includes('exists":false') || errLower.includes('not registered') || errLower.includes('invalid number');
      const isDisconnected = errLower.includes('connection closed') || errLower.includes('disconnected') || errLower.includes('not connected');
      const errorType = isInvalidPhone ? 'invalid_phone' : isDisconnected ? 'instance_disconnected' : 'evolution_error';
      await logSendError(supabase, locationId, targetNumber, errorType, sendError || 'Empty Evolution result', { pageUrl, target_number: targetNumber, instance: instance.evolution_name, resolvedBy, contactId });
      return failRes(errorType, `Failed to send audio: ${sendError || 'unknown'}`);
    }

    const token = await getToken();
    let ghlMessageId: string | null = null;
    if (token) ghlMessageId = await postInboundAudio(token, ghlConversationId, providerId, publicUrl);
    else console.error('[ghl-send-audio] No GHL token after Evolution success - skipping inbound post');

    if (dbConversation) {
      const { error: msgError } = await supabase.from('messages').insert({
        conversation_id: dbConversation.id, homio_id: ghlMessageId || `ghl_${Date.now()}`, evolution_id: evolutionResult?.key?.id || `evo_${Date.now()}`,
      });
      if (msgError) console.error('[ghl-send-audio] message insert error:', JSON.stringify(msgError));
    }

    const elapsed = Date.now() - startTime;
    console.log(`[ghl-send-audio] OK in ${elapsed}ms | instance=${instance.evolution_name} | to=${targetNumber} | conv=${ghlConversationId} | url=${publicUrl}`);
    return jsonRes({ ok: true, success: true, evolutionMessageId: evolutionResult?.key?.id, ghlMessageId, conversationId: ghlConversationId, audioUrl: publicUrl, resolvedBy, elapsed });
  } catch (error: any) {
    console.error('[ghl-send-audio] Unhandled error:', error.message, error.stack);
    await logSendError(supabase, locationId, phoneNumberRaw, 'unhandled_exception', error.message || 'Unknown error', { pageUrl, stack: error.stack });
    return failRes('unhandled_exception', 'Internal error processing audio');
  }
});
