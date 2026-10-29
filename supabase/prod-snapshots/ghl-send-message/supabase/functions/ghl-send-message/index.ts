import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCors, jsonRes } from "../_shared/cors.ts";
import { getSupabase, type SupabaseClient } from "../_shared/supabase.ts";
import { getGHLToken, GHL_BASE, GHL_VERSION_V1, GHL_VERSION_V2 } from "../_shared/ghl-auth.ts";
import { normalizePhone, resolvePhoneForSend, stripBrNine, addBrNine, isGroupLikeId, groupJidCandidates, samePhone, pickByNumber } from "../_shared/phone.ts";
import { detectMediaType } from "../_shared/media.ts";
import { evolutionSendText, evolutionSendMedia, evolutionSendAudio, evolutionFindGroup, evolutionSendPoll } from "../_shared/evolution-api.ts";
import { isPollCommand, parsePollCommand, ensureMenuField, setMenuField, type PollOption } from "../_shared/menu-poll.ts";

// ─── Config ─────────────────────────────────
const DEFAULT_PROVIDER = Deno.env.get('DEFAULT_CONVERSATION_PROVIDER') ?? '67b8e49217347407acca7fd1';

// Kill-switch do LID-first (Step 9): apos a migracao LID do WhatsApp, enderecar contatos
// individuais pelo @lid e o caminho canonico. Setar o secret LID_FIRST_SEND='off' reverte
// pro comportamento phone-first antigo SEM redeploy (pega no proximo cold start). Default: on.
const LID_FIRST_SEND = (Deno.env.get('LID_FIRST_SEND') ?? 'on').toLowerCase() !== 'off';

// Kill-switch da resolucao de GRUPO no envio (feature GHL->grupo). Quando o alvo tem cara de
// grupo/newsletter (120363... / @g.us) e ainda nao ha conversa flagueada como grupo, a function
// confirma via findGroupInfos e endereca por @g.us (unico endereçamento que entrega em grupo),
// em vez de cair no @lid silencioso. GROUP_SEND_RESOLVE='off' desliga sem redeploy. Default: on.
const GROUP_SEND_RESOLVE = (Deno.env.get('GROUP_SEND_RESOLVE') ?? 'on').toLowerCase() !== 'off';

// Resposta antecipada ao GHL (2026-10-22, pedido do Luan depois da demora notada na Imperium): depois de
// resolver instancia, conversa e alvo, a function responde 200 e faz o envio pela Evolution em background
// (EdgeRuntime.waitUntil). O "tique" no GHL aparece ~1-2 s antes e passa a significar "aceito"; a falha
// continua visivel pelo scheduleMarkFailed (status failed), que ja rodava em background. Dedup nao muda:
// a janela entre a checagem e o insert em messages e a mesma de antes. EARLY_RESPONSE='off' volta a
// esperar a Evolution antes de responder, sem redeploy.
const EARLY_RESPONSE = (Deno.env.get('EARLY_RESPONSE') ?? 'on').toLowerCase() !== 'off';

// Cache do nome do usuario GHL usado na assinatura (2026-10-22). Cada envio assinado fazia GET /users/{id}
// no GHL (~0,5 s). Duas camadas: memoria do isolate e a tabela ghl_users_cache. Nome de usuario muda
// raramente; quando mudar, a assinatura acompanha em ate USER_CACHE_TTL_MS (12 h por padrao).
const USER_CACHE_TTL_MS = Number(Deno.env.get('USER_CACHE_TTL_MS') ?? 12 * 60 * 60 * 1000);

// Telefone trocado no contato do GHL (2026-10-28). Com conversa guardada, o envio ia sempre para o
// phone_number/LID gravados e ignorava o telefone que o GHL manda: corrigir o numero do contato nao
// mudava o destino, e se o numero antigo existisse no WhatsApp a mensagem ia para a pessoa errada
// sem erro (provado na Imperium em 22/10). Agora, quando o telefone do GHL e OUTRO numero (nao so
// outra forma do mesmo: DDI, 9 do celular), ele vence: envia para ele, ignora o LID antigo e grava
// o numero novo. Sem volta para o guardado se o novo falhar: a falha aparece no GHL.
// PHONE_FROM_GHL='off' volta ao comportamento DB-first antigo sem redeploy.
const PHONE_FROM_GHL = (Deno.env.get('PHONE_FROM_GHL') ?? 'on').toLowerCase() !== 'off';

interface GHLPayload {
  userId?: string;
  attachments?: string[];
  contactId: string;
  locationId: string;
  messageId: string;
  type?: string;
  conversationId: string;
  phone: string;
  message: string;
  conversationProviderId?: string;
  isGroup?: boolean;
  evoGroupId?: string;
}

interface Instance {
  id: number;
  evolution_name: string;
  evolution_id: string;
  location_id: string;
  display_name: boolean;
  /** texto da assinatura quando display_name: first | full | custom */
  signature_mode: string | null;
  signature_name: string | null;
  number_connected: string | null;
  status: string;
  conversation_provider: string | null;
  instance_api_key: string | null;
}

interface Conversation {
  id: number;
  instance_id: number;
  homio_id: string;
  phone_number: string;
  contact_id: string;
  whatsapp_lid: string | null;
  is_group: boolean;
  evo_group_id: string | null;
}

// ─── Helpers ───────────────────────────────
async function findConversation(supabase: SupabaseClient, contactId: string, instanceId: number): Promise<Conversation | null> {
  const { data } = await supabase.from('conversations').select('*').eq('contact_id', contactId).eq('instance_id', instanceId).limit(1).maybeSingle();
  return data;
}

