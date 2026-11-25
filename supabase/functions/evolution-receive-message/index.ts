import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCors, jsonRes } from "../_shared/cors.ts";
import { getSupabase, type SupabaseClient } from "../_shared/supabase.ts";
import { getGHLToken, GHL_BASE, GHL_VERSION_V1, GHL_VERSION_V2 } from "../_shared/ghl-auth.ts";
import { resolvePhoneFromData, normalizePhone, getOnlyNumbers } from "../_shared/phone.ts";
import { detectMedia, extractMessageText, base64ToUint8Array } from "../_shared/media.ts";
import { getMediaBase64, getEvolutionName, fetchInstanceInfo, EVOLUTION_API_URL, EVOLUTION_API_KEY } from "../_shared/evolution-api.ts";

// ─── Config ───────────────────────────────────────────────
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const STORAGE_BUCKET = 'whatsapp-media';
const GHL_MAX_FILE_SIZE_MB = 5;

// ─── Helpers ──────────────────────────────────────────────

async function generateHash(data: any): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── GHL Operations ──────────────────────────────────────

async function uploadFileToGHL(token: string, locationId: string, conversationId: string, base64Data: string, fileName: string, mimeType: string): Promise<string | null> {
  try {
    const bytes = base64ToUint8Array(base64Data);
    const formData = new FormData();
    formData.append('fileAttachment', new Blob([bytes], { type: mimeType }), fileName);
    formData.append('conversationId', conversationId);
    formData.append('locationId', locationId);
    const res = await fetch(`${GHL_BASE}/conversations/messages/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1 },
      body: formData,
    });
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

async function searchContact(token: string, locationId: string, phone: string): Promise<any | null> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId, page: 1, pageLimit: 20, filters: [{ field: 'phone', operator: 'contains', value: phone }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.total > 0 && data.contacts?.length > 0) ? data.contacts[0] : null;
  } catch { return null; }
}

async function upsertContact(token: string, locationId: string, phone: string, name: string, tags: string[]): Promise<string | null> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/upsert`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, locationId, phone: `+${phone}`, tags }),
    });
    if (!res.ok) { console.error(`[contact] Upsert failed: ${res.status}`); return null; }
    const data = await res.json();
    return data.contact?.id || null;
  } catch { return null; }
}

async function findOrCreateGHLConversation(token: string, locationId: string, contactId: string): Promise<string | null> {
  try {
    const searchRes = await fetch(
      `${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=1&sort=desc&sortBy=last_message_date`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Accept': 'application/json' } }
    );
    if (searchRes.ok) {
      const d = await searchRes.json();
      if (d.conversations?.length > 0) return d.conversations[0].id;
    }
    const createRes = await fetch(`${GHL_BASE}/conversations/`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId, contactId }),
    });
    if (createRes.ok) { const d = await createRes.json(); return d.conversation?.id || d.id || null; }
    if (createRes.status === 409) {
      const retryRes = await fetch(
        `${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=1`,
        { headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Accept': 'application/json' } }
      );
      if (retryRes.ok) { const d = await retryRes.json(); if (d.conversations?.length > 0) return d.conversations[0].id; }
    }
    return null;
  } catch (e: any) { console.error('[ghl-conv] Error:', e.message); return null; }
}

