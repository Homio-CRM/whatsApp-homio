import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCors, jsonRes } from "../_shared/cors.ts";
import { getSupabase, type SupabaseClient } from "../_shared/supabase.ts";
import { getGHLToken, GHL_BASE, GHL_VERSION_V1, GHL_VERSION_V2 } from "../_shared/ghl-auth.ts";
import { resolvePhoneFromData, normalizePhone, getOnlyNumbers, isGroupLikeId, groupJidCandidates, samePhone } from "../_shared/phone.ts";
import { detectMedia, extractMessageText, base64ToUint8Array, renderMessage, renderQuote, snippet, DELIMITADOR } from "../_shared/media.ts";
import { getMediaBase64, getEvolutionName, getEvolutionContactName, fetchInstanceInfo, evolutionFindGroup, EVOLUTION_API_URL, EVOLUTION_API_KEY } from "../_shared/evolution-api.ts";
import { typedChoice, voteValue, ensureMenuField, setMenuField, MENU_TYPED_WINDOW_MS, type PollOption } from "../_shared/menu-poll.ts";

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
// 2026-09-24: a GEMINI_API_KEY (paga, saldo prepay) esta sem credito desde 09/09 e
// responde 402 — a reserva estava morta. A chave free entra como 2o nivel, antes da
// paga. Ordem: Groq -> Gemini free -> Gemini pago.
const GEMINI_FREE_API_KEY = Deno.env.get('GEMINI_FREE_API_KEY') ?? '';
const GEMINI_KEYS = [['free', GEMINI_FREE_API_KEY], ['pago', GEMINI_API_KEY]].filter(([, k]) => k);
// Transcricao de audio (2026-09-10): Groq na frente, Gemini de reserva.
//
// Ate aqui era so Gemini (AI Studio, saldo prepay). Em 2026-09-09 as 17h BRT o
// saldo zerou e a transcricao caiu por 21 horas em TODAS as locations, sem
// ninguem ver — o mesmo incidente de 2026-06-10. Provedor unico + falha
// silenciosa (Promise.allSettled engole) ja quebrou duas vezes.
//
// Groq roda whisper-large-v3-turbo. Free tier: 28.800 s de audio/dia contra os
// ~7.000 s/dia que passam por aqui (pico medido: 10.432 s). Medido em 10 audios
// reais desta base em 2026-09-10: 31x tempo real contra 6x do Gemini, e sem os
// dois defeitos estruturais que o Gemini produziu na amostra (uma mensagem de
// 13 s virou 163.887 chars de "nao, nao, nao..." e outra voltou como legenda
// com timestamps). Onde o Gemini erra, erra caro: "estornar" -> "se tornar",
// "em falta" -> "em pauta".
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ?? '';
const GROQ_MODEL = 'whisper-large-v3-turbo';
// O Whisper copia o ESTILO do `prompt`. Sem ele, o Groq devolveu um audio
// inteiro sem pontuacao nenhuma — e a MESMA chamada na Cloudflare, com o mesmo
// modelo, veio pontuada. Custa zero token e resolve.
const GROQ_PROMPT = 'Transcrição em português do Brasil, com pontuação e acentuação corretas.';
const STORAGE_BUCKET = 'whatsapp-media';
const GHL_MAX_FILE_SIZE_MB = 5;

// 2026-10-17 — decisao de fromMe (wiki: debug_mensagem_do_dono_vira_inbound_name_connected_vazio).
// Criterio historico: `pushName === instances.name_connected`. Falhou quando a instancia nasceu sem
// nome (Demonstracao/Mivita: toda mensagem do dono virou inbound e a Conversation AI da GHL respondeu)
// e na reemissao por READ, em que a 2.3.7 manda pushName "Voce". `key.fromMe` foi medido em ~17 mil
// eventos da 2.3.7 sem um unico cliente marcado true, mas ja foi furado em versao anterior — entao
// ele so decide quando o nome nao serve, e TODA discordancia vai pra tabela `fromme_audit`.
// FROMME_KEY_PRIMARY=true (secret) inverte: key decide, nome audita.
const FROMME_KEY_PRIMARY = (Deno.env.get('FROMME_KEY_PRIMARY') ?? 'false') === 'true';
const PUSHNAME_SEM_VALOR = new Set(['', 'Você', 'Voce', 'You']);

type FromMeAudit = {
  instance_name: string; location_id?: string | null; evolution_id?: string | null; remote_jid?: string | null;
  key_from_me?: boolean | null; push_name?: string | null; name_connected?: string | null; name_from_me?: boolean | null;
  decision: 'outbound' | 'inbound' | 'skipped'; reason: string; event_id?: number | string | null; texto?: string | null;
};
async function auditFromMe(supabase: SupabaseClient, row: FromMeAudit): Promise<void> {
  try {
    const { error } = await supabase.from('fromme_audit').insert({ ...row, event_id: row.event_id == null ? null : Number(row.event_id), texto: row.texto ? String(row.texto).slice(0, 160) : null });
    if (error) console.warn('[fromme] audit insert falhou:', error.message);
  } catch (e: any) { console.warn('[fromme] audit error:', e?.message ?? e); }
}

// Camada 3. keyFlag = key.fromMe (null se ausente). Nome so conta quando a instancia tem name_connected
// e o pushName tem valor. Concordam: segue. Discordam: quem manda e o nome (ou a key, com o secret),
// e o caso vai pra auditoria. Nome inutilizavel: key decide (foi exatamente o buraco de 17/10).
function decideFromMe(keyFlag: boolean | null, pushName: string, nameConnected: string | null | undefined): { fromMe: boolean; nameFromMe: boolean | null; reason: string | null } {
  const nameKnown = !!nameConnected && !PUSHNAME_SEM_VALOR.has(pushName);
  const nameFromMe = nameKnown ? pushName === nameConnected : null;
  if (keyFlag === null) return { fromMe: nameFromMe === true, nameFromMe, reason: nameKnown ? null : 'no_signal' };
  if (nameFromMe === null) return { fromMe: keyFlag, nameFromMe, reason: 'name_unknown_key_used' };
  if (keyFlag === nameFromMe) return { fromMe: keyFlag, nameFromMe, reason: null };
  return { fromMe: FROMME_KEY_PRIMARY ? keyFlag : nameFromMe, nameFromMe, reason: keyFlag ? 'disagree_key_true_name_false' : 'disagree_key_false_name_true' };
}

async function generateHash(data: any): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function uploadFileToGHL(token: string, locationId: string, conversationId: string, base64Data: string, fileName: string, mimeType: string): Promise<string | null> {
  try {
    const bytes = base64ToUint8Array(base64Data);
    const formData = new FormData();
    formData.append('fileAttachment', new Blob([bytes], { type: mimeType }), fileName);
    formData.append('conversationId', conversationId);
    formData.append('locationId', locationId);
    const res = await fetch(`${GHL_BASE}/conversations/messages/upload`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1 }, body: formData });
    if (!res.ok) { console.error(`[upload] GHL upload failed: ${res.status} ${await res.text()}`); return null; }
    const data = await res.json();
    const urls = Object.values(data.uploadedFiles || {});
    return (urls[0] as string) || null;
  } catch (e: any) { console.error('[upload] Error:', e.message); return null; }
}

async function uploadFileToStorage(supabase: SupabaseClient, base64Data: string, fileName: string, mimeType: string, conversationId: string): Promise<string | null> {
  try {
    const bytes = base64ToUint8Array(base64Data);
    const path = `${conversationId}/${Date.now()}_${fileName}`;
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, bytes, { contentType: mimeType, upsert: false });
    if (error) { console.error(`[storage] Upload failed: ${error.message}`); return null; }
    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    console.log(`[storage] Uploaded: ${data?.publicUrl}`);
    return data?.publicUrl || null;
  } catch (e: any) { console.error('[storage] Error:', e.message); return null; }
}

// ATENCAO: "nao achou" e "a busca falhou" sao coisas DIFERENTES e ambas voltavam null em silencio.
// Um 429/5xx transitorio fazia o chamador concluir "contato nao existe" e partir pro upsert, que
// casa pelo telefone e mexe num contato que ja existia. Agora a falha e logada e sinalizada.
async function searchContact(token: string, locationId: string, phone: string): Promise<any | null> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/search`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ locationId, page: 1, pageLimit: 20, filters: [{ field: 'phone', operator: 'contains', value: phone }] }) });
    if (!res.ok) {
      console.error(`[contact] SEARCH FALHOU ${res.status} para ${phone} — o proximo passo vai tratar como "contato novo": ${(await res.text()).substring(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return (data.total > 0 && data.contacts?.length > 0) ? data.contacts[0] : null;
  } catch (e: any) {
    console.error(`[contact] SEARCH erro de rede para ${phone} — o proximo passo vai tratar como "contato novo": ${e?.message ?? e}`);
    return null;
  }
}

