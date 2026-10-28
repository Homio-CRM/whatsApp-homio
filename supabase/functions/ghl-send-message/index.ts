import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCors, jsonRes } from "../_shared/cors.ts";
import { getSupabase, type SupabaseClient } from "../_shared/supabase.ts";
import { getGHLToken, GHL_BASE, GHL_VERSION_V1, GHL_VERSION_V2 } from "../_shared/ghl-auth.ts";
import { normalizePhone, resolvePhoneForSend, stripBrNine, addBrNine } from "../_shared/phone.ts";
import { detectMediaType } from "../_shared/media.ts";
import { evolutionSendText, evolutionSendMedia, evolutionSendAudio } from "../_shared/evolution-api.ts";

// ─── Config ─────────────────────────────────
const DEFAULT_PROVIDER = Deno.env.get('DEFAULT_CONVERSATION_PROVIDER') ?? '67b8e49217347407acca7fd1';

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

async function getGHLUserName(supabase: SupabaseClient, userId: string, locationId: string): Promise<string | null> {
  try {
    const token = await getGHLToken(supabase, locationId);
    if (!token) return null;
    const res = await fetch(`${GHL_BASE}/users/${userId}`, {
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2 },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.name || data.firstName || null;
  } catch { return null; }
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
      },
    });
  } catch (e: any) { console.error('[ghl-send] logSendError failed:', e?.message ?? e); }
}

