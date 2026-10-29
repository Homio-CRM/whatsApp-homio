const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') ?? '';
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') ?? '';

export { EVOLUTION_API_URL, EVOLUTION_API_KEY };

export async function evolutionSendText(instance: string, phone: string, text: string): Promise<any> {
  const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instance}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
    body: JSON.stringify({ number: phone, text }),
  });
  if (!res.ok) throw new Error(`sendText failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function evolutionSendMedia(instance: string, phone: string, mediaType: string, mimeType: string, mediaUrl: string, caption?: string, fileName?: string): Promise<any> {
  const payload: any = { number: phone, mediatype: mediaType, mimetype: mimeType, media: mediaUrl };
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
    body: JSON.stringify({ number: phone, audio: audioUrl }),
  });
  if (!res.ok) throw new Error(`sendAudio failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// Enquete de escolha unica (menu). selectableCount 1 faz o Baileys mandar pollCreationMessageV3; a 2.3.7
// decifra o voto desse formato e entrega o nome da opcao em pollUpdateMessage.vote.selectedOptions.
export async function evolutionSendPoll(instance: string, phone: string, name: string, values: string[]): Promise<any> {
  const res = await fetch(`${EVOLUTION_API_URL}/message/sendPoll/${instance}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
    body: JSON.stringify({ number: phone, name, selectableCount: 1, values }),
  });
  if (!res.ok) throw new Error(`sendPoll failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// Consulta info de um grupo pelo JID @g.us. Retorna o objeto do grupo (com subject/id) se a
// instancia participa dele, ou null. Usado pra CONFIRMAR que um id classe-grupo (120363...)
// e um grupo real ANTES de enderecar o envio — evita mandar pro @lid, que a Evolution aceita
// silenciosamente mas nunca entrega (pegadinha da conv 16252). Nao existe map confiavel
// @lid<->@g.us, entao so entregamos quando o proprio @g.us confirma como grupo participante.
export async function evolutionFindGroup(instance: string, groupJid: string): Promise<any | null> {
  try {
    const res = await fetch(`${EVOLUTION_API_URL}/group/findGroupInfos/${instance}?groupJid=${encodeURIComponent(groupJid)}`, {
      headers: { apikey: EVOLUTION_API_KEY },
    });
    if (!res.ok) { console.warn(`[evo] findGroupInfos ${res.status} for ${groupJid}`); return null; }
    const d = await res.json();
    const g = Array.isArray(d) ? d[0] : d;
    // grupo valido quando a Evolution devolve id/subject; erro/vazio => nao e grupo participante
    if (g && (g.id || g.subject)) return g;
    return null;
  } catch (e: any) { console.error('[evo] findGroupInfos error:', e.message); return null; }
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