// NUNCA mandar `tags` no corpo do /contacts/upsert: o GHL trata o array como estado completo e
// SUBSTITUI as tags do contato. Se o upsert casar com um contato que ja existe (telefone igual),
// tudo que nao estiver no array e apagado — inclusive tag que automacao do cliente usa como
// bloqueio de workflow. Foi o que aconteceu na Rede C&D em 2026-08-07 (contato d7fM2yDelNapui8Yv3Sw:
// "Tag Removida" por Integration no registro de auditoria, contato reentrou no workflow e recebeu
// a saudacao de novo). Regra do Luan, ja aplicada na lead-capture do Acervo: upsert SEM tags e
// depois POST /contacts/{id}/tags, que faz append.
async function upsertContact(token: string, locationId: string, phone: string, name: string, tags: string[]): Promise<string | null> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/upsert`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ name, locationId, phone: `+${phone}` }) });
    if (!res.ok) { console.error(`[contact] Upsert failed: ${res.status}`); return null; }
    const data = await res.json();
    const contactId = data.contact?.id || null;
    if (contactId && tags.length > 0) await addContactTags(token, contactId, tags);
    return contactId;
  } catch { return null; }
}

// Tenta tomar a posse da criacao de contato/conversa para (instancia, telefone).
// Duas mensagens do mesmo numero chegando juntas caem as duas no caminho "sem conversa" — a linha
// em conversations so nasce depois das chamadas ao GHL. Quem insere a claim primeiro faz o trabalho.
// Claim mais velha que STALE_CLAIM_MS e de invocacao que morreu no meio: pode ser tomada de volta.
const STALE_CLAIM_MS = 30_000;

async function tryClaimContactCreation(supabase: SupabaseClient, instanceId: number, phone: string): Promise<boolean> {
  try {
    const { error } = await supabase.from('contact_claims').insert({ instance_id: instanceId, phone });
    if (!error) return true;
    if (error.code !== '23505') { console.warn(`[claim] insert falhou (${error.code}) — seguindo sem trava:`, error.message); return true; }
    const { data: atual } = await supabase.from('contact_claims').select('claimed_at').eq('instance_id', instanceId).eq('phone', phone).maybeSingle();
    if (atual && Date.now() - new Date(atual.claimed_at).getTime() > STALE_CLAIM_MS) {
      console.warn(`[claim] claim velha em ${instanceId}/${phone} — invocacao anterior morreu, tomando de volta`);
      await supabase.from('contact_claims').update({ claimed_at: new Date().toISOString() }).eq('instance_id', instanceId).eq('phone', phone);
      return true;
    }
    return false;
  } catch (e: any) { console.warn('[claim] erro inesperado — seguindo sem trava:', e?.message ?? e); return true; }
}

async function releaseContactClaim(supabase: SupabaseClient, instanceId: number, phone: string): Promise<void> {
  try { await supabase.from('contact_claims').delete().eq('instance_id', instanceId).eq('phone', phone); }
  catch (e: any) { console.warn('[claim] release falhou:', e?.message ?? e); }
}

// Perdeu a corrida: espera a outra invocacao publicar a conversa. Fail-open — se nao aparecer no
// prazo, o chamador segue e cria do jeito antigo (melhor um contato duplicado que perder a mensagem).
// Procura pelas MESMAS chaves da busca original (telefone real, depois LID) — senao o perdedor
// espera por uma chave que o vencedor nao gravou.
async function waitForConversation(supabase: SupabaseClient, instanceId: number, realPhone: string | null, lid: string | null): Promise<any | null> {
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (realPhone) {
      const { data: rows } = await supabase.from('conversations').select('*').eq('instance_id', instanceId).eq('phone_number', realPhone).limit(1);
      if (rows?.[0]) { console.log(`[claim] conversa ${rows[0].id} publicada pela outra invocacao apos ${(i + 1) * 500}ms`); return rows[0]; }
    }
    if (lid) {
      const { data: rows } = await supabase.from('conversations').select('*').eq('instance_id', instanceId).eq('whatsapp_lid', lid).limit(1);
      if (rows?.[0]) { console.log(`[claim] conversa ${rows[0].id} (por LID) publicada pela outra invocacao apos ${(i + 1) * 500}ms`); return rows[0]; }
    }
  }
  console.warn(`[claim] a outra invocacao nao publicou a conversa de ${realPhone || lid} em 8s — seguindo mesmo assim`);
  return null;
}

async function findOrCreateGHLConversation(token: string, locationId: string, contactId: string): Promise<string | null> {
  try {
    const searchRes = await fetch(`${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=1&sort=desc&sortBy=last_message_date`, { headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Accept': 'application/json' } });
    if (searchRes.ok) { const d = await searchRes.json(); if (d.conversations?.length > 0) return d.conversations[0].id; }
    const createRes = await fetch(`${GHL_BASE}/conversations/`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ locationId, contactId }) });
    if (createRes.ok) { const d = await createRes.json(); return d.conversation?.id || d.id || null; }
    if (createRes.status === 409) {
      const retryRes = await fetch(`${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=1`, { headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Accept': 'application/json' } });
      if (retryRes.ok) { const d = await retryRes.json(); if (d.conversations?.length > 0) return d.conversations[0].id; }
    }
    return null;
  } catch (e: any) { console.error('[ghl-conv] Error:', e.message); return null; }
}

type InboundResult = { id: string; error: null } | { id: null; error: string };

async function postInboundMessage(token: string, conversationId: string, conversationProviderId: string, message: string, direction: 'inbound' | 'outbound', attachmentUrl?: string | null): Promise<InboundResult> {
  try {
    const type = conversationProviderId === '67b8e49217347407acca7fd1' ? 'SMS' : 'Custom';
    const body: any = { type, conversationId, message: message || '', conversationProviderId, direction };
    if (attachmentUrl) body.attachments = [attachmentUrl];
    console.log(`[inbound] POST body: ${JSON.stringify(body)}`);
    const res = await fetch(`${GHL_BASE}/conversations/messages/inbound`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const responseText = await res.text();
    console.log(`[inbound] Response ${res.status}: ${responseText}`);
    if (!res.ok) { const errDetail = `GHL ${res.status}: ${responseText.substring(0, 400)}`; return { id: null, error: errDetail }; }
    let data: any = {};
    try { data = JSON.parse(responseText); } catch {}
    const msgId = data.messageId || data.id || data.message?.id || data.data?.id;
    if (!msgId) { console.log('[inbound] No messageId in response, using fallback'); return { id: `ghl_${Date.now()}`, error: null }; }
    return { id: msgId, error: null };
  } catch (e: any) { console.error('[inbound] Error:', e.message); return { id: null, error: e.message }; }
}

async function markMessageStatus(token: string, messageId: string, status: string): Promise<boolean> {
  try {
    const res = await fetch(`${GHL_BASE}/conversations/messages/${messageId}/status`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    return res.ok;
  } catch { return false; }
}

async function updateContactPhone(token: string, contactId: string, phone: string): Promise<{ ok: boolean; duplicateContactId?: string }> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: `+${phone}` }) });
    if (res.ok) return { ok: true };
    const txt = await res.text();
    // GHL 400 quando a location nao permite duplicados: meta.contactId traz o contato conflitante.
    let duplicateContactId: string | undefined;
    try {
      const j = JSON.parse(txt);
      if (typeof j?.message === 'string' && j.message.toLowerCase().includes('duplicat') && j?.meta?.contactId) {
        duplicateContactId = j.meta.contactId as string;
      }
    } catch { /* corpo nao-JSON */ }
    console.error(`[upsert] updateContactPhone ${res.status}: ${txt.substring(0, 300)}`);
    return { ok: false, duplicateContactId };
  } catch (e: any) { console.error('[upsert] updateContactPhone error:', e?.message ?? e); return { ok: false }; }
}

// Adiciona tags a um contato no GHL (idempotente — GHL deduplica tags).
async function addContactTags(token: string, contactId: string, tags: string[]): Promise<boolean> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }) });
    if (!res.ok) console.error(`[upsert] addContactTags ${res.status}: ${(await res.text()).substring(0, 200)}`);
    return res.ok;
  } catch (e: any) { console.error('[upsert] addContactTags error:', e?.message ?? e); return false; }
}

async function getGHLContact(token: string, contactId: string): Promise<any | null> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.contact || data || null;
  } catch { return null; }
}

async function updateContactName(token: string, contactId: string, name: string): Promise<boolean> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    return res.ok;
  } catch { return false; }
}

// Teto de tamanho da transcricao. Fala humana corrida da ~15 chars/segundo; com
// o limite de 4 MB de base64 (~3 min de opus) nenhuma transcricao legitima passa
// perto disto. Acima daqui e loop do modelo, nao fala.
const TRANSCRIPTION_MAX_CHARS = 8000;

// Guarda o CRM (e, via AI Agent, o prompt) contra saida degenerada. Os dois
// casos abaixo sao reais, medidos na base em 2026-09-10.
function sanitizeTranscription(raw: string | null, provider: string): string | null {
  let text = (raw || '').trim();
  if (!text) return null;

  // 1) Formato de legenda. O Gemini as vezes devolve WebVTT/SRT em vez de texto
  // corrido ("00:00:00.000 --> 00:00:06.820"). Tira as linhas de tempo e junta.
  if (/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(text)) {
    text = text
      .split('\n')
      .filter((l) => !/-->/.test(l) && !/^\s*\d+\s*$/.test(l) && !/^\s*WEBVTT/i.test(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(`[stt] ${provider}: legenda convertida em texto corrido`);
  }

  // 2) Repeticao patologica: a mesma palavra 15+ vezes seguidas. Corta no ponto
  // onde o loop comeca em vez de descartar tudo — o inicio costuma ser a fala
  // de verdade (foi o caso do audio que virou 163.887 chars de "nao").
  const loop = text.match(/(\b[\p{L}]{1,20}\b)(?:[\s,.!?-]+\1\b){14,}/iu);
  if (loop) {
    const cut = text.slice(0, loop.index ?? 0).trim();
    console.warn(`[stt] ${provider}: loop de "${loop[1]}" detectado, ${text.length} chars cortados para ${cut.length}`);
    text = cut;
  }

  if (text.length > TRANSCRIPTION_MAX_CHARS) {
    console.warn(`[stt] ${provider}: transcricao de ${text.length} chars truncada em ${TRANSCRIPTION_MAX_CHARS}`);
    text = text.slice(0, TRANSCRIPTION_MAX_CHARS).trim() + '…';
  }

  // Sobrou so fragmento depois da limpeza: melhor nenhum texto que um caco.
  return text.length >= 2 ? text : null;
}

// O Groq valida o formato pela EXTENSAO do arquivo enviado, nao pelo mimetype.
function groqFileName(mimeType: string): string {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'audio.mp3';
  if (m.includes('mp4') || m.includes('m4a')) return 'audio.m4a';
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('webm')) return 'audio.webm';
  return 'audio.ogg';
}

async function transcribeWithGroq(base64Audio: string, mimeType: string): Promise<string | null> {
  if (!GROQ_API_KEY) return null;
  try {
    const bytes = base64ToUint8Array(base64Audio);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType || 'audio/ogg' }), groqFileName(mimeType));
    form.append('model', GROQ_MODEL);
    form.append('language', 'pt');
    form.append('prompt', GROQ_PROMPT);
    form.append('response_format', 'json');
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: form,
    });
    if (!res.ok) {
      // 429 aqui e cota do dia estourada: o Gemini assume no fallback.
      console.error(`[stt] groq falhou: ${res.status} ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    return sanitizeTranscription(data?.text ?? null, 'groq');
  } catch (e: any) { console.error('[stt] groq erro:', e.message); return null; }
}