// Classifica o tipo de erro de envio a partir da mensagem da Evolution.
function classifySendError(sendError: string | null, evolutionResult: any): { errorType: string; errorMsg: string; httpStatus: number | null } {
  const errLower = (sendError || '').toLowerCase();
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
  const errorMsg = isInvalidPhone
    ? 'Número não cadastrado no WhatsApp'
    : isDisconnected || !evolutionResult
    ? 'Verifique sua conexão com o Whats Homio'
    : `Erro ao enviar mensagem: ${sendError}`;
  let httpStatus: number | null = null;
  const statusMatch = (sendError || '').match(/\((\d{3})\)/);
  if (statusMatch) httpStatus = parseInt(statusMatch[1], 10);
  const errorType = isInvalidPhone ? 'invalid_phone' : isDisconnected ? 'disconnected' : 'evolution_error';
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
    // Step 1: Dedup
    const { data: existingMsg } = await supabase.from('messages').select('id').eq('homio_id', body.messageId).maybeSingle();
    if (existingMsg) {
      console.log(`[ghl-send] Duplicate message ${body.messageId}, skipping`);
      return jsonRes({ success: true, message: 'Duplicate message, already processed' });
    }

    // Step 2: Parse phone override (#number)
    let messageText = body.message || '';
    let phoneOverride: string | null = null;
    const phoneOverrideMatch = messageText.match(/^#(\d+)\s*/);
    if (phoneOverrideMatch) {
      phoneOverride = phoneOverrideMatch[1];
      messageText = messageText.replace(/^#\d+\s*/, '');
      console.log(`[ghl-send] Phone override detected: ${phoneOverride}`);
    }

    // Step 3: Find Evolution instance
    let instanceQuery = supabase.from('instances').select('*').eq('location_id', body.locationId);
    if (phoneOverride) instanceQuery = instanceQuery.eq('number_connected', phoneOverride);
    else if (body.conversationProviderId) instanceQuery = instanceQuery.eq('conversation_provider', body.conversationProviderId);
    else instanceQuery = instanceQuery.eq('conversation_provider', DEFAULT_PROVIDER);

    const { data: instances, error: instanceError } = await instanceQuery;
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
      await logSendError(supabase, body, 'instance_disconnected', `Instance ${instance.evolution_name} status=${instance.status}`);
      scheduleMarkFailed(supabase, body, 'Verifique sua conexão com o Whats Homio');
      return jsonRes({ success: false, handled: true, error: 'WhatsApp instance not connected' });
    }

    // Step 5: GHL token + user name
    const [ghlToken, userName] = await Promise.all([
      getGHLToken(supabase, body.locationId),
      body.userId ? getGHLUserName(supabase, body.userId, body.locationId) : Promise.resolve(null)
    ]);

    // Step 6: Prefix message
    if (instance.display_name && userName && messageText) {
      messageText = `*${userName}:*\n${messageText}`;
    }

    // Step 7: Resolve payload phone
    const phoneInfo = resolvePhoneForSend(body.phone, body.isGroup, body.evoGroupId);
    console.log(`[ghl-send] Payload phone resolved: sendTo=${phoneInfo.sendTo} dbPhone=${phoneInfo.dbPhone} dbLid=${phoneInfo.dbLid}`);

    // Step 8: Find or create conversation
    let conversation = await findConversation(supabase, body.contactId, instance.id);
    if (!conversation && body.conversationId) {
      const { data: byHomioId } = await supabase.from('conversations').select('*').eq('homio_id', body.conversationId).maybeSingle();
      if (byHomioId) {
        conversation = byHomioId;
        console.log(`[ghl-send] Found existing conversation by homio_id: id=${conversation!.id}`);
      }
    }
    if (!conversation) {
      console.log(`[ghl-send] Creating new conversation for contact=${body.contactId} instance=${instance.id}`);
      conversation = await createConversation(supabase, {
        instance_id: instance.id,
        homio_id: body.conversationId,
        phone_number: phoneInfo.dbPhone,
        contact_id: body.contactId,
        whatsapp_lid: phoneInfo.dbLid,
        is_group: body.isGroup || false,
        evo_group_id: body.evoGroupId || null,
      });
      if (conversation) console.log(`[ghl-send] Conversation created: id=${conversation.id}`);
      else console.error('[ghl-send] Failed to create conversation');
    } else {
      console.log(`[ghl-send] Found existing conversation: id=${conversation.id} is_group=${conversation.is_group} evo_group_id=${conversation.evo_group_id}`);
    }

    // Step 9: Resolve target number — DB-first
    let targetNumber: string;
    const dbIsGroup = conversation?.is_group === true || body.isGroup === true;
    const dbGroupId = conversation?.evo_group_id || body.evoGroupId;

    if (dbIsGroup && dbGroupId) {
      targetNumber = dbGroupId;
      console.log(`[ghl-send] Target: group → ${targetNumber}`);
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

    let outcome = await sendBundle(instance.evolution_name, targetNumber, attachmentUrls, captionText);

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
        const hasWaPresence = !!(conversation?.whatsapp_lid);
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
          const retry = await sendBundle(instance.evolution_name, cand, attachmentUrls, captionText);
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
      await logSendError(supabase, body, errorType, sendError || errorMsg, { targetNumber, httpStatus });
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
      });
      if (msgError) console.error('[ghl-send] Failed to save message:', JSON.stringify(msgError));
      else console.log(`[ghl-send] Message saved: homio_id=${body.messageId} evolution_id=${evolutionId}`);
    }

    // Step 13: Mark conversation read
    if (ghlToken && body.conversationId) {
      markConversationRead(body.conversationId, body.locationId, ghlToken).catch(err =>
        console.error('[ghl-send] Failed to mark conversation read:', err)
      );
    }

    const elapsed = Date.now() - startTime;
    console.log(`[ghl-send] OK in ${elapsed}ms | instance=${instance.evolution_name} | to=${targetNumber} | msgId=${body.messageId}`);
    return jsonRes({ success: true, evolutionMessageId: evolutionId, conversationId: conversation?.id, elapsed });

  } catch (error: any) {
    console.error('[ghl-send] Unhandled error:', error.message, error.stack);
    await logSendError(supabase, body, 'unhandled_exception', error?.message ?? 'Unknown error');
    scheduleMarkFailed(supabase, body, 'Erro interno ao processar a mensagem');
    return jsonRes({ success: false, handled: true, error: 'Erro interno ao processar a mensagem' });
  }
});