async function postInboundMessage(
  token: string, conversationId: string, conversationProviderId: string,
  message: string, direction: 'inbound' | 'outbound', attachmentUrl?: string | null
): Promise<string | null> {
  try {
    const type = conversationProviderId === '67b8e49217347407acca7fd1' ? 'SMS' : 'Custom';
    const body: any = { type, conversationId, message: message || '', conversationProviderId, direction };
    if (attachmentUrl) body.attachments = [attachmentUrl];
    console.log(`[inbound] POST body: ${JSON.stringify(body)}`);
    const res = await fetch(`${GHL_BASE}/conversations/messages/inbound`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseText = await res.text();
    console.log(`[inbound] Response ${res.status}: ${responseText}`);
    if (!res.ok) return null;
    let data: any = {};
    try { data = JSON.parse(responseText); } catch { /* non-JSON 200 */ }
    const msgId = data.messageId || data.id || data.message?.id || data.data?.id;
    if (!msgId) { console.log('[inbound] No messageId in response, using fallback'); return `ghl_${Date.now()}`; }
    return msgId;
  } catch (e: any) { console.error('[inbound] Error:', e.message); return null; }
}

async function markMessageStatus(token: string, messageId: string, status: string): Promise<boolean> {
  try {
    const res = await fetch(`${GHL_BASE}/conversations/messages/${messageId}/status`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V1, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    return res.ok;
  } catch { return false; }
}

async function updateContactPhone(token: string, contactId: string, phone: string): Promise<boolean> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: `+${phone}` }),
    });
    return res.ok;
  } catch { return false; }
}

async function getGHLContact(token: string, contactId: string): Promise<any | null> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.contact || data || null;
  } catch { return null; }
}

async function updateContactName(token: string, contactId: string, name: string): Promise<boolean> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return res.ok;
  } catch { return false; }
}