async function transcribeWithGemini(base64Audio: string, mimeType: string, apiKey: string, label: string): Promise<string | null> {
  if (!apiKey) { console.log('[gemini] No API key, skipping transcription'); return null; }
  try {
    console.log(`[gemini] Starting transcription (${label}), base64 size: ${(base64Audio.length / 1024).toFixed(0)}KB`);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ inlineData: { mimeType: mimeType || 'audio/ogg', data: base64Audio } }, { text: 'Transcreva este áudio. Retorne apenas a transcrição, sem comentários.' }] }] }) });
    if (!res.ok) { console.error(`[gemini] Failed (${label}): ${res.status} ${await res.text()}`); return null; }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    console.log(`[gemini] Transcription result: ${text ? text.substring(0, 100) + '...' : 'null'}`);
    return sanitizeTranscription(text, 'gemini');
  } catch (e: any) { console.error('[gemini] Error:', e.message); return null; }
}

async function transcribeAudio(base64Audio: string, mimeType: string): Promise<string | null> {
  const kb = (base64Audio.length / 1024).toFixed(0);
  if (GROQ_API_KEY) {
    const t0 = Date.now();
    const text = await transcribeWithGroq(base64Audio, mimeType);
    if (text) { console.log(`[stt] groq ok em ${Date.now() - t0}ms (${kb}KB, ${text.length} chars)`); return text; }
    console.warn(`[stt] groq sem resultado (${kb}KB), tentando gemini`);
  }
  for (const [label, key] of GEMINI_KEYS) {
    const text = await transcribeWithGemini(base64Audio, mimeType, key, label);
    if (text) return text;
  }
  // Marcador fixo pra alerta/consulta: todos os provedores falharam neste audio.
  console.error(`[stt] ALL_FAILED (${kb}KB) — audio vai sem transcricao`);
  return null;
}

// ---------------------------------------------------------------------------
// v48 (2026-10-14): tipo nao-texto vira texto legivel no GHL (reacao, enquete,
// lista, botao, contato, localizacao...), resposta cita a original, edicao e
// exclusao viram marcador, e a reacao e gravada em message_reactions pro Custom
// JS pintar o badge. Antes, em grupo, tudo isso saia como balao "Nome:" vazio e
// em 1:1 sumia. INBOUND_RENDER_LEGACY=true volta ao comportamento da v47.
// ---------------------------------------------------------------------------
const RENDER_LEGACY = Deno.env.get('INBOUND_RENDER_LEGACY') === 'true';