async function createConversation(supabase: SupabaseClient, conv: any): Promise<Conversation | null> {
  const { data, error } = await supabase.from('conversations').insert(conv).select().single();
  if (error) { console.error('[ghl-send] Failed to create conversation:', JSON.stringify(error)); return null; }
  return data;
}

interface GHLUserNames { name: string | null; firstName: string | null }

// Entrega uma promise ao runtime pra terminar DEPOIS da resposta (EdgeRuntime.waitUntil). Fora do
// edge runtime (teste local) a promise simplesmente segue solta.
function runInBackground(task: Promise<unknown>): void {
  const wu = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof wu === 'function') wu.call((globalThis as any).EdgeRuntime, task);
}

const userMemCache = new Map<string, { user: GHLUserNames; at: number }>();

async function fetchGHLUserFromApi(token: string, userId: string): Promise<GHLUserNames | null> {
  try {
    const res = await fetch(`${GHL_BASE}/users/${userId}`, {
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2 },
    });
    if (!res.ok) { console.warn(`[ghl-send] GET /users/${userId} -> ${res.status}`); return null; }
    const data = await res.json();
    return { name: data.name || null, firstName: data.firstName || null };
  } catch (e: any) { console.warn('[ghl-send] GET /users falhou:', e?.message ?? e); return null; }
}

// Nome do usuario pra assinatura: memoria do isolate -> ghl_users_cache -> GET /users/{id} (e grava nas duas).
// So a ida ao GHL precisa do token; cache vencido ou tabela indisponivel caem na API como antes.
async function getGHLUser(supabase: SupabaseClient, token: string | null, userId: string, locationId: string): Promise<GHLUserNames | null> {
  const key = `${locationId}:${userId}`;
  const now = Date.now();
  const mem = userMemCache.get(key);
  if (mem && now - mem.at < USER_CACHE_TTL_MS) return mem.user;

  try {
    const { data, error } = await supabase.from('ghl_users_cache').select('name, first_name, fetched_at').eq('location_id', locationId).eq('user_id', userId).maybeSingle();
    const row = data as any;
    if (error) console.warn('[ghl-send] ghl_users_cache leitura falhou:', error.message);
    if (row?.fetched_at && now - new Date(row.fetched_at).getTime() < USER_CACHE_TTL_MS) {
      const user: GHLUserNames = { name: row.name || null, firstName: row.first_name || null };
      userMemCache.set(key, { user, at: now });
      return user;
    }
  } catch (e: any) { console.warn('[ghl-send] ghl_users_cache leitura falhou:', e?.message ?? e); }

  if (!token) return null;
  const user = await fetchGHLUserFromApi(token, userId);
  if (!user) return null;
  userMemCache.set(key, { user, at: now });
  // grava em background: o upsert nao segura o envio
  const upsert = Promise.resolve(
    supabase.from('ghl_users_cache')
      .upsert({ location_id: locationId, user_id: userId, name: user.name, first_name: user.firstName, fetched_at: new Date(now).toISOString() } as any, { onConflict: 'location_id,user_id' })
  ).then(({ error }) => { if (error) console.warn('[ghl-send] ghl_users_cache upsert falhou:', error.message); })
   .catch((e: any) => console.warn('[ghl-send] ghl_users_cache upsert falhou:', e?.message ?? e));
  runInBackground(upsert);
  return user;
}

// Texto da assinatura conforme o modo escolhido na pagina de conexao. custom nao depende do usuario;
// first usa o campo firstName do usuario GHL (cai na primeira palavra do nome se vier vazio).
function buildSignature(mode: string, customName: string | null, user: GHLUserNames | null): string | null {
  if (mode === 'custom') return customName?.trim() || null;
  const full = user?.name?.trim() || user?.firstName?.trim() || null;
  if (mode === 'first') return user?.firstName?.trim() || full?.split(/\s+/)[0] || null;
  return full;
}

async function markConversationRead(conversationId: string, locationId: string, token: string): Promise<void> {
  await fetch(`${GHL_BASE}/conversations/${conversationId}`, {
    method: 'PUT',
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId, unreadCount: 0 }),
  });
}

async function logSendError(supabase: SupabaseClient, body: GHLPayload, errorType: string, errorMessage: string, extra: { targetNumber?: string | null; httpStatus?: number | null } = {}): Promise<void> {
  try {
    await supabase.from('send_errors').insert({
      location_id: body.locationId,
      conversation_id: body.conversationId ?? null,
      contact_id: body.contactId ?? null,
      message_id: body.messageId ?? null,
      conversation_provider_id: body.conversationProviderId ?? null,
      phone: body.phone ?? null,
      error_type: errorType,
      error_message: errorMessage,
      http_status: extra.httpStatus ?? null,
      raw_payload: {
        target_number: extra.targetNumber ?? null,
        is_group: body.isGroup ?? false,
        evo_group_id: body.evoGroupId ?? null,
        has_attachments: Array.isArray(body.attachments) && body.attachments.length > 0,
        // guardar as URLs poupa a ida ao GHL quando o anexo e o culpado (ver checkAttachmentUrl)
        attachments: Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : null,
      },
    });
  } catch (e: any) { console.error('[ghl-send] logSendError failed:', e?.message ?? e); }
}

