const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') ?? '';
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') ?? '';

export { EVOLUTION_API_URL, EVOLUTION_API_KEY };

export async function evolutionSendText(instance: string, phone: string, text: string): Promise<any> {
  const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instance}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
    body: JSON.stringify({ number: phone, text, delay: 1200 }),
  });
  if (!res.ok) throw new Error(`sendText failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function evolutionSendMedia(instance: string, phone: string, mediaType: string, mimeType: string, mediaUrl: string, caption?: string, fileName?: string): Promise<any> {
  const payload: any = { number: phone, mediatype: mediaType, mimetype: mimeType, media: mediaUrl, delay: 1200 };
  if (caption) payload.caption = caption;
  if (fileName) payload.fileName = fileName;
  const res = await fetch(`${EVOLUTION_API_URL}/message/sendMedia/${instance}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`sendMedia failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function evolutionSendAudio(instance: string, phone: string, audioUrl: string): Promise<any> {
  const res = await fetch(`${EVOLUTION_API_URL}/message/sendWhatsAppAudio/${instance}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
    body: JSON.stringify({ number: phone, audio: audioUrl, delay: 1200 }),
  });
  if (!res.ok) throw new Error(`sendAudio failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function getMediaBase64(instanceName: string, messageKeyId: string, isVideo: boolean): Promise<{ base64: string; mimetype: string } | null> {
  try {
    const res = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${instanceName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ message: { key: { id: messageKeyId } }, convertToMp4: isVideo }),
    });
    if (!res.ok) { console.error(`[media] getBase64 failed: ${res.status}`); return null; }
    const data = await res.json();
    return { base64: data.base64, mimetype: data.mimetype };
  } catch (e: any) { console.error('[media] error:', e.message); return null; }
}

export async function getEvolutionName(instanceName: string, remoteJid: string, isGroup: boolean): Promise<string> {
  try {
    if (isGroup) {
      const res = await fetch(`${EVOLUTION_API_URL}/group/findGroupInfos/${instanceName}?groupJid=${encodeURIComponent(remoteJid)}`, { headers: { apikey: EVOLUTION_API_KEY } });
      if (res.ok) { const d = await res.json(); return d.subject || d.name || 'Grupo WhatsApp'; }
    } else {
      const res = await fetch(`${EVOLUTION_API_URL}/chat/findContacts/${instanceName}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ where: { remoteJid } }),
      });
      if (res.ok) { const d = await res.json(); const c = Array.isArray(d) ? d[0] : d; return c?.name || c?.verifiedName || c?.notify || c?.pushName || ''; }
    }
  } catch (e: any) { console.error('[evo-name] Error:', e.message); }
  return '';
}

export async function fetchInstanceInfo(instanceName: string): Promise<any | null> {
  try {
    const res = await fetch(`${EVOLUTION_API_URL}/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`, { headers: { apikey: EVOLUTION_API_KEY } });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  } catch (e: any) { console.error('[evo] fetchInstanceInfo error:', e.message); return null; }
}