async function getGHLMessageBody(token: string, messageId: string): Promise<string | null> {
  try {
    const res = await fetch(`${GHL_BASE}/conversations/messages/${encodeURIComponent(messageId)}`, { headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Accept': 'application/json' } });
    if (!res.ok) { console.warn(`[quote] GET message ${messageId}: ${res.status}`); return null; }
    const d = await res.json();
    const body = d?.message?.body ?? d?.body ?? null;
    return typeof body === 'string' && body.trim() ? body : null;
  } catch (e: any) { console.warn('[quote] GET message erro:', e?.message ?? e); return null; }
}

// Trecho da mensagem original (pelo key.id do WhatsApp) pra citar. Ordem:
// messages.preview (gravado desde a v48) -> corpo no GHL -> "uma mensagem".
// messages.evolution_id nao e UNIQUE: maybeSingle() com duas linhas devolve erro, que o chamador
// lia como "nao existe". Pega a linha mais nova, preferindo a que tem preview.
async function pickMessageRow(supabase: SupabaseClient, evolutionId: string, cols: string, conversationId?: number | null): Promise<any | null> {
  let q: any = supabase.from('messages').select(cols).eq('evolution_id', evolutionId);
  if (conversationId) q = q.eq('conversation_id', conversationId);
  const { data: rows, error } = await q.order('id', { ascending: false }).limit(3);
  if (error) { console.warn(`[quote] lookup ${evolutionId} falhou:`, error.message); return null; }
  const lista = (rows ?? []) as any[];
  return lista.find((r) => r.preview) ?? lista[0] ?? null;
}

async function quoteOriginal(supabase: SupabaseClient, token: string, evolutionId: string, conversationId?: number | null): Promise<{ text: string; homioId: string | null }> {
  if (!evolutionId) return { text: 'uma mensagem', homioId: null };
  const row = await pickMessageRow(supabase, evolutionId, 'id, homio_id, preview', conversationId);
  const homioId = (row?.homio_id as string | null) || null;
  if (row?.preview) return { text: snippet(row.preview as string), homioId };
  if (homioId) { const body = await getGHLMessageBody(token, homioId); if (body) return { text: snippet(body), homioId }; }
  return { text: 'uma mensagem', homioId };
}

// Menu em enquete (2026-10-20): voto numa enquete enviada pela ghl-send-message (/enquete), ou numero
// digitado ate 24h depois dela, grava o NUMERO da opcao no campo "Menu escolhido" do contato — e o que o
// workflow do cliente espera. So 1:1 e so contato (fromMe fica de fora). Nunca derruba o inbound.
async function recordMenuChoice(supabase: SupabaseClient, token: string, instanceId: number, conversationId: number, contactId: string, pollId: string | null, votes: string[] | null, typed: string | null): Promise<void> {
  try {
    let poll: any = null;
    let value: string | null = null;
    let source = '';
    if (pollId) {
      if (!votes?.length) return; // voto retirado: mantem a escolha anterior
      const { data } = await supabase.from('polls').select('id, location_id, contact_id, options, field_id').eq('evolution_id', pollId).eq('instance_id', instanceId).order('id', { ascending: false }).limit(1);
      poll = data?.[0] ?? null;
      if (!poll) return; // enquete que nao foi enviada como menu (de terceiro, ou antiga)
      value = voteValue(votes[0], (poll.options ?? []) as PollOption[]);
      source = 'voto';
    } else {
      const n = typedChoice(typed);
      if (!n) return;
      const desde = new Date(Date.now() - MENU_TYPED_WINDOW_MS).toISOString();
      const { data } = await supabase.from('polls').select('id, location_id, contact_id, options, field_id').eq('conversation_id', conversationId).gte('created_at', desde).order('id', { ascending: false }).limit(1);
      poll = data?.[0] ?? null;
      if (!poll) return;
      if (!((poll.options ?? []) as PollOption[]).some((o) => o.value === n)) { console.log(`[menu] digitou ${n}, fora das opcoes da enquete ${poll.id}`); return; }
      value = n;
      source = 'digitado';
    }
    if (!value) { console.warn(`[menu] voto "${votes?.[0]}" nao casou com as opcoes da enquete ${poll.id}`); return; }
    const fieldId = poll.field_id || await ensureMenuField(token, poll.location_id);
    if (!fieldId) { console.warn(`[menu] sem campo "Menu escolhido" na location ${poll.location_id}`); return; }
    const ok = await setMenuField(token, contactId, fieldId, value);
    await supabase.from('polls').update({ answer_value: value, answer_source: source, answered_at: new Date().toISOString() }).eq('id', poll.id);
    console.log(`[menu] contato ${contactId}: Menu escolhido = ${value} (${source}, enquete ${poll.id}) -> ${ok ? 'OK' : 'FALHOU'}`);
  } catch (e: any) { console.warn('[menu] recordMenuChoice erro:', e?.message ?? e); }
}

// Reacao por (mensagem, quem reagiu). Emoji vazio = reacao removida.
async function saveReaction(supabase: SupabaseClient, ghlConversationId: string, ghlMessageId: string, targetEvolutionId: string, senderJid: string, senderName: string, fromMe: boolean, emoji: string): Promise<void> {
  try {
    if (!emoji) {
      await supabase.from('message_reactions').delete().eq('ghl_message_id', ghlMessageId).eq('sender_jid', senderJid);
      return;
    }
    const { error } = await supabase.from('message_reactions').upsert({ ghl_conversation_id: ghlConversationId, ghl_message_id: ghlMessageId, target_evolution_id: targetEvolutionId, sender_jid: senderJid, sender_name: senderName || null, from_me: fromMe, emoji, reacted_at: new Date().toISOString() }, { onConflict: 'ghl_message_id,sender_jid' });
    if (error) console.warn('[reaction] upsert falhou:', error.message);
  } catch (e: any) { console.warn('[reaction] erro:', e?.message ?? e); }
}

// O evento messages.delete nao traz pushName e a Evolution nem sempre tem o contato do participante.
// A ultima mensagem dele neste grupo (ate 7 dias, indice em received_at) tem o pushName.
async function lookupPushName(supabase: SupabaseClient, instanceName: string, remoteJid: string, participants: string[]): Promise<string> {
  for (const p of participants) {
    try {
      const { data } = await supabase.from('webhook_events').select('payload').eq('instance_name', instanceName).eq('event_type', 'messages.upsert')
        .gt('received_at', new Date(Date.now() - 7 * 86400_000).toISOString())
        .eq('payload->data->key->>remoteJid', remoteJid).eq('payload->data->key->>participant', p)
        .order('id', { ascending: false }).limit(1);
      const nome = (data?.[0] as any)?.payload?.data?.pushName;
      if (typeof nome === 'string' && nome.trim()) return nome.trim();
    } catch (e: any) { console.warn('[delete] lookupPushName:', e?.message ?? e); }
  }
  return '';
}

async function resolveGroupSenderName(instanceName: string, pushName: string, participantJid: string, realPhone: string | null, whatsappLid: string | null): Promise<string> {
  if (pushName) return pushName;
  if (participantJid) { const evoName = await getEvolutionContactName(instanceName, participantJid); if (evoName) return evoName; }
  if (realPhone) return realPhone;
  if (whatsappLid) return whatsappLid;
  return 'Desconhecido';
}

async function resolveMentions(instanceName: string, text: string): Promise<string> {
  const mentionPattern = /@(\d{10,})/g;
  const matches = [...text.matchAll(mentionPattern)];
  if (matches.length === 0) return text;
  console.log(`[mentions] Found ${matches.length} mention(s) to resolve`);
  const replacements = await Promise.all(matches.map(async (match) => {
    const lid = match[1];
    const name = await getEvolutionContactName(instanceName, `${lid}@lid`);
    if (name) { console.log(`[mentions] @${lid} -> @${name}`); return { original: match[0], replacement: `@${name}` }; }
    const phoneName = await getEvolutionContactName(instanceName, `${lid}@s.whatsapp.net`);
    if (phoneName) { console.log(`[mentions] @${lid} -> @${phoneName} (via phone)`); return { original: match[0], replacement: `@${phoneName}` }; }
    console.log(`[mentions] @${lid} -> could not resolve, keeping as-is`);
    return null;
  }));
  let result = text;
  for (const r of replacements) { if (r) result = result.replace(r.original, r.replacement); }
  return result;
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405);

  const startTime = Date.now();
  let body: any;
  try { body = await req.json(); } catch { return jsonRes({ error: 'Invalid JSON' }, 400); }

  const event = body.event;
  const instanceName = body.instance;
  const data = body.data;

  if (!event || !instanceName || !data) return jsonRes({ error: 'Missing event, instance, or data' }, 400);

  console.log(`[receive] ${event} from ${instanceName}`);
  const supabase = getSupabase();

  // Reenvio da retry-failed-messages (2026-10-28): reaproveita a linha original em vez de inserir outra.
  // Antes o reenvio gerava hash diferente (o jsonb reordena as chaves), criava um clone, e no 2o reenvio
  // a dedup respondia 200 "duplicate" — a retry contava como sucesso e a mensagem nunca chegava ao GHL
  // (debug_retry_webhook_marca_processed_sem_postar). So vale com a service role: a Evolution nao a tem.
  const retryOf = Number(req.headers.get('x-retry-of') || 0);
  const isServiceCall = (req.headers.get('authorization') || '') === `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}`;
  let eventId: any = null;
  let eventHash = '';
  if (retryOf > 0 && isServiceCall) {
    const { data: orig } = await supabase.from('webhook_events').select('id, status').eq('id', retryOf).maybeSingle();
    if (!orig) return jsonRes({ error: `x-retry-of ${retryOf} nao existe` }, 404);
    if ((orig as any).status === 'processed') return jsonRes({ success: true, skipped: 'already_processed', eventId: retryOf });
    await supabase.from('webhook_events').update({ status: 'processing' }).eq('id', retryOf);
    eventId = retryOf;
    console.log(`[receive] Reenvio do evento ${retryOf} (mesma linha)`);
  } else {
    eventHash = await generateHash(body);
    const { data: savedEvent, error: saveError } = await supabase.from('webhook_events').insert({ event_type: event, payload: body, event_time: body.date_time || new Date().toISOString(), event_hash: eventHash, instance_name: instanceName, status: 'processing', retry_count: 0 }).select('id').single();
    eventId = savedEvent?.id || null;
    if (saveError) {
      if (saveError.code === '23505') { console.log(`[receive] Duplicate event ignored (hash=${eventHash})`); return jsonRes({ success: true, skipped: 'duplicate', eventHash }); }
      console.warn('[receive] Failed to save webhook event:', saveError.message);
    }
  }

  try {
    if (event === 'messages.update') return await handleMessagesUpdate(supabase, instanceName, data, eventId);
    if (event === 'messages.upsert') return await handleMessagesUpsert(supabase, instanceName, body, data, startTime, eventId);
    if (event === 'connection.update') return await handleConnectionUpdate(supabase, instanceName, data, eventId);
    if (event === 'messages.delete') return await handleMessagesDelete(supabase, instanceName, data, eventId);
    if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
    return jsonRes({ success: true, handler: 'ignored', event });
  } catch (error: any) {
    console.error(`[receive] Unhandled error in ${event}:`, error.message, error.stack);
    if (eventId) await supabase.from('webhook_events').update({ status: 'failed', error_message: error.message }).eq('id', eventId);
    return jsonRes({ error: 'Internal error', details: error.message }, 500);
  }
});