async function transcribeAudio(base64Audio: string, mimeType: string): Promise<string | null> {
  if (!GEMINI_API_KEY) { console.log('[gemini] No API key, skipping transcription'); return null; }
  try {
    console.log(`[gemini] Starting transcription, base64 size: ${(base64Audio.length / 1024).toFixed(0)}KB`);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [
        { inlineData: { mimeType: mimeType || 'audio/ogg', data: base64Audio } },
        { text: 'Transcreva este áudio. Retorne apenas a transcrição, sem comentários.' },
      ] }] }),
    });
    if (!res.ok) { console.error(`[gemini] Failed: ${res.status} ${await res.text()}`); return null; }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    console.log(`[gemini] Transcription result: ${text ? text.substring(0, 100) + '...' : 'null'}`);
    return text;
  } catch (e: any) { console.error('[gemini] Error:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════
// ─── MAIN HANDLER ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

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

  // Save webhook event for tracking/retry
  const eventHash = await generateHash(body);
  const { data: savedEvent, error: saveError } = await supabase
    .from('webhook_events')
    .insert({
      event_type: event,
      payload: body,
      event_time: body.date_time || new Date().toISOString(),
      event_hash: eventHash,
      instance_name: instanceName,
      status: 'processing',
      retry_count: 0,
    })
    .select('id')
    .single();

  const eventId = savedEvent?.id || null;
  if (saveError) console.warn('[receive] Failed to save webhook event:', saveError.message);

  try {
    if (event === 'messages.update') return await handleMessagesUpdate(supabase, instanceName, data, eventId);
    if (event === 'messages.upsert') return await handleMessagesUpsert(supabase, instanceName, body, data, startTime, eventId);
    if (event === 'connection.update') return await handleConnectionUpdate(supabase, instanceName, data, eventId);
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
      if (status !== 'DELIVERY_ACK' && status !== 'READ' && status !== 'PLAYED' && status !== 3 && status !== 4 && status !== 5) {
        console.log(`[update] Status ${status} not relevant, skip`);
        continue;
      }
      const { data: msg } = await supabase.from('messages').select('id, homio_id, conversation_id').eq('evolution_id', evolutionId).maybeSingle();
      if (!msg?.homio_id) { console.log(`[update] ${evolutionId} not found in DB, skip`); continue; }
      const { data: instance } = await supabase.from('instances').select('location_id').eq('evolution_name', instanceName).maybeSingle();
      if (!instance) { console.log(`[update] Instance ${instanceName} not found, skip`); continue; }
      const token = await getGHLToken(supabase, instance.location_id);
      if (!token) { console.log(`[update] No token for ${instance.location_id}, skip`); continue; }
      const ghlStatus = (status === 'READ' || status === 'PLAYED' || status === 4 || status === 5) ? 'read' : 'delivered';
      const ok = await markMessageStatus(token, msg.homio_id, ghlStatus);
      console.log(`[update] ${evolutionId} -> ${ghlStatus}: ${ok ? 'OK' : 'FAILED'}`);
    } catch (e: any) {
      console.error(`[update] Error processing update:`, e.message);
    }
  }
  if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
  return jsonRes({ success: true, handler: 'messages.update' });
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

  // 1. Find instance
  const { data: instance } = await supabase.from('instances').select('*').eq('evolution_name', instanceName).maybeSingle();
  if (!instance) { console.error(`[upsert] Instance ${instanceName} not found`); return jsonRes({ error: 'Instance not found' }, 404); }

  // 2. Build instance owner JID
  const instanceOwnerJid = fullBody.sender || (instance.number_connected ? `${instance.number_connected}@s.whatsapp.net` : '');

  // 2b. Skip self-chat
  if (instanceOwnerJid && remoteJid === instanceOwnerJid) {
    console.log(`[upsert] Skipping self-chat message (remoteJid=${remoteJid})`);
    if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
    return jsonRes({ success: true, handler: 'messages.upsert', skipped: 'self_chat' });
  }

  // 3. Resolve phone
  const phoneInfo = resolvePhoneFromData(data, instanceOwnerJid);
  console.log(`[upsert] ${instanceName} | phone=${phoneInfo.phone} | realPhone=${phoneInfo.realPhone} | lid=${phoneInfo.whatsappLid} | group=${phoneInfo.isGroup} | lidOnly=${phoneInfo.isLidOnly}`);

  // 4. Detect fromMe
  const fromMe = instance.name_connected === pushName;
  console.log(`[upsert] fromMe=${fromMe} pushName="${pushName}" name_connected="${instance.name_connected}"`);

  // 5. Find existing conversation
  let conversation: any = null;
  let phoneBackfilledFromLid = false;

  if (phoneInfo.isGroup && phoneInfo.groupJid) {
    const { data: rows } = await supabase.from('conversations').select('*')
      .eq('instance_id', instance.id).eq('evo_group_id', phoneInfo.groupJid).limit(1);
    conversation = rows?.[0] || null;
  } else {
    if (phoneInfo.realPhone) {
      const { data: rows } = await supabase.from('conversations').select('*')
        .eq('instance_id', instance.id).eq('phone_number', phoneInfo.realPhone).limit(1);
      conversation = rows?.[0] || null;
      if (conversation && phoneInfo.whatsappLid && !conversation.whatsapp_lid) {
        await supabase.from('conversations').update({ whatsapp_lid: phoneInfo.whatsappLid }).eq('id', conversation.id);
        console.log(`[upsert] Backfilled LID ${phoneInfo.whatsappLid} on conversation ${conversation.id}`);
      }
    }
    if (!conversation && phoneInfo.whatsappLid) {
      const { data: rows } = await supabase.from('conversations').select('*')
        .eq('instance_id', instance.id).eq('whatsapp_lid', phoneInfo.whatsappLid).limit(1);
      conversation = rows?.[0] || null;
      if (conversation && phoneInfo.realPhone && !conversation.phone_number) {
        await supabase.from('conversations').update({ phone_number: phoneInfo.realPhone }).eq('id', conversation.id);
        phoneBackfilledFromLid = true;
        console.log(`[upsert] Backfilled phone ${phoneInfo.realPhone} on conversation ${conversation.id} (found by LID)`);
      }
    }
  }

  // 6. Get GHL token
  const token = await getGHLToken(supabase, instance.location_id);
  if (!token) {
    console.error('[upsert] Failed to get GHL token');
    if (eventId) await supabase.from('webhook_events').update({ status: 'failed', error_message: 'Failed to get GHL token' }).eq('id', eventId);
    return jsonRes({ error: 'Failed to get GHL token' }, 502);
  }

  // 7. Create conversation if needed
  let contactId = conversation?.contact_id || '';
  let ghlConversationId = conversation?.homio_id || '';
  let resolvedGroupName: string | null = null;

  if (!conversation) {
    console.log('[upsert] No existing conversation, creating...');
    const searchPhone = phoneInfo.realPhone || phoneInfo.phone || '';
    const ghlContact = searchPhone ? await searchContact(token, instance.location_id, searchPhone) : null;

    if (!ghlContact) {
      let name: string;
      if (phoneInfo.isGroup) {
        resolvedGroupName = await getEvolutionName(instanceName, remoteJid, true);
        name = resolvedGroupName || 'Grupo WhatsApp';
        console.log(`[upsert] Group contact name from Evolution: "${name}"`);
      } else if (fromMe) {
        name = await getEvolutionName(instanceName, remoteJid, false) || 'Contato WhatsApp';
        console.log(`[upsert] fromMe=true, resolved contact name from Evolution: "${name}"`);
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
    }

    if (!contactId) { console.error('[upsert] Failed to get/create contact'); return jsonRes({ error: 'Failed to get/create GHL contact' }, 502); }

    ghlConversationId = await findOrCreateGHLConversation(token, instance.location_id, contactId) || '';
    if (!ghlConversationId) { console.error('[upsert] Failed to get/create GHL conversation'); return jsonRes({ error: 'Failed to get/create GHL conversation' }, 502); }

    const { data: newConv, error: convErr } = await supabase.from('conversations').insert({
      instance_id: instance.id, homio_id: ghlConversationId, phone_number: phoneInfo.dbPhone,
      contact_id: contactId, whatsapp_lid: phoneInfo.dbLid, is_group: phoneInfo.isGroup, evo_group_id: phoneInfo.groupJid,
    }).select().single();
    if (convErr) console.error('[upsert] Failed to create conversation:', convErr.message);
    else { conversation = newConv; console.log(`[upsert] Created conversation: id=${conversation.id}`); }
  }

  // 8. Handle media (upload and transcription in parallel)
  const media = detectMedia(message);
  let attachmentUrl: string | null = null;
  let transcription: string | null = null;

  if (media.hasMedia && ghlConversationId) {
    console.log(`[upsert] Media detected: ${media.mediaType} ${media.mimeType} (audio=${media.isAudio})`);
    const mediaData = await getMediaBase64(instanceName, messageKeyId, media.mediaType === 'video');
    if (mediaData?.base64) {
      const base64Size = mediaData.base64.length;
      const approxFileSizeMB = (base64Size * 3 / 4) / (1024 * 1024);
      console.log(`[upsert] Media base64 size: ${(base64Size / 1024).toFixed(0)}KB (~${approxFileSizeMB.toFixed(1)}MB)`);

      // Determine upload function
      const uploadPromise = approxFileSizeMB > GHL_MAX_FILE_SIZE_MB
        ? (async () => {
            console.log(`[upsert] File too large for GHL (${approxFileSizeMB.toFixed(1)}MB > ${GHL_MAX_FILE_SIZE_MB}MB), uploading to Supabase Storage...`);
            const url = await uploadFileToStorage(supabase, mediaData.base64, `Arquivo${media.ext}`, media.mimeType, ghlConversationId);
            if (url) console.log(`[upsert] Storage upload OK: ${url}`);
            else console.log(`[upsert] Storage upload failed, file will be omitted`);
            return url;
          })()
        : (async () => {
            const url = await uploadFileToGHL(token, instance.location_id, ghlConversationId, mediaData.base64, `Arquivo${media.ext}`, media.mimeType);
            console.log(`[upsert] GHL upload result: ${url ? 'OK' : 'FAILED'}`);
            return url;
          })();

      // Determine transcription
      const shouldTranscribe = media.isAudio && GEMINI_API_KEY && base64Size < 4_000_000;
      if (media.isAudio && base64Size >= 4_000_000) {
        console.log(`[upsert] Audio too large for transcription (${(base64Size / 1024 / 1024).toFixed(1)}MB), skipping`);
      }
      const transcribePromise = shouldTranscribe
        ? transcribeAudio(mediaData.base64, mediaData.mimetype || media.mimeType)
        : Promise.resolve(null);

      // Run upload and transcription in parallel
      const [uploadResult, transcriptionResult] = await Promise.allSettled([
        uploadPromise,
        transcribePromise,
      ]);

      attachmentUrl = uploadResult.status === 'fulfilled' ? uploadResult.value : null;
      if (uploadResult.status === 'rejected') console.error('[upsert] Upload error (non-fatal):', uploadResult.reason?.message || uploadResult.reason);

      transcription = transcriptionResult.status === 'fulfilled' ? transcriptionResult.value : null;
      if (transcriptionResult.status === 'rejected') console.error('[upsert] Transcription error (non-fatal):', transcriptionResult.reason?.message || transcriptionResult.reason);
    }
  }

  // 9. Build message text
  let messageText = extractMessageText(message);
  if (phoneInfo.isGroup && !fromMe && pushName) messageText = `${pushName}:\n${messageText}`;
  if (transcription) {
    messageText = messageText
      ? `${messageText}\n\n\uD83C\uDFA4 *Transcrição:*\n${transcription}`
      : `\uD83C\uDFA4 *Transcrição:*\n${transcription}`;
  }
  if (!messageText && !attachmentUrl) {
    if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
    return jsonRes({ success: true, handler: 'messages.upsert', skipped: 'no_content' });
  }

  // 10. Post to GHL
  const direction = fromMe ? 'outbound' : 'inbound';
  const conversationProvider = instance.conversation_provider || '67b8e49217347407acca7fd1';
  const homioMsgId = await postInboundMessage(token, ghlConversationId, conversationProvider, messageText, direction, attachmentUrl);
  if (!homioMsgId) {
    console.error('[upsert] Failed to post message to GHL');
    if (eventId) await supabase.from('webhook_events').update({ status: 'failed', error_message: 'Failed to post inbound message to GHL' }).eq('id', eventId);
    return jsonRes({ error: 'Failed to post message to GHL' }, 502);
  }

  // 11. Save message
  if (conversation) {
    const { error: msgErr } = await supabase.from('messages').insert({
      conversation_id: conversation.id,
      homio_id: homioMsgId.startsWith('ghl_') ? null : homioMsgId,
      evolution_id: messageKeyId,
    });
    if (msgErr) console.error('[upsert] Failed to save message:', msgErr.message);
  }

  // 12. Phone backfill
  if (phoneBackfilledFromLid && phoneInfo.realPhone && contactId) {
    const ok = await updateContactPhone(token, contactId, phoneInfo.realPhone);
    console.log(`[upsert] Phone backfill to GHL contact ${contactId}: ${phoneInfo.realPhone} → ${ok ? 'OK' : 'FAILED'}`);
  }

  // 13. Group name check
  if (phoneInfo.isGroup && conversation && contactId) {
    if (!resolvedGroupName) resolvedGroupName = await getEvolutionName(instanceName, remoteJid, true);
    if (resolvedGroupName) {
      const ghlContact = await getGHLContact(token, contactId);
      if (ghlContact && ghlContact.name !== resolvedGroupName) {
        const ok = await updateContactName(token, contactId, resolvedGroupName);
        console.log(`[upsert] Group name updated: "${ghlContact.name}" → "${resolvedGroupName}" → ${ok ? 'OK' : 'FAILED'}`);
      } else {
        console.log(`[upsert] Group name already correct: "${resolvedGroupName}"`);
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
    if (inst) {
      if (inst.ownerJid) updateData.number_connected = inst.ownerJid.split('@')[0];
      if (inst.profileName) updateData.name_connected = inst.profileName;
    }
  }

  const { error } = await supabase.from('instances').update(updateData).eq('evolution_name', instanceName);
  if (error) console.error('[conn] DB update error:', error.message);
  console.log(`[conn] ${instanceName} -> ${state}`);
  if (eventId) await supabase.from('webhook_events').update({ status: 'processed' }).eq('id', eventId);
  return jsonRes({ success: true, handler: 'connection.update', state });
}