// Classifica o tipo de erro de envio a partir da mensagem da Evolution.
function classifySendError(sendError: string | null, evolutionResult: any): { errorType: string; errorMsg: string; httpStatus: number | null } {
  const errLower = (sendError || '').toLowerCase();
  // Anexo que nao existe mais no storage do GHL. Vem do nosso preflight (checkAttachmentUrl) ou,
  // se o preflight passou e o arquivo sumiu no meio, da propria Evolution: ela devolve 500 com um
  // AxiosError cru do download ("Request failed with status code 404"), que sem esta regra cairia
  // em evolution_error generico.
  const isAttachmentMissing =
    errLower.includes('attachment_not_found') ||
    (/send(media|audio|whatsappaudio) failed/.test(errLower) && /status code (404|403|410)/.test(errLower));
  const isInvalidPhone =
    errLower.includes('does not exist') ||
    errLower.includes('not exist') ||
    errLower.includes('not registered') ||
    errLower.includes('invalid number') ||
    errLower.includes('number not found') ||
    errLower.includes('não existe') ||
    errLower.includes('inexistente') ||
    errLower.includes('no exists') ||
    errLower.includes('whatsapp account does not exist') ||
    errLower.includes('"exists":false') ||
    errLower.includes('"exists": false') ||
    (errLower.includes('phone number') && errLower.includes('(400)'));
  const isDisconnected =
    errLower.includes('connection closed') ||
    errLower.includes('disconnected') ||
    errLower.includes('not connected');
  const errorMsg = isAttachmentMissing
    ? 'O arquivo anexado não está mais disponível — reenvie a imagem/arquivo'
    : isInvalidPhone
    ? 'Número não cadastrado no WhatsApp'
    : isDisconnected || !evolutionResult
    ? 'Verifique sua conexão com o Whats Homio'
    : `Erro ao enviar mensagem: ${sendError}`;
  let httpStatus: number | null = null;
  const statusMatch = (sendError || '').match(/\((\d{3})\)/);
  if (statusMatch) httpStatus = parseInt(statusMatch[1], 10);
  const errorType = isAttachmentMissing
    ? 'attachment_not_found'
    : isInvalidPhone ? 'invalid_phone' : isDisconnected ? 'disconnected' : 'evolution_error';
  return { errorType, errorMsg, httpStatus };
}

function scheduleMarkFailed(supabase: SupabaseClient, body: GHLPayload, errorMessage: string): void {
  // GHL nao finaliza a associacao da mensagem com o provider enquanto o webhook esta aberto;
  // marcar em background depois de responder garante que o PUT /status encontra o provider.
  const task = (async () => {
    await new Promise(r => setTimeout(r, 1500));
    await markMessageFailed(supabase, body, errorMessage);
  })().catch(err => console.error('[ghl-send] scheduleMarkFailed task error:', err));
  const wu = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof wu === 'function') wu.call((globalThis as any).EdgeRuntime, task);
}