async function handleMessagesUpdate(supabase: SupabaseClient, instanceName: string, data: any, eventId: string | null): Promise<Response> {
  const updates = Array.isArray(data) ? data : [data];
  for (const update of updates) {
    try {
      const evolutionId = update?.keyId || update?.key?.id;
      const status = update?.status;
      if (!evolutionId) { console.log('[update] No evolutionId, skip'); continue; }
      if (status !== 'DELIVERY_ACK' && status !== 'READ' && status !== 'PLAYED' && status !== 3 && status !== 4 && status !== 5) { console.log(`[update] Status ${status} not relevant, skip`); continue; }
      const { data: msg } = await supabase.from('messages').select('id, homio_id, conversation_id').eq('evolution_id', evolutionId).maybeSingle();
      if (!msg?.homio_id) { console.log(`[update] ${evolutionId} not found in DB, skip`); continue; }
      const { data: instance } = await supabase.from('instances').select('location_id').eq('evolution_name', instanceName).maybeSingle();
      if (!instance) { console.log(`[update] Instance ${instanceName} not found, skip`); continue; }
      const token = await getGHLToken(supabase, instance.location_id);
      if (!token) { console.log(`[update] No token for ${instance.location_id}, skip`); continue; }
      const ghlStatus = (status === 'READ' || status === 'PLAYED' || status === 4 || status === 5) ? 'read' : 'delivered';
      const ok = await markMessageStatus(token, msg.homio_id, ghlStatus);
      console.log(`[update] ${evolutionId} -> ${ghlStatus}: ${ok ? 'OK' : 'FAILED'}`);
    } catch (e: any) { console.error(`[update] Error processing update:`, e.message); }
  }
  if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
  return jsonRes({ success: true, handler: 'messages.update' });
}

// messages.delete: alguem apagou uma mensagem "para todos". O GHL nao apaga por
// API, entao entra um marcador citando o que foi apagado — so quando a mensagem
// passou por aqui (tem linha em messages); senao nao ha conversa nem trecho.
async function handleMessagesDelete(supabase: SupabaseClient, instanceName: string, data: any, eventId: string | null): Promise<Response> {
  const done = async (extra: Record<string, unknown>) => {
    if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
    return jsonRes({ success: true, handler: 'messages.delete', ...extra });
  };
  if (RENDER_LEGACY) return done({ skipped: 'legacy' });
  const itens = Array.isArray(data) ? data : [data];
  const resultados: unknown[] = [];
  for (const d of itens) {
    const evolutionId = d?.id || d?.key?.id;
    const remoteJid = d?.remoteJid || d?.key?.remoteJid || '';
    const fromMe = d?.fromMe === true || d?.key?.fromMe === true;
    if (!evolutionId) { resultados.push({ skipped: 'no_id' }); continue; }
    const { data: instance } = await supabase.from('instances').select('id, location_id, conversation_provider, name_connected').eq('evolution_name', instanceName).maybeSingle();
    if (!instance) { resultados.push({ evolutionId, skipped: 'no_instance' }); continue; }
    // A mesma mensagem pode ter linha em outra location (grupo com duas instancias): fica com a desta instancia.
    const { data: rows } = await supabase.from('messages').select('id, homio_id, preview, conversation_id').eq('evolution_id', evolutionId).order('id', { ascending: false }).limit(5);
    let msg: any = null, conv: any = null;
    for (const r of (rows ?? []) as any[]) {
      if (!r.conversation_id) continue;
      const { data: c } = await supabase.from('conversations').select('id, homio_id, is_group, instance_id').eq('id', r.conversation_id).maybeSingle();
      if (!c?.homio_id || c.instance_id !== instance.id) continue;
      if (!msg || (r.preview && !msg.preview)) { msg = r; conv = c; }
      if (msg?.preview) break;
    }
    if (!msg || !conv) { resultados.push({ evolutionId, skipped: 'unknown_message' }); continue; }
    const token = await getGHLToken(supabase, instance.location_id as string);
    if (!token) { resultados.push({ evolutionId, skipped: 'no_token' }); continue; }
    let trecho = msg.preview ? snippet(msg.preview as string) : null;
    if (!trecho && msg.homio_id) { const body = await getGHLMessageBody(token, msg.homio_id as string); trecho = body ? snippet(body) : null; }
    let text = `🚫 Apagou a mensagem:\n"${trecho || 'uma mensagem'}"`;
    if (conv.is_group && !fromMe) {
      // O evento de delete nao traz pushName: tenta o LID e o telefone na Evolution, senao o numero.
      const cands: string[] = [d?.participant, d?.key?.participant, d?.participantAlt].filter((x: any) => typeof x === 'string' && x);
      let nome = await lookupPushName(supabase, instanceName, remoteJid, cands);
      for (const c of cands) { if (nome) break; nome = await getEvolutionContactName(instanceName, c); }
      if (!nome) { const tel = cands.find((c) => c.endsWith('@s.whatsapp.net')); nome = tel ? getOnlyNumbers(tel.split('@')[0]) : (cands[0] ? cands[0].split('@')[0] : 'Participante'); }
      text = `${nome}:\n${text}`;
    }
    const r = await postInboundMessage(token, conv.homio_id as string, (instance.conversation_provider as string) || '67b8e49217347407acca7fd1', text, fromMe ? 'outbound' : 'inbound', null);
    console.log(`[delete] ${evolutionId} em ${remoteJid}: ${r.id ? 'marcador postado' : 'falhou ' + r.error}`);
    resultados.push({ evolutionId, posted: !!r.id, error: r.error });
  }
  return done({ resultados });
}