async function markMessageFailed(supabase: SupabaseClient, body: GHLPayload, errorMessage: string): Promise<void> {
  try {
    const token = await getGHLToken(supabase, body.locationId);
    if (!token) { console.error('[ghl-send] markMessageFailed: no token'); return; }

    const res = await fetch(`${GHL_BASE}/conversations/messages/${body.messageId}/status`, {
      method: 'PUT',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Version': GHL_VERSION_V1,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status: 'failed',
        error: { code: '1', type: 'SMS', message: errorMessage },
      }),
    });

    if (res.ok) console.log(`[ghl-send] Message ${body.messageId} marked as failed: "${errorMessage}"`);
    else console.error(`[ghl-send] markMessageFailed ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error('[ghl-send] Failed to mark message as failed:', err);
  }
}

// Confere se a URL do anexo ainda existe ANTES de mandar pra Evolution.
// A URL vem do GHL, mas o arquivo pode ter sido apagado/substituido na biblioteca de midia da
// subconta — o storage devolve 404 NoSuchKey e a Evolution, que so descobre na hora de baixar,
// responde 500 com um AxiosError cru. Erro opaco: custou uma investigacao inteira na Rede C&D
// (campanha Mes dos Pais, 125 mensagens perdidas entre 2026-08-05 e 08-07) pra chegar em
// "a imagem nao existe". Com o preflight vira attachment_not_found, com a URL culpada no log.
// So 404/403/410 condenam a URL — falha de rede/timeout deixa passar, pra nao derrubar envio bom.
async function checkAttachmentUrl(url: string): Promise<{ ok: boolean; status?: number }> {
  const isDead = (s: number) => s === 404 || s === 403 || s === 410;
  try {
    let res = await fetch(url, { method: 'HEAD' });
    await res.body?.cancel();
    // CDN que nao aceita HEAD: confirma com um GET de 1 byte antes de condenar a URL
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
      await res.body?.cancel();
    }
    return isDead(res.status) ? { ok: false, status: res.status } : { ok: true, status: res.status };
  } catch (e: any) {
    console.warn(`[ghl-send] preflight do anexo falhou (${e?.message ?? e}) — seguindo com o envio`);
    return { ok: true };
  }
}

// Resultado de uma tentativa de envio do bundle (texto + N anexos) pra um numero alvo.
interface SendOutcome { evolutionResult: any; sendError: string | null; partialErrors: string[]; sentCount: number; }

// Envia o conteudo da mensagem (texto e/ou multiplos anexos) pra um numero alvo.
// Suporta MULTIPLOS anexos numa unica mensagem do GHL (attachments: [url1, url2, ...]).
// Nao loga nada — quem chama decide o que logar com base no resultado FINAL (apos retry).
async function sendBundle(instanceName: string, target: string, attachmentUrls: string[], captionText: string): Promise<SendOutcome> {
  let evolutionResult: any = null;
  let sendError: string | null = null;
  const partialErrors: string[] = [];
  let sentCount = 0;

  try {
    if (attachmentUrls.length > 0) {
      let captionSent = false;
      for (let i = 0; i < attachmentUrls.length; i++) {
        const attachmentUrl = attachmentUrls[i];
        try {
          const check = await checkAttachmentUrl(attachmentUrl);
          if (!check.ok) throw new Error(`attachment_not_found (${check.status}): ${attachmentUrl}`);
          const mediaInfo = await detectMediaType(attachmentUrl);
          console.log(`[ghl-send] Sending media ${i + 1}/${attachmentUrls.length} to ${target}: type=${mediaInfo.extensionType} mime=${mediaInfo.mimetype}`);
          let r: any;
          if (mediaInfo.extensionType === 'audio') {
            r = await evolutionSendAudio(instanceName, target, attachmentUrl);
          } else {
            // legenda vai apenas no primeiro anexo nao-audio, evitando repetir o texto N vezes
            const caption = !captionSent && captionText ? captionText : undefined;
            r = await evolutionSendMedia(instanceName, target, mediaInfo.extensionType, mediaInfo.mimetype, attachmentUrl, caption, `Arquivo.${mediaInfo.ext}`);
            if (caption && r) captionSent = true;
          }
          if (r) { sentCount++; if (!evolutionResult) evolutionResult = r; }
        } catch (err: any) {
          const m = err?.message || 'Unknown send error';
          console.error(`[ghl-send] Attachment ${i + 1}/${attachmentUrls.length} failed:`, m);
          partialErrors.push(m);
        }
      }

      // Se o texto nao foi anexado como legenda (ex: todos os anexos eram audio, ou o primeiro
      // nao-audio falhou) mas algum anexo foi enviado, manda o texto como mensagem separada.
      if (captionText && !captionSent && sentCount > 0) {
        try {
          await evolutionSendText(instanceName, target, captionText);
        } catch (err: any) {
          console.error('[ghl-send] Caption text send failed:', err?.message ?? err);
        }
      }

      if (sentCount === 0) {
        // Nenhum anexo saiu → falha total
        sendError = partialErrors[0] || 'Falha ao enviar anexos';
        evolutionResult = null;
      }
    } else {
      if (captionText) {
        console.log(`[ghl-send] Sending text (${captionText.length} chars) to ${target}`);
        evolutionResult = await evolutionSendText(instanceName, target, captionText);
        if (evolutionResult) sentCount = 1;
      }
    }
  } catch (err: any) {
    sendError = err.message || 'Unknown send error';
    console.error('[ghl-send] Evolution API error:', sendError);
  }

  return { evolutionResult, sendError, partialErrors, sentCount };
}

// Mesmo contrato do sendBundle, pra enquete: o retry de numero do Step 10 serve aos dois.
async function sendPollOutcome(instanceName: string, target: string, question: string, options: PollOption[]): Promise<SendOutcome> {
  try {
    console.log(`[ghl-send] Sending poll (${options.length} opcoes) to ${target}`);
    const r = await evolutionSendPoll(instanceName, target, question, options.map((o) => o.label));
    return { evolutionResult: r, sendError: r ? null : 'sendPoll sem resposta', partialErrors: [], sentCount: r ? 1 : 0 };
  } catch (err: any) {
    const m = err?.message || 'Unknown send error';
    console.error('[ghl-send] Evolution API error (poll):', m);
    return { evolutionResult: null, sendError: m, partialErrors: [], sentCount: 0 };
  }
}

// ─── Main Handler ────────────────────────────
Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405);

  const startTime = Date.now();
  let rawBody: any;
  try { rawBody = await req.json(); } catch { return jsonRes({ error: 'Invalid JSON body' }, 400); }

  const body: GHLPayload = rawBody.body || rawBody;

  console.log(`[ghl-send] Received: locationId=${body.locationId} contactId=${body.contactId} messageId=${body.messageId} phone=${body.phone} isGroup=${body.isGroup} evoGroupId=${body.evoGroupId} conversationProviderId=${body.conversationProviderId || '(none)'}`);

  if (!body.contactId || !body.locationId || !body.messageId || !body.phone) {
    console.error('[ghl-send] Missing required fields:', JSON.stringify({ contactId: body.contactId, locationId: body.locationId, messageId: body.messageId, phone: body.phone }));
    return jsonRes({ error: 'Missing required fields: contactId, locationId, messageId, phone' }, 400);
  }

  const supabase = getSupabase();

  try {
    // Step 2: Parse phone override (#number)
    // 10 a 15 digitos e espaco (ou fim) depois: "#1 primeiro passo" e "#12345678 seu pedido" seguem
    // como texto. Antes /^#(\d+)\s*/ engolia qualquer numero, nao achava instancia e derrubava a mensagem.
    let messageText = body.message || '';
    let phoneOverride: string | null = null;
    const phoneOverrideMatch = messageText.match(/^#\+?(\d{10,15})(\s+|$)/);
    if (phoneOverrideMatch) {
      phoneOverride = phoneOverrideMatch[1];
      messageText = messageText.replace(/^#\+?\d{10,15}(\s+|$)/, '');
      console.log(`[ghl-send] Phone override detected: ${phoneOverride}`);
    }

    // Steps 1 + 3 + 5a em paralelo (2026-10-22): dedup, instancia e token nao dependem um do outro.
    // Em serie custavam ~0,5 s; juntos custam o mais lento deles.
    // Override: lista as instancias da subconta e casa pelo numero tolerando DDI e o 9 (pickByNumber).
    // Antes era igualdade crua com number_connected: "#27988217702" nao achava "5527988217702".
    let instanceQuery = supabase.from('instances').select('*').eq('location_id', body.locationId);
    if (phoneOverride) { /* filtra em JS, abaixo */ }
    else if (body.conversationProviderId) instanceQuery = instanceQuery.eq('conversation_provider', body.conversationProviderId);
    else instanceQuery = instanceQuery.eq('conversation_provider', DEFAULT_PROVIDER);

    const [dedupRes, instanceRes, ghlToken] = await Promise.all([
      supabase.from('messages').select('id').eq('homio_id', body.messageId).maybeSingle(),
      instanceQuery,
      getGHLToken(supabase, body.locationId),
    ]);

    // Step 1: Dedup
    if (dedupRes.data) {
      console.log(`[ghl-send] Duplicate message ${body.messageId}, skipping`);
      return jsonRes({ success: true, message: 'Duplicate message, already processed' });
    }

    // Step 2b: Menu em enquete — texto que comeca com /enquete vira sendPoll (formato em _shared/menu-poll.ts).
    // Sintaxe errada falha VISIVEL no GHL em vez de mandar o texto cru com o marcador pro contato.
    let poll: { question: string; options: PollOption[] } | null = null;
    if (isPollCommand(messageText)) {
      const parsed = parsePollCommand(messageText);
      if (!parsed.ok) {
        console.error(`[ghl-send] Enquete invalida: ${parsed.error}`);
        await logSendError(supabase, body, 'poll_invalid', parsed.error);
        scheduleMarkFailed(supabase, body, `Enquete inválida: ${parsed.error}`);
        return jsonRes({ success: false, handled: true, error: `Enquete inválida: ${parsed.error}` });
      }
      poll = { question: parsed.question, options: parsed.options };
      console.log(`[ghl-send] Enquete detectada: ${poll.options.length} opcoes${body.attachments?.length ? ' (anexos ignorados)' : ''}`);
    }

    // Step 3: Find Evolution instance (consulta disparada junto com dedup e token, acima)
    const { data: instanceRows, error: instanceError } = instanceRes;
    let instances = (instanceRows ?? []) as Instance[];
    if (phoneOverride && !instanceError) {
      const picked = pickByNumber(instances, phoneOverride);
      if (!picked) {
        // Erro proprio do override: o problema e o numero digitado, nao a conexao.
        const conectados = instances.map((i) => i.number_connected).filter(Boolean);
        console.error(`[ghl-send] Override #${phoneOverride} nao casou com instancia da location ${body.locationId}. Numeros da subconta: ${conectados.join(', ') || '(nenhum)'}`);
        await logSendError(supabase, body, 'override_no_match', `Override #${phoneOverride} nao corresponde a nenhum numero desta subconta (${conectados.join(', ') || 'nenhum numero conectado'})`, { targetNumber: phoneOverride });
        scheduleMarkFailed(supabase, body, `O número #${phoneOverride} não está conectado nesta subconta`);
        return jsonRes({ success: false, handled: true, error: 'Override number not found in this location' });
      }
      console.log(`[ghl-send] Override #${phoneOverride} → instance ${picked.evolution_name} (number_connected=${picked.number_connected})`);
      instances = [picked];
    }
    if (instanceError || !instances || instances.length === 0) {
      console.error(`[ghl-send] No instance found for location=${body.locationId} provider=${body.conversationProviderId || DEFAULT_PROVIDER}`);
      await logSendError(supabase, body, 'no_instance', 'No instance found for this location+provider');
      scheduleMarkFailed(supabase, body, 'Verifique sua conexão com o Whats Homio');
      return jsonRes({ success: false, handled: true, error: 'No instance found' });
    }

    const instance: Instance = instances[0];
    console.log(`[ghl-send] Found instance: ${instance.evolution_name} (id=${instance.id}, status=${instance.status})`);

    // Step 4: Check connection
    if (instance.status !== 'open') {
      console.error(`[ghl-send] Instance ${instance.evolution_name} is ${instance.status}`);
      await logSendError(supabase, body, 'instance_disconnected', `Instance ${instance.evolution_name} status=${instance.status}`, { targetNumber: phoneOverride });
      scheduleMarkFailed(supabase, body, phoneOverride
        ? `O número #${phoneOverride} está desconectado do Whats Homio`
        : 'Verifique sua conexão com o Whats Homio');
      return jsonRes({ success: false, handled: true, error: 'WhatsApp instance not connected' });
    }

    // Step 7: Resolve payload phone
    const phoneInfo = resolvePhoneForSend(body.phone, body.isGroup, body.evoGroupId);
    console.log(`[ghl-send] Payload phone resolved: sendTo=${phoneInfo.sendTo} dbPhone=${phoneInfo.dbPhone} dbLid=${phoneInfo.dbLid} groupLike=${phoneInfo.groupLike}`);

    // Step 5: nome do usuario (so quando a assinatura vai usar o nome dele; cache em getGHLUser),
    // em paralelo com a busca da conversa (Step 8) — nenhum depende do outro.
    const signatureMode = instance.signature_mode || 'full';
    const signs = instance.display_name && !!body.userId;
    const [ghlUser, foundConversation] = await Promise.all([
      signs && signatureMode !== 'custom' ? getGHLUser(supabase, ghlToken, body.userId!, body.locationId) : Promise.resolve(null as GHLUserNames | null),
      findConversation(supabase, body.contactId, instance.id),
    ]);

    // Step 6: Prefix message — assinatura so quando o GHL diz qual usuario enviou (userId)
    const signature = signs ? buildSignature(signatureMode, instance.signature_name, ghlUser) : null;
    if (signature && messageText && !poll) {
      messageText = `*${signature}:*\n${messageText}`;
    }

    // Step 8: Find or create conversation
    let conversation = foundConversation;
    if (!conversation && body.conversationId) {
      const { data: byHomioId } = await supabase.from('conversations').select('*').eq('homio_id', body.conversationId).maybeSingle();
      if (byHomioId) {
        conversation = byHomioId;
        console.log(`[ghl-send] Found existing conversation by homio_id: id=${conversation!.id}`);
      }
    }

    // Step 8b: Resolucao de GRUPO (feature GHL->grupo). Quando o alvo tem cara de grupo
    // (120363... / @g.us) e a conversa (se existe) ainda NAO esta flagueada como grupo,
    // confirma via findGroupInfos que e um grupo real que a instancia participa e prepara o
    // envio por @g.us. Se NAO resolver (newsletter, id @lid off-by-one, instancia nao participa),
    // falha VISIVEL em vez de mandar pro @lid silencioso (pegadinha da conv 16252).
    // Contato individual (LID 14-15 digitos) nunca entra aqui — isGroupLikeId => false.
    let resolvedGroupJid: string | null = null;
    const alreadyFlaggedGroup = conversation?.is_group === true && !!conversation?.evo_group_id;
    if (GROUP_SEND_RESOLVE && !alreadyFlaggedGroup && !body.isGroup && phoneInfo.groupLike && phoneInfo.groupJid) {
      // O id que o GHL guarda pode ser a forma @lid do grupo (off-by-one do @g.us real — o contato
      // de um grupo costuma nascer com o id @lid). Testa o exato e os vizinhos +-1 via findGroupInfos
      // e entrega SO num grupo que a instancia CONFIRMADAMENTE participa (verificado, nunca chute
      // cego). Prioriza o exato; senao aceita um unico vizinho. Ambiguidade (2+ reais) => nao resolve.
      const candidates = groupJidCandidates(phoneInfo.groupJid);
      const matches: string[] = [];
      for (const cand of candidates) {
        const grp = await evolutionFindGroup(instance.evolution_name, cand);
        if (grp) { matches.push(cand); console.log(`[ghl-send] Group candidate OK: ${cand} subject="${grp.subject || grp.name || ''}"`); }
      }
      const exact = candidates[0];
      if (matches.includes(exact)) resolvedGroupJid = exact;
      else if (matches.length === 1) resolvedGroupJid = matches[0];

      if (resolvedGroupJid) {
        console.log(`[ghl-send] Group resolved → ${resolvedGroupJid} (de ${phoneInfo.groupJid})`);
      } else {
        console.error(`[ghl-send] id classe-grupo ${phoneInfo.groupJid} nao resolveu (candidatos=${candidates.join(',')} matches=${matches.length}) — falha visivel`);
        await logSendError(supabase, body, 'group_unresolved', `Identificador de grupo ${phoneInfo.groupJid} nao e um grupo valido nesta instancia`, { targetNumber: phoneInfo.groupJid });
        scheduleMarkFailed(supabase, body, 'Número não cadastrado no WhatsApp');
        return jsonRes({ success: false, handled: true, error: 'Group not resolvable' });
      }
    }

    if (!conversation) {
      console.log(`[ghl-send] Creating new conversation for contact=${body.contactId} instance=${instance.id}`);
      conversation = await createConversation(supabase, {
        instance_id: instance.id,
        homio_id: body.conversationId,
        phone_number: resolvedGroupJid ? '' : phoneInfo.dbPhone,
        contact_id: body.contactId,
        whatsapp_lid: resolvedGroupJid ? null : phoneInfo.dbLid,
        is_group: resolvedGroupJid ? true : (body.isGroup || false),
        evo_group_id: resolvedGroupJid || body.evoGroupId || null,
      });
      if (conversation) console.log(`[ghl-send] Conversation created: id=${conversation.id}${resolvedGroupJid ? ' (group)' : ''}`);
      else console.error('[ghl-send] Failed to create conversation');
    } else {
      console.log(`[ghl-send] Found existing conversation: id=${conversation.id} is_group=${conversation.is_group} evo_group_id=${conversation.evo_group_id}`);
      // Cura conversa mis-flagueada como contato-LID quando confirmamos que e grupo real
      if (resolvedGroupJid && !alreadyFlaggedGroup) {
        await supabase.from('conversations').update({ is_group: true, evo_group_id: resolvedGroupJid, whatsapp_lid: null }).eq('id', conversation.id);
        conversation.is_group = true; conversation.evo_group_id = resolvedGroupJid; conversation.whatsapp_lid = null;
        console.log(`[ghl-send] Conversa ${conversation.id} curada como grupo → ${resolvedGroupJid}`);
      }
    }

    // Step 9: Resolve target number — DB-first, LID de contato preferido (com kill-switch)
    let targetNumber: string;
    const dbIsGroup = conversation?.is_group === true || !!resolvedGroupJid || body.isGroup === true;
    const dbGroupId = conversation?.evo_group_id || resolvedGroupJid || body.evoGroupId;

    // LID de CONTATO individual (nao grupo): apos a migracao LID do WhatsApp, o @lid virou o
    // enderecamento canonico — a rede ja resolve os envios pro @lid mesmo quando mandamos o
    // telefone (Baileys traduz phone->LID quando a sessao esta sincronizada). Quando a sessao
    // NAO esta sincronizada (instancia flapando), o envio pro JID de telefone legado
    // (@s.whatsapp.net) da ERROR silencioso (messages.update async, invisivel em send_errors) e a
    // msg nao entrega. Enviar direto pro @lid quando o conhecemos elimina essa dependencia.
    // Guard: identificadores estilo grupo/newsletter (prefixo 120363) NAO sao LID de contato —
    // esse caso ja mordeu antes (conv 16252: @lid de grupo aceito mas nunca entregue).
    // Se falhar como invalid_phone SINCRONO, o retry do Step 10 cai pro telefone (rede de seguranca).
    const rawLid = (conversation?.whatsapp_lid || '').trim();
    const lidDigits = rawLid.replace(/\D/g, '');
    const isContactLid = lidDigits.length > 0 && !lidDigits.startsWith('120363');

    // Step 9a: telefone do contato trocado no GHL (ver PHONE_FROM_GHL). So vale para contato individual
    // com telefone guardado e telefone de verdade no payload (LID e grupo ficam de fora).
    const storedPhone = (conversation?.phone_number || '').replace(/\D/g, '');
    const ghlPhone = (phoneInfo.dbPhone || '').replace(/\D/g, '');
    const phoneChanged = PHONE_FROM_GHL && !!conversation && !dbIsGroup && !phoneInfo.groupLike && !phoneInfo.dbLid
      && storedPhone.length > 5 && ghlPhone.length >= 10 && !samePhone(storedPhone, ghlPhone);

    if (dbIsGroup && dbGroupId) {
      targetNumber = dbGroupId;
      console.log(`[ghl-send] Target: group → ${targetNumber}`);
    } else if (phoneChanged) {
      targetNumber = phoneInfo.sendTo;
      console.log(`[ghl-send] Telefone do contato mudou no GHL: guardado=${storedPhone} lid=${rawLid || '-'} → GHL=${targetNumber}. Target: GHL phone`);
    } else if (!dbIsGroup && isContactLid && LID_FIRST_SEND) {
      targetNumber = rawLid.includes('@') ? rawLid : `${lidDigits}@lid`;
      console.log(`[ghl-send] Target: contact LID → ${targetNumber}`);
    } else {
      const dbPhone = conversation?.phone_number || '';
      const dbLid = conversation?.whatsapp_lid || '';
      if (dbPhone && dbPhone.length > 5) {
        targetNumber = normalizePhone(dbPhone.replace(/\D/g, ''));
        console.log(`[ghl-send] Target: db phone → ${targetNumber}`);
      } else if (dbLid) {
        targetNumber = dbLid.includes('@') ? dbLid : `${dbLid}@lid`;
        console.log(`[ghl-send] Target: db LID → ${targetNumber}`);
      } else {
        targetNumber = phoneInfo.sendTo;
        console.log(`[ghl-send] Target: payload fallback → ${targetNumber}`);
      }
    }

    // Step 10: Send via Evolution API (com retry de recuperacao de numero pro caso de DB corrompido)
    const attachmentUrls = (body.attachments || []).filter(a => a && (a.startsWith('https://') || a.startsWith('http://')));
    const captionText = messageText && messageText.trim() ? messageText : '';

    // Steps 9b-13 (2026-10-22): envio pela Evolution e pos-envio numa funcao so. Com EARLY_RESPONSE
    // ligado ela roda em background e o GHL recebe 200 agora (ver constante no topo).
    const finishSend = async (): Promise<Response> => {
      // Step 9b: enquete — zera "Menu escolhido" ANTES de enviar, pra o Wait do workflow esperar ESTA resposta
      // (um voto rapido nao pode ser apagado por um PUT atrasado). Falha aqui nao impede o envio.
      let menuFieldId: string | null = null;
      if (poll && !dbIsGroup && ghlToken) {
        menuFieldId = await ensureMenuField(ghlToken, body.locationId);
        if (menuFieldId && !(await setMenuField(ghlToken, body.contactId, menuFieldId, ''))) {
          console.warn(`[ghl-send] nao zerou "Menu escolhido" do contato ${body.contactId} — segue o envio`);
        }
      }
      const sendContent = (target: string) => poll
        ? sendPollOutcome(instance.evolution_name, target, poll.question, poll.options)
        : sendBundle(instance.evolution_name, target, attachmentUrls, captionText);

      let outcome = await sendContent(targetNumber);

      // Retry de recuperacao: se NENHUM conteudo saiu por numero inexistente, o alvo (resolvido
      // DB-first) pode estar com a forma errada — tipicamente um celular cujo 9 foi removido por
      // engano e ficou gravado sem o 9 no phone_number (corrupcao do strip antigo, ate 2026-06-16),
      // ou um fixo com 9 colado. Tenta candidatos alternativos, em ordem, e cura o DB no primeiro
      // que o WhatsApp aceitar. So age apos a falha do alvo principal e so persiste com envio
      // confirmado — seguro pra fixo real (a tentativa errada simplesmente falha e nao cura).
      if (outcome.sentCount === 0 && !dbIsGroup) {
        const cls = classifySendError(outcome.sendError, outcome.evolutionResult);
        if (cls.errorType === 'invalid_phone') {
          // contato comprovadamente no WhatsApp (nasceu de inbound) -> e celular, nao fixo sem WA
          const hasWaPresence = !phoneChanged && !!(conversation?.whatsapp_lid);
          const candidates: string[] = [];
          // 1) numero que o GHL mandou (fonte canonica do contato) — cobre DB corrompido sem adivinhar
          if (phoneInfo.sendTo && !phoneInfo.sendTo.includes('@') && phoneInfo.sendTo !== targetNumber) {
            candidates.push(phoneInfo.sendTo);
          }
          // 2) adicionar o 9 (celular cujo 9 foi removido por engano no DB) — SO quando ha presenca
          //    no WhatsApp (whatsapp_lid). Sem esse guard, um fixo real sem WA viraria o celular
          //    equivalente (de outra pessoa) -> risco de mis-delivery + cura errada do DB.
          if (hasWaPresence) {
            const added = addBrNine(targetNumber);
            if (added && !candidates.includes(added)) candidates.push(added);
          }
          // 3) remover o 9 (fixo cadastrado com 9 colado errado)
          const stripped = stripBrNine(targetNumber);
          if (stripped && !candidates.includes(stripped)) candidates.push(stripped);

          for (const cand of candidates) {
            console.log(`[ghl-send] invalid_phone em ${targetNumber} — retry com ${cand}`);
            const retry = await sendContent(cand);
            if (retry.sentCount > 0) {
              outcome = retry;
              targetNumber = cand;
              // o WhatsApp aceitou esse numero: cura o phone_number do DB pra forma canonica
              if (conversation && conversation.phone_number !== cand) {
                await supabase.from('conversations').update({ phone_number: cand }).eq('id', conversation.id);
                console.log(`[ghl-send] Conversa ${conversation.id} curada: phone_number → ${cand}`);
              }
              break;
            }
          }
        }
      }

      // Step 10b: o numero do GHL entregou -> passa a ser o da conversa; o LID era da conta antiga
      if (phoneChanged && outcome.sentCount > 0 && conversation) {
        const novo = targetNumber.replace(/\D/g, '');
        const { error: upErr } = await supabase.from('conversations').update({ phone_number: novo, whatsapp_lid: null }).eq('id', conversation.id);
        if (upErr) console.error(`[ghl-send] Falha ao gravar telefone novo na conversa ${conversation.id}: ${upErr.message}`);
        else console.log(`[ghl-send] Conversa ${conversation.id}: phone_number ${storedPhone} → ${novo} (telefone do GHL), LID antigo limpo`);
      }

      const { evolutionResult, sendError, partialErrors, sentCount } = outcome;

      // Sucesso parcial (multiplos anexos): loga os que falharam mas considera enviado
      if (sentCount > 0 && partialErrors.length > 0) {
        console.warn(`[ghl-send] Partial send: ${sentCount}/${attachmentUrls.length} ok, ${partialErrors.length} failed`);
        for (const m of partialErrors) {
          const c = classifySendError(m, true);
          await logSendError(supabase, body, c.errorType, m, { targetNumber, httpStatus: c.httpStatus });
        }
      }

      // Step 11: Handle failure (nenhum conteudo saiu)
      if (sentCount === 0 || sendError || !evolutionResult) {
        const { errorType, errorMsg, httpStatus } = classifySendError(sendError, evolutionResult);
        console.error(`[ghl-send] Send failed — type=${errorType} msg="${errorMsg}"`);
        const nota = phoneChanged ? ` [telefone trocado no GHL: guardado ${storedPhone} nao usado]` : '';
        await logSendError(supabase, body, errorType, (sendError || errorMsg) + nota, { targetNumber, httpStatus });
        scheduleMarkFailed(supabase, body, errorMsg);
        return jsonRes({ success: false, handled: true, error: errorMsg });
      }

      // Step 12: Save message
      const evolutionId = evolutionResult?.key?.id || `evo_${Date.now()}`;
      if (conversation) {
        const { error: msgError } = await supabase.from('messages').insert({
          conversation_id: conversation.id,
          homio_id: body.messageId,
          evolution_id: evolutionId,
          // a evolution-receive-message cita este preview no voto ("📊 Enquete: ..."), em vez do texto cru com /enquete
          ...(poll ? { preview: `📊 Enquete: ${poll.question}`.slice(0, 300) } : {}),
        });
        if (msgError) console.error('[ghl-send] Failed to save message:', JSON.stringify(msgError));
        else console.log(`[ghl-send] Message saved: homio_id=${body.messageId} evolution_id=${evolutionId}`);
      }

      // Step 12b: enquete — registro que a evolution-receive-message usa pra traduzir voto/numero em "Menu escolhido"
      if (poll) {
        const { error: pollError } = await supabase.from('polls').insert({
          instance_id: instance.id,
          conversation_id: conversation?.id ?? null,
          location_id: body.locationId,
          contact_id: body.contactId,
          evolution_id: evolutionId,
          homio_message_id: body.messageId,
          question: poll.question,
          options: poll.options,
          field_id: menuFieldId,
          is_group: dbIsGroup,
        });
        if (pollError) console.error('[ghl-send] Failed to save poll:', JSON.stringify(pollError));
        else console.log(`[ghl-send] Poll saved: evolution_id=${evolutionId} field=${menuFieldId ?? '(sem campo)'}`);
      }

      // Step 13: Mark conversation read
      if (ghlToken && body.conversationId) {
        runInBackground(markConversationRead(body.conversationId, body.locationId, ghlToken).catch(err =>
          console.error('[ghl-send] Failed to mark conversation read:', err)
        ));
      }

      const elapsed = Date.now() - startTime;
      console.log(`[ghl-send] OK in ${elapsed}ms | instance=${instance.evolution_name} | to=${targetNumber} | msgId=${body.messageId}`);
      return jsonRes({ success: true, evolutionMessageId: evolutionId, conversationId: conversation?.id, elapsed });
    };

    if (!EARLY_RESPONSE) return await finishSend();

    runInBackground(finishSend().catch(async (error: any) => {
      console.error('[ghl-send] Unhandled error (background):', error?.message, error?.stack);
      await logSendError(supabase, body, 'unhandled_exception', error?.message ?? 'Unknown error');
      scheduleMarkFailed(supabase, body, 'Erro interno ao processar a mensagem');
    }));
    const accepted = Date.now() - startTime;
    console.log(`[ghl-send] Accepted in ${accepted}ms (envio em background) | instance=${instance.evolution_name} | to=${targetNumber} | msgId=${body.messageId}`);
    return jsonRes({ success: true, accepted: true, conversationId: conversation?.id, elapsed: accepted });

  } catch (error: any) {
    console.error('[ghl-send] Unhandled error:', error.message, error.stack);
    await logSendError(supabase, body, 'unhandled_exception', error?.message ?? 'Unknown error');
    scheduleMarkFailed(supabase, body, 'Erro interno ao processar a mensagem');
    return jsonRes({ success: false, handled: true, error: 'Erro interno ao processar a mensagem' });
  }
});