async function handleMessagesUpsert(supabase: SupabaseClient, instanceName: string, fullBody: any, data: any, startTime: number, eventId: string | null): Promise<Response> {
  const key = data.key;
  const message = data.message;
  const pushName = data.pushName || '';
  const messageKeyId = key?.id;
  const remoteJid = key?.remoteJid || '';

  if (!messageKeyId || !remoteJid) return jsonRes({ error: 'Missing key.id or key.remoteJid' }, 400);
  if (remoteJid === 'status@broadcast' || remoteJid.includes('@newsletter')) {
    if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
    return jsonRes({ success: true, handler: 'messages.upsert', skipped: 'broadcast/newsletter' });
  }

  const { data: instance } = await supabase.from('instances').select('*').eq('evolution_name', instanceName).maybeSingle();
  if (!instance) { console.error(`[upsert] Instance ${instanceName} not found`); return jsonRes({ error: 'Instance not found' }, 404); }

  const instanceOwnerJid = fullBody.sender || (instance.number_connected ? `${instance.number_connected}@s.whatsapp.net` : '');

  if (instanceOwnerJid && remoteJid === instanceOwnerJid) {
    console.log(`[upsert] Skipping self-chat message (remoteJid=${remoteJid})`);
    if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
    return jsonRes({ success: true, handler: 'messages.upsert', skipped: 'self_chat' });
  }

  // Camada 2 (2026-10-17): esta key.id ja virou mensagem DESTA instancia? Entao e eco de envio por API
  // (a ghl-send-message grava o evolution_id antes de o webhook chegar) ou reemissao do mesmo evento
  // (a 2.3.7 reemite o upsert na troca de status, com pushName "Voce" — duplicou e inverteu uma
  // mensagem do FOME DE CAO em 14/10). Escopo por instancia: grupo com duas instancias tem a mesma
  // key.id em duas conversas, e cada uma e legitima. Pula ANTES de criar contato/conversa.
  {
    const { data: dupRows } = await supabase.from('messages').select('id, conversation_id').eq('evolution_id', messageKeyId).order('id', { ascending: false }).limit(5);
    const convIds = ((dupRows ?? []) as any[]).map((r) => r.conversation_id).filter(Boolean);
    if (convIds.length) {
      const { data: convRows } = await supabase.from('conversations').select('id').in('id', convIds).eq('instance_id', instance.id).limit(1);
      if (convRows && convRows.length) {
        console.log(`[fromme] duplicate evolution_id ${messageKeyId} em ${instanceName} (conv ${convRows[0].id}) — pulando`);
        await auditFromMe(supabase, { instance_name: instanceName, location_id: instance.location_id, evolution_id: messageKeyId, remote_jid: remoteJid, key_from_me: key?.fromMe === true ? true : (key?.fromMe === false ? false : null), push_name: pushName, name_connected: instance.name_connected, decision: 'skipped', reason: 'duplicate_evolution_id', event_id: eventId, texto: extractMessageText(message) });
        if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
        return jsonRes({ success: true, handler: 'messages.upsert', skipped: 'duplicate_evolution_id', evolutionMessageId: messageKeyId, conversationId: convRows[0].id });
      }
    }
  }

  const phoneInfo = resolvePhoneFromData(data, instanceOwnerJid);
  console.log(`[upsert] ${instanceName} | phone=${phoneInfo.phone} | realPhone=${phoneInfo.realPhone} | lid=${phoneInfo.whatsappLid} | group=${phoneInfo.isGroup} | lidOnly=${phoneInfo.isLidOnly}`);

  // [group-as-lid shadow] LOG-ONLY (nao muda roteamento) — decisao Luan 2026-07-22: suspeita-se
  // que grupo NUNCA chega como @lid no receive; este bloco mede/confirma. Se um inbound classificado
  // como contato individual tiver LID classe-grupo (120363...), sonda os vizinhos +-1 via
  // findGroupInfos e loga o que a RESOLUCAO faria vs o comportamento ATUAL (segue como contato).
  if (!phoneInfo.isGroup && phoneInfo.whatsappLid && isGroupLikeId(phoneInfo.whatsappLid)) {
    console.warn(`[group-as-lid] inbound classe-grupo chegou como @lid: lid=${phoneInfo.whatsappLid} remoteJid=${remoteJid} — ATUAL: trata como contato individual`);
    try {
      const cands = groupJidCandidates(phoneInfo.whatsappLid);
      const shadow: string[] = [];
      for (const c of cands) { const g = await evolutionFindGroup(instanceName, c); if (g) shadow.push(`${c}(subject="${g.subject || g.name || ''}")`); }
      console.warn(`[group-as-lid] SOMBRA resolucao sugerida: candidatos=${cands.join(',')} matches=[${shadow.join(', ')}] (NAO aplicado)`);
    } catch (e: any) { console.error('[group-as-lid] shadow probe error:', e?.message ?? e); }
  }

  // Camadas 1, 3, 4 e 5 (2026-10-17) — ver decideFromMe no topo do arquivo.
  const keyFlag: boolean | null = key?.fromMe === true ? true : (key?.fromMe === false ? false : null);
  const decided = decideFromMe(keyFlag, pushName, instance.name_connected);
  const fromMe = decided.fromMe;
  const auditBase = { instance_name: instanceName, location_id: instance.location_id as string, evolution_id: messageKeyId as string, remote_jid: remoteJid, key_from_me: keyFlag, push_name: pushName, name_connected: instance.name_connected as string | null, name_from_me: decided.nameFromMe, event_id: eventId };
  console.log(`[upsert] fromMe=${fromMe} key=${keyFlag} pushName="${pushName}" name_connected="${instance.name_connected}"${decided.reason ? ' reason=' + decided.reason : ''}`);

  // Camada 1: self-chat via LID. O skip de self_chat acima so compara o JID de telefone; o "Mensagens
  // para mim" chega como <lid>@lid, fromMe=false e pushName do dono (o Baileys nao reconhece o proprio
  // LID como "eu"). Na TSG isso criou o contato fantasma "Adriano" +242314287018230 com 21 mensagens.
  if (!phoneInfo.isGroup && remoteJid.endsWith('@lid') && keyFlag === false && decided.nameFromMe === true) {
    console.log(`[fromme] self-chat via LID (${remoteJid}) em ${instanceName} — pulando`);
    await auditFromMe(supabase, { ...auditBase, decision: 'skipped', reason: 'self_chat_lid', texto: extractMessageText(message) });
    if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
    return jsonRes({ success: true, handler: 'messages.upsert', skipped: 'self_chat_lid' });
  }

  // Camada 4: toda decisao em que os dois criterios nao concordaram (ou so um existia) fica registrada.
  if (decided.reason) await auditFromMe(supabase, { ...auditBase, decision: fromMe ? 'outbound' : 'inbound', reason: decided.reason, texto: extractMessageText(message) });

  // Camada 5: instancia sem name_connected (fetchInstances devolveu profileName vazio na conexao e
  // continua devolvendo). Tenta a Evolution de novo; senao aceita o pushName de mensagem fromMe que ja
  // apareceu em >= 3 chats 1:1 distintos desta instancia (o dono fala com muita gente; um cliente, nao).
  if (!instance.name_connected && keyFlag === true && !PUSHNAME_SEM_VALOR.has(pushName)) {
    let novoNome: string | null = null; let fonte = '';
    const info = await fetchInstanceInfo(instanceName);
    if (info?.profileName) { novoNome = String(info.profileName); fonte = 'fetchInstances.profileName'; }
    else {
      const { data: prev } = await supabase.from('webhook_events').select('rj:payload->data->key->>remoteJid').eq('instance_name', instanceName).eq('event_type', 'messages.upsert').eq('payload->data->key->>fromMe', 'true').eq('payload->data->>pushName', pushName).order('id', { ascending: false }).limit(200);
      const chats = new Set<string>();
      for (const r of ((prev ?? []) as any[])) { const rj = String(r?.rj || ''); if (rj && !rj.endsWith('@g.us')) chats.add(rj); }
      if (chats.size >= 3) { novoNome = pushName; fonte = `pushName fromMe em ${chats.size} chats`; }
      else console.log(`[fromme] ${instanceName} sem name_connected; pushName "${pushName}" visto em ${chats.size} chat(s) fromMe — ainda nao preenche`);
    }
    if (novoNome) {
      const { error: nmErr } = await supabase.from('instances').update({ name_connected: novoNome }).eq('id', instance.id);
      if (nmErr) console.warn('[fromme] update name_connected falhou:', nmErr.message);
      else { instance.name_connected = novoNome; console.log(`[fromme] name_connected preenchido em ${instanceName}: "${novoNome}" (${fonte})`); await auditFromMe(supabase, { ...auditBase, name_connected: novoNome, decision: fromMe ? 'outbound' : 'inbound', reason: 'name_filled', texto: fonte }); }
    }
  }

  const participantJid = key?.participant || data?.participant || '';

  let conversation: any = null;
  let phoneBackfilledFromLid = false;

  if (phoneInfo.isGroup && phoneInfo.groupJid) {
    const { data: rows } = await supabase.from('conversations').select('*').eq('instance_id', instance.id).eq('evo_group_id', phoneInfo.groupJid).limit(1);
    conversation = rows?.[0] || null;
  } else {
    if (phoneInfo.realPhone) {
      const { data: rows } = await supabase.from('conversations').select('*').eq('instance_id', instance.id).eq('phone_number', phoneInfo.realPhone).limit(1);
      conversation = rows?.[0] || null;
      if (conversation && phoneInfo.whatsappLid && !conversation.whatsapp_lid) {
        await supabase.from('conversations').update({ whatsapp_lid: phoneInfo.whatsappLid }).eq('id', conversation.id);
        console.log(`[upsert] Backfilled LID ${phoneInfo.whatsappLid} on conversation ${conversation.id}`);
      }
    }
    if (!conversation && phoneInfo.whatsappLid) {
      const { data: rows } = await supabase.from('conversations').select('*').eq('instance_id', instance.id).eq('whatsapp_lid', phoneInfo.whatsappLid).limit(1);
      conversation = rows?.[0] || null;
      if (conversation && phoneInfo.realPhone && !conversation.phone_number) {
        await supabase.from('conversations').update({ phone_number: phoneInfo.realPhone }).eq('id', conversation.id);
        phoneBackfilledFromLid = true;
        console.log(`[upsert] Backfilled phone ${phoneInfo.realPhone} on conversation ${conversation.id} (found by LID)`);
      }
    }
  }

  const token = await getGHLToken(supabase, instance.location_id);
  if (!token) {
    console.error('[upsert] Failed to get GHL token');
    if (eventId) await supabase.from('webhook_events').update({ status: 'failed', error_message: 'Failed to get GHL token' }).eq('id', eventId);
    return jsonRes({ error: 'Failed to get GHL token' }, 502);
  }

  let contactId = conversation?.contact_id || '';
  let ghlConversationId = conversation?.homio_id || '';
  let resolvedGroupName: string | null = null;

  // Trava de posse ANTES de qualquer chamada ao GHL. Sem ela, duas mensagens do mesmo numero
  // chegando juntas fazem as duas invocacoes criarem/upsertarem o mesmo contato — foi assim que a
  // tag de bloqueio do workflow do cliente foi apagada na Rede C&D (2026-08-07).
  const claimKey = phoneInfo.isGroup
    ? (phoneInfo.groupJid || phoneInfo.phone || '')
    : (phoneInfo.realPhone || phoneInfo.whatsappLid || phoneInfo.phone || '');
  let claimHeld = false;

  if (!conversation && claimKey) {
    claimHeld = await tryClaimContactCreation(supabase, instance.id, claimKey);
    if (!claimHeld) {
      console.log(`[claim] outra invocacao ja esta criando ${claimKey} — esperando`);
      const adotada = await waitForConversation(supabase, instance.id, phoneInfo.realPhone, phoneInfo.whatsappLid);
      if (adotada) {
        conversation = adotada;
        contactId = adotada.contact_id || '';
        ghlConversationId = adotada.homio_id || '';
      }
    }
  }

  try {
  if (!conversation) {
    console.log('[upsert] No existing conversation, creating...');
    const searchPhone = phoneInfo.isGroup ? phoneInfo.phone : (phoneInfo.realPhone || phoneInfo.phone || '');
    console.log(`[upsert] searchPhone=${searchPhone} (isGroup=${phoneInfo.isGroup})`);
    const ghlContact = searchPhone ? await searchContact(token, instance.location_id, searchPhone) : null;
    if (!ghlContact) {
      let name: string;
      if (phoneInfo.isGroup) {
        resolvedGroupName = await getEvolutionName(instanceName, remoteJid, true);
        name = resolvedGroupName || 'Grupo WhatsApp';
      } else if (fromMe) {
        name = await getEvolutionName(instanceName, remoteJid, false) || 'Contato WhatsApp';
      } else {
        name = pushName || await getEvolutionName(instanceName, remoteJid, false) || 'Contato WhatsApp';
      }
      const tags = phoneInfo.isGroup ? ['novo grupo'] : ['novo whatsapp'];
      if (instance.number_connected) tags.push(instance.number_connected);
      const phoneForGHL = searchPhone || `lid_${phoneInfo.whatsappLid || Date.now()}`;
      contactId = await upsertContact(token, instance.location_id, phoneForGHL, name, tags) || '';
      console.log(`[upsert] Created contact: ${contactId}`);
    } else {
      contactId = ghlContact.id;
      console.log(`[upsert] Found existing contact: ${contactId}`);
      // Contato que ja existia no GHL (carga de ERP, outra integracao) nunca ganhava a tag do numero,
      // e workflow do cliente com gatilho "tag adicionada = numero" (atribuir vendedor) nao disparava.
      // So a tag do numero: 'novo whatsapp' continua marcando contato criado por nos. Append idempotente.
      if (instance.number_connected) await addContactTags(token, contactId, [instance.number_connected]);
    }
    if (!contactId) {
      console.error('[upsert] Failed to get/create contact');
      if (eventId) await supabase.from('webhook_events').update({ status: 'failed', error_message: 'Failed to get/create GHL contact' }).eq('id', eventId);
      return jsonRes({ error: 'Failed to get/create GHL contact' }, 502);
    }
    ghlConversationId = await findOrCreateGHLConversation(token, instance.location_id, contactId) || '';
    if (!ghlConversationId) {
      console.error('[upsert] Failed to get/create GHL conversation');
      if (eventId) await supabase.from('webhook_events').update({ status: 'failed', error_message: 'Failed to get/create GHL conversation' }).eq('id', eventId);
      return jsonRes({ error: 'Failed to get/create GHL conversation' }, 502);
    }
    const { data: newConv, error: convErr } = await supabase.from('conversations').insert({ instance_id: instance.id, homio_id: ghlConversationId, phone_number: phoneInfo.dbPhone, contact_id: contactId, whatsapp_lid: phoneInfo.dbLid, is_group: phoneInfo.isGroup, evo_group_id: phoneInfo.groupJid }).select().single();
    if (convErr) {
      if (convErr.code === '23505' || convErr.message?.includes('conversations_homio_id_unique')) {
        console.log(`[upsert] Race condition detected for homio_id=${ghlConversationId}, fetching existing...`);
        const { data: existing } = await supabase.from('conversations').select('*').eq('homio_id', ghlConversationId).single();
        if (existing) { conversation = existing; contactId = existing.contact_id || contactId; }
        // Telefone trocado no contato do GHL (2026-10-28): o inbound do numero novo acha o contato pelo
        // telefone novo e cai na conversa antiga (UNIQUE homio_id). Antes ela era adotada sem atualizar
        // e o DB nunca aprendia o numero novo; agora grava telefone e LID de quem escreveu.
        if (existing && !phoneInfo.isGroup && phoneInfo.realPhone && !samePhone(existing.phone_number, phoneInfo.realPhone)) {
          const { error: upErr } = await supabase.from('conversations').update({ phone_number: phoneInfo.dbPhone, whatsapp_lid: phoneInfo.dbLid }).eq('id', existing.id);
          if (upErr) console.error(`[upsert] Falha ao gravar telefone novo na conversa ${existing.id}: ${upErr.message}`);
          else {
            console.log(`[upsert] Conversa ${existing.id} adotada pelo homio_id: phone_number ${existing.phone_number || '(vazio)'} → ${phoneInfo.dbPhone}, LID ${existing.whatsapp_lid || '-'} → ${phoneInfo.dbLid || '-'}`);
            conversation = { ...existing, phone_number: phoneInfo.dbPhone, whatsapp_lid: phoneInfo.dbLid };
          }
        }
        else { console.error('[upsert] Race condition but could not find existing conversation'); }
      } else { console.error('[upsert] Failed to create conversation:', convErr.message); }
    } else { conversation = newConv; console.log(`[upsert] Created conversation: id=${conversation.id}`); }
  }
  } finally {
    // solta a trava mesmo nos returns de erro acima — senao o proximo inbound do mesmo numero
    // espera 30s ate a claim envelhecer
    if (claimHeld && claimKey) await releaseContactClaim(supabase, instance.id, claimKey);
  }

  const media = detectMedia(message);
  let attachmentUrl: string | null = null;
  let transcription: string | null = null;

  if (media.hasMedia && ghlConversationId) {
    console.log(`[upsert] Media detected: ${media.mediaType} ${media.mimeType} (audio=${media.isAudio})`);
    const mediaData = await getMediaBase64(instanceName, messageKeyId, media.mediaType === 'video');
    if (mediaData?.base64) {
      const base64Size = mediaData.base64.length;
      const approxFileSizeMB = (base64Size * 3 / 4) / (1024 * 1024);
      const uploadPromise = approxFileSizeMB > GHL_MAX_FILE_SIZE_MB
        ? (async () => { const url = await uploadFileToStorage(supabase, mediaData.base64, `Arquivo${media.ext}`, media.mimeType, ghlConversationId); return url; })()
        : (async () => { const url = await uploadFileToGHL(token, instance.location_id, ghlConversationId, mediaData.base64, `Arquivo${media.ext}`, media.mimeType); return url; })();
      // Basta UM provedor configurado. Antes exigia GEMINI_API_KEY: com a chave
      // do Gemini ausente, nem o Groq seria tentado.
      const shouldTranscribe = media.isAudio && (GROQ_API_KEY || GEMINI_KEYS.length > 0) && base64Size < 4_000_000;
      const transcribePromise = shouldTranscribe ? transcribeAudio(mediaData.base64, mediaData.mimetype || media.mimeType) : Promise.resolve(null);
      const [uploadResult, transcriptionResult] = await Promise.allSettled([uploadPromise, transcribePromise]);
      attachmentUrl = uploadResult.status === 'fulfilled' ? uploadResult.value : null;
      transcription = transcriptionResult.status === 'fulfilled' ? transcriptionResult.value : null;
    }
  }

  let messageText = '';
  let preview: string | null = null;
  // Menu em enquete: o que o contato escolheu (voto) ou digitou, pro recordMenuChoice
  let menuPollId: string | null = null;
  let menuVotes: string[] | null = null;
  let menuTyped: string | null = null;
  if (RENDER_LEGACY) {
    messageText = extractMessageText(message);
    if (messageText && /@\d{10,}/.test(messageText)) messageText = await resolveMentions(instanceName, messageText);
    if (phoneInfo.isGroup && !fromMe) {
      const senderName = await resolveGroupSenderName(instanceName, pushName, participantJid, phoneInfo.realPhone, phoneInfo.whatsappLid);
      messageText = `${senderName}:\n${messageText}`;
    }
  } else {
    const rendered = renderMessage(message, data?.messageType);
    if (rendered.kind === 'protocol') {
      console.log(`[render] protocolo ignorado: ${rendered.type}`);
      if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
      return jsonRes({ success: true, handler: 'messages.upsert', skipped: 'protocol', type: rendered.type });
    }
    const keyFromMe = key?.fromMe === true || fromMe;
    const senderJid = keyFromMe ? 'me' : (participantJid || remoteJid);
    // Mesmo nome que vai no prefixo "Nome:" do marcador (pushName), senao o da instancia — o Custom JS casa os dois.
    const senderLabel = pushName || (keyFromMe ? (instance.name_connected || 'Eu') : '');
    if (rendered.kind === 'content') {
      messageText = rendered.text;
      preview = rendered.label || null;
      if (!media.hasMedia) menuTyped = rendered.text;
      if (messageText && /@\d{10,}/.test(messageText)) messageText = await resolveMentions(instanceName, messageText);
      const quote = renderQuote(data?.contextInfo?.quotedMessage);
      if (quote) messageText = messageText ? `${quote}\n${DELIMITADOR}\n${messageText}` : quote;
    } else if (rendered.kind === 'reaction') {
      const orig = await quoteOriginal(supabase, token, rendered.targetId, conversation?.id ?? null);
      if (orig.homioId && ghlConversationId) await saveReaction(supabase, ghlConversationId, orig.homioId, rendered.targetId, senderJid, senderLabel, keyFromMe, rendered.emoji);
      if (!rendered.emoji) {
        if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
        return jsonRes({ success: true, handler: 'messages.upsert', skipped: 'reaction_removed' });
      }
      messageText = `${rendered.emoji} Reagiu a:\n"${orig.text}"`;
      preview = messageText;
    } else if (rendered.kind === 'edit') {
      const orig = await quoteOriginal(supabase, token, rendered.targetId, conversation?.id ?? null);
      messageText = `✏️ Editou a mensagem:\n"${orig.text}"`;
      if (rendered.newText) messageText += `\n${DELIMITADOR}\n${rendered.newText}`;
      preview = rendered.newText ? snippet(rendered.newText) : messageText;
    } else if (rendered.kind === 'revoke') {
      const orig = await quoteOriginal(supabase, token, rendered.targetId, conversation?.id ?? null);
      messageText = `🚫 Apagou a mensagem:\n"${orig.text}"`;
      preview = messageText;
    } else if (rendered.kind === 'poll_vote') {
      menuPollId = rendered.pollId;
      menuVotes = rendered.options;
      const orig = await quoteOriginal(supabase, token, rendered.pollId, conversation?.id ?? null);
      const enquete = orig.text.replace(/^📊 Enquete: /, '');
      messageText = rendered.options.length
        ? `🗳️ Votou em "${rendered.options.join('", "')}"\n📊 Enquete: "${enquete}"`
        : `🗳️ Retirou o voto\n📊 Enquete: "${enquete}"`;
      preview = messageText;
    } else {
      messageText = `⚠️ Mensagem de um tipo ainda não suportado (${rendered.type})`;
      preview = messageText;
      console.warn(`[render] tipo nao suportado: ${rendered.type} (messageType=${data?.messageType})`);
    }
    // Prefixo do remetente em grupo SO quando ha conteudo — era aqui que nascia o "Nome:" vazio.
    if (phoneInfo.isGroup && !fromMe && (messageText || attachmentUrl)) {
      const senderName = await resolveGroupSenderName(instanceName, pushName, participantJid, phoneInfo.realPhone, phoneInfo.whatsappLid);
      messageText = messageText ? `${senderName}:\n${messageText}` : `${senderName}:`;
    }
  }
  if (transcription) preview = snippet(`🎤 ${transcription}`);
  if (transcription) messageText = messageText ? `${messageText}\n\n🎤 *Transcrição:*\n${transcription}` : `🎤 *Transcrição:*\n${transcription}`;
  if (!messageText && !attachmentUrl) {
    if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
    return jsonRes({ success: true, handler: 'messages.upsert', skipped: 'no_content' });
  }

  // Menu em enquete: grava a escolha ANTES de postar no GHL — e o que destrava o workflow do cliente,
  // e nao pode depender do POST do inbound dar certo. So consulta o banco quando ha voto ou numero solto.
  if (!fromMe && !phoneInfo.isGroup && conversation?.id && contactId && (menuPollId || typedChoice(menuTyped))) {
    await recordMenuChoice(supabase, token, instance.id, conversation.id, contactId, menuPollId, menuVotes, menuTyped);
  }

  const direction = fromMe ? 'outbound' : 'inbound';
  const conversationProvider = instance.conversation_provider || '67b8e49217347407acca7fd1';
  let inboundResult = await postInboundMessage(token, ghlConversationId, conversationProvider, messageText, direction, attachmentUrl);

  if (!inboundResult.id) {
    const errDetail = inboundResult.error || 'Failed to post inbound message to GHL';
    const isConvNotFound = errDetail.includes('Conversation not found');

    if (isConvNotFound && conversation && !phoneInfo.isGroup) {
      console.log(`[upsert] Conversation not found/deleted — refreshing contact+conversation for ${phoneInfo.realPhone || phoneInfo.phone}`);
      const searchPhone = phoneInfo.realPhone || phoneInfo.phone;
      let freshContactId: string | null = null;
      const freshContact = searchPhone ? await searchContact(token, instance.location_id, searchPhone) : null;
      if (freshContact) { freshContactId = freshContact.id; console.log(`[upsert] Found fresh contact: ${freshContactId}`); }
      else if (searchPhone) {
        const name = pushName || await getEvolutionName(instanceName, remoteJid, false) || 'Contato WhatsApp';
        const tags = ['novo whatsapp'];
        if (instance.number_connected) tags.push(instance.number_connected);
        freshContactId = await upsertContact(token, instance.location_id, searchPhone, name, tags);
        console.log(`[upsert] Created fresh contact: ${freshContactId}`);
      }
      if (freshContactId) {
        const freshConvId = await findOrCreateGHLConversation(token, instance.location_id, freshContactId);
        if (freshConvId) {
          await supabase.from('conversations').update({ contact_id: freshContactId, homio_id: freshConvId }).eq('id', conversation.id);
          console.log(`[upsert] Refreshed: contact ${contactId} -> ${freshContactId}, conv ${ghlConversationId} -> ${freshConvId}`);
          contactId = freshContactId;
          ghlConversationId = freshConvId;
          inboundResult = await postInboundMessage(token, freshConvId, conversationProvider, messageText, direction, attachmentUrl);
        }
      }
    }

    if (!inboundResult.id) {
      const finalErr = inboundResult.error || 'Failed to post inbound message to GHL';
      console.error(`[upsert] Failed to post message to GHL: ${finalErr}`);
      if (eventId) await supabase.from('webhook_events').update({ status: 'failed', error_message: finalErr }).eq('id', eventId);
      return jsonRes({ error: 'Failed to post message to GHL', detail: finalErr }, 502);
    }
  }

  const homioMsgId = inboundResult.id;

  if (conversation) {
    const { error: msgErr } = await supabase.from('messages').insert({ conversation_id: conversation.id, homio_id: homioMsgId.startsWith('ghl_') ? null : homioMsgId, evolution_id: messageKeyId, preview: preview ? preview.slice(0, 300) : null });
    if (msgErr) console.error('[upsert] Failed to save message:', msgErr.message);
  }

  if (phoneBackfilledFromLid && phoneInfo.realPhone && contactId) {
    const upd = await updateContactPhone(token, contactId, phoneInfo.realPhone);
    if (upd.ok) {
      console.log(`[upsert] Phone backfill to GHL contact ${contactId}: +${phoneInfo.realPhone} -> OK`);
    } else if (upd.duplicateContactId) {
      // Ja existe outro contato (ex: lead do anuncio) com esse telefone. GHL nao expoe endpoint
      // de merge via API; marca ambos com a tag pra merge manual na UI.
      await addContactTags(token, contactId, ['mergear contatos']);
      await addContactTags(token, upd.duplicateContactId, ['mergear contatos']);
      console.log(`[upsert] Phone backfill colidiu: ${contactId} duplica ${upd.duplicateContactId} — ambos tagueados "mergear contatos"`);
    } else {
      console.log(`[upsert] Phone backfill to GHL contact ${contactId}: +${phoneInfo.realPhone} -> FAILED (nao-duplicata)`);
    }
  }

  if (phoneInfo.isGroup && conversation && contactId) {
    if (!resolvedGroupName) resolvedGroupName = await getEvolutionName(instanceName, remoteJid, true);
    if (resolvedGroupName) {
      const ghlContact = await getGHLContact(token, contactId);
      if (ghlContact && ghlContact.name !== resolvedGroupName) {
        const ok = await updateContactName(token, contactId, resolvedGroupName);
        console.log(`[upsert] Group name updated: "${ghlContact.name}" -> "${resolvedGroupName}" -> ${ok ? 'OK' : 'FAILED'}`);
      }
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`[upsert] OK in ${elapsed}ms | ${instanceName} | ${direction} | msgId=${homioMsgId}`);
  if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
  return jsonRes({ success: true, handler: 'messages.upsert', direction, homioMessageId: homioMsgId, evolutionMessageId: messageKeyId, conversationId: conversation?.id, elapsed });
}

async function handleConnectionUpdate(supabase: SupabaseClient, instanceName: string, data: any, eventId: string | null): Promise<Response> {
  const state = data?.state || data?.status || null;
  if (!state) return jsonRes({ success: true, handler: 'connection.update', skipped: 'no_state' });
  const updateData: Record<string, any> = { status: state };
  if (state === 'open') {
    const inst = await fetchInstanceInfo(instanceName);
    if (inst) { if (inst.ownerJid) updateData.number_connected = inst.ownerJid.split('@')[0]; if (inst.profileName) updateData.name_connected = inst.profileName; }
  }
  const { error } = await supabase.from('instances').update(updateData).eq('evolution_name', instanceName);
  if (error) console.error('[conn] DB update error:', error.message);
  console.log(`[conn] ${instanceName} -> ${state}`);
  if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
  return jsonRes({ success: true, handler: 'connection.update', state });
}
