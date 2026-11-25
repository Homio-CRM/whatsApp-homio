const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg; codecs=opus': '.mp3', 'audio/ogg': '.mp3',
  'application/pdf': '.pdf', 'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/csv': '.csv',
};

export function mimeToExt(mime: string): string { return MIME_TO_EXT[mime] || '.bin'; }

export interface MediaInfo { hasMedia: boolean; mimeType: string; ext: string; mediaType: string; isAudio: boolean; }

// ---------------------------------------------------------------------------
// Envelopes: tipos que so embrulham outra mensagem (`x.message.<tipo real>`).
// Vistos na base: ephemeralMessage (mensagem temporaria), associatedChildMessage
// (filho de album), lottieStickerMessage (figurinha animada). Os outros sao do
// proto do WhatsApp e custam nada pra cobrir.
// ---------------------------------------------------------------------------
const ENVELOPES = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'associatedChildMessage', 'lottieStickerMessage',
  'editedMessage', 'deviceSentMessage', 'groupMentionedMessage', 'botInvokeMessage',
];

export function unwrapMessage(message: any): { message: any; envelopes: string[] } {
  let cur = message;
  const envelopes: string[] = [];
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const key = ENVELOPES.find((k) => cur?.[k]?.message && typeof cur[k].message === 'object');
    if (!key) break;
    envelopes.push(key);
    cur = cur[key].message;
  }
  return { message: cur, envelopes };
}

export function detectMedia(message: any): MediaInfo {
  const noMedia: MediaInfo = { hasMedia: false, mimeType: '', ext: '', mediaType: '', isAudio: false };
  if (!message) return noMedia;
  const { message: m, envelopes } = unwrapMessage(message);
  // Figurinha animada (lottie) vem com mimetype application/was: nao e renderizavel
  // em lugar nenhum fora do WhatsApp. Vai como texto (ver renderMessage).
  if (envelopes.includes('lottieStickerMessage')) return noMedia;
  const fields = [
    { key: 'imageMessage', type: 'image' }, { key: 'videoMessage', type: 'video' }, { key: 'ptvMessage', type: 'video' },
    { key: 'audioMessage', type: 'audio' }, { key: 'documentMessage', type: 'document' }, { key: 'stickerMessage', type: 'image' },
  ];
  for (const { key, type } of fields) {
    if (m?.[key]?.mimetype) {
      const mime = m[key].mimetype;
      return { hasMedia: true, mimeType: mime, ext: mimeToExt(mime), mediaType: type, isAudio: type === 'audio' };
    }
  }
  return noMedia;
}

export interface DetectedMediaType { extensionType: string; mimetype: string; ext: string; }

const EXT_MAP: Record<string, { type: string; mime: string }> = {
  jpg: { type: 'image', mime: 'image/jpeg' }, jpeg: { type: 'image', mime: 'image/jpeg' },
  png: { type: 'image', mime: 'image/png' }, gif: { type: 'image', mime: 'image/gif' },
  webp: { type: 'image', mime: 'image/webp' }, pdf: { type: 'document', mime: 'application/pdf' },
  doc: { type: 'document', mime: 'application/msword' },
  docx: { type: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xls: { type: 'document', mime: 'application/vnd.ms-excel' },
  xlsx: { type: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  csv: { type: 'document', mime: 'text/csv' }, mp4: { type: 'video', mime: 'video/mp4' },
  mov: { type: 'video', mime: 'video/quicktime' }, avi: { type: 'video', mime: 'video/x-msvideo' },
  mp3: { type: 'audio', mime: 'audio/mpeg' }, wav: { type: 'audio', mime: 'audio/wav' }, ogg: { type: 'audio', mime: 'audio/ogg' },
};

export async function detectMediaType(url: string): Promise<DetectedMediaType> {
  const urlExt = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (urlExt && EXT_MAP[urlExt]) return { extensionType: EXT_MAP[urlExt].type, mimetype: EXT_MAP[urlExt].mime, ext: urlExt };
  try {
    const headRes = await fetch(url, { method: 'HEAD' });
    const ct = headRes.headers.get('content-type') || '';
    for (const [ext, info] of Object.entries(EXT_MAP)) {
      if (ct.includes(info.mime)) return { extensionType: info.type, mimetype: info.mime, ext };
    }
  } catch (e) { console.warn('[media] HEAD request failed:', e); }
  return { extensionType: 'document', mimetype: 'application/octet-stream', ext: 'bin' };
}

// Mantida pelo nome: outras EFs importam. Agora desembrulha envelopes.
export function extractMessageText(message: any): string {
  if (!message) return '';
  const { message: m } = unwrapMessage(message);
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  return '';
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binStr = atob(base64);
  const arr = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) arr[i] = binStr.charCodeAt(i);
  return arr;
}

// ---------------------------------------------------------------------------
// renderMessage — o que cada tipo de mensagem do WhatsApp vira no GHL.
//
// O GHL so aceita texto + anexos (sem reacao, resposta, enquete, botao, edicao)
// e NAO renderiza *negrito* nem _italico_ (verificado 2026-10-14): tudo que nao
// e texto puro vira texto com emoji, quebra de linha e delimitador.
//
// Antes (ate a v47) so conversation/extendedText/legenda eram lidos; qualquer
// outro tipo virava '' — que em grupo saia como balao "Nome:" vazio e em 1:1
// sumia sem rastro (550 reacoes e 199 edicoes por semana).
// ---------------------------------------------------------------------------

export const DELIMITADOR = '_____________________';

export type Rendered =
  | { kind: 'content'; text: string; label: string }           // texto pronto (pode ser '' se so midia); label = como citar
  | { kind: 'reaction'; emoji: string; targetId: string; targetFromMe: boolean }
  | { kind: 'edit'; targetId: string; newText: string | null }
  | { kind: 'revoke'; targetId: string }
  | { kind: 'poll_vote'; pollId: string; options: string[] }
  | { kind: 'protocol'; type: string }                          // silenciar
  | { kind: 'unsupported'; type: string };

// Tipos que sao protocolo/metadado: nunca viram balao.
const PROTOCOLO = new Set([
  'albumMessage', 'pinInChatMessage', 'keepInChatMessage', 'placeholderMessage', 'messageHistoryNotice',
  'senderKeyDistributionMessage', 'messageContextInfo', 'protocolMessage', 'pollResultSnapshotMessage',
  'encReactionMessage', 'encEventResponseMessage', 'encCommentMessage', 'statusMentionMessage',
  'messageAssociation', 'deviceListMetadata', 'historySyncNotification', 'appStateSyncKeyShare',
  'appStateSyncKeyRequest', 'initialSecurityNotificationSettingSync', 'peerDataOperationRequestMessage',
  'peerDataOperationRequestResponseMessage', 'bcallMessage',
]);

function limpo(s: unknown): string { return typeof s === 'string' ? s.trim() : ''; }
function linhas(...partes: Array<string | null | undefined>): string { return partes.filter((p) => p && p.trim()).join('\n'); }
function numero(x: any): number | null { if (x == null) return null; const n = typeof x === 'object' ? Number(x.low ?? NaN) : Number(x); return Number.isFinite(n) ? n : null; }

function renderVcard(vcard: string, displayName?: string): string {
  const nome = limpo(displayName) || (vcard.match(/^FN:(.+)$/m)?.[1] || '').trim() || 'Contato';
  const tels = new Set<string>();
  for (const m of vcard.matchAll(/^TEL[^:]*:(.+)$/gm)) { const t = m[1].trim(); if (t) tels.add(t); }
  return linhas(`👤 ${nome}`, ...[...tels].map((t) => `📞 ${t}`));
}

function renderList(l: any): string {
  const rows: string[] = [];
  for (const sec of l?.sections ?? []) {
    if (limpo(sec?.title)) rows.push(`${sec.title.trim()}:`);
    for (const r of sec?.rows ?? []) {
      const t = limpo(r?.title); if (!t) continue;
      rows.push(limpo(r?.description) ? `• ${t} — ${r.description.trim()}` : `• ${t}`);
    }
  }
  return linhas(limpo(l?.title) ? `📋 ${l.title.trim()}` : '📋 Lista de opções', limpo(l?.description), ...rows, limpo(l?.footerText));
}

function renderButtons(b: any): string {
  const btns = (b?.buttons ?? []).map((x: any) => limpo(x?.buttonText?.displayText)).filter(Boolean).map((t: string) => `• ${t}`);
  return linhas(limpo(b?.contentText) || '📋 Opções', ...btns, limpo(b?.footerText));
}

function renderTemplate(t: any): string {
  const h = t?.hydratedTemplate ?? t?.hydratedFourRowTemplate ?? t;
  const btns = (h?.hydratedButtons ?? []).map((x: any) => {
    if (x?.quickReplyButton) return `• ${limpo(x.quickReplyButton.displayText) || limpo(x.quickReplyButton.id)}`;
    if (x?.urlButton) return `• ${limpo(x.urlButton.displayText)} ${limpo(x.urlButton.url)}`.trim();
    if (x?.callButton) return `• ${limpo(x.callButton.displayText)} ${limpo(x.callButton.phoneNumber)}`.trim();
    return '';
  }).filter(Boolean);
  return linhas(limpo(h?.hydratedTitleText), limpo(h?.hydratedContentText) || limpo(h?.imageMessage?.caption) || '📋 Mensagem com opções', ...btns, limpo(h?.hydratedFooterText));
}

function renderInteractive(i: any): string {
  const corpo = linhas(limpo(i?.header?.title), limpo(i?.body?.text), limpo(i?.footer?.text));
  const nf = i?.nativeFlowMessage;
  const extras: string[] = [];
  for (const b of nf?.buttons ?? []) {
    const nome = limpo(b?.name);
    let params: any = null;
    try { params = b?.buttonParamsJson ? JSON.parse(b.buttonParamsJson) : null; } catch { /* ignora */ }
    if (nome === 'payment_info' || nome === 'review_and_pay' || nome === 'review_order') {
      const total = params?.total_amount; const valor = total && typeof total.value === 'number' && typeof total.offset === 'number' && total.offset > 0 ? (total.value / total.offset).toFixed(2).replace('.', ',') : null;
      const pix = params?.payment_settings?.find?.((p: any) => p?.pix_static_code)?.pix_static_code;
      extras.push(linhas(`💳 Pedido de pagamento${valor ? ` — R$ ${valor}` : ''}`, pix ? `PIX: ${limpo(pix.key)} (${limpo(pix.merchant_name)})` : ''));
    } else if (nome === 'cta_url') {
      extras.push(`🔗 ${limpo(params?.display_text)} ${limpo(params?.url)}`.trim());
    } else if (nome === 'cta_call') {
      extras.push(`📞 ${limpo(params?.display_text)} ${limpo(params?.phone_number)}`.trim());
    } else if (nome === 'quick_reply') {
      extras.push(`• ${limpo(params?.display_text) || limpo(params?.id)}`);
    } else if (nome === 'single_select') {
      extras.push(renderList({ title: params?.title, sections: params?.sections }));
    } else if (nome) {
      extras.push(`• ${nome}`);
    }
  }
  return linhas(corpo || (extras.length ? '' : '📱 Mensagem interativa'), ...extras);
}

function renderPoll(p: any): string {
  const opts = (p?.options ?? []).map((o: any) => limpo(o?.optionName)).filter(Boolean).map((o: string) => `○ ${o}`);
  return linhas(`📊 Enquete: ${limpo(p?.name) || '(sem título)'}`, ...opts);
}

function mapsLink(lat: any, lng: any): string | null {
  const a = numero(lat), b = numero(lng);
  if (a == null || b == null) return null;
  return `https://maps.google.com/?q=${a},${b}`;
}

// Rotulo curto de uma mensagem, pra citar ("Em resposta a", "Reagiu a"...).
export function labelMessage(message: any): string {
  const { message: m, envelopes } = unwrapMessage(message);
  if (!m || typeof m !== 'object') return 'uma mensagem';
  if (envelopes.includes('lottieStickerMessage')) return '🧩 Figurinha animada';
  if (limpo(m.conversation)) return m.conversation.trim();
  if (limpo(m.extendedTextMessage?.text)) return m.extendedTextMessage.text.trim();
  if (m.imageMessage) return limpo(m.imageMessage.caption) ? `📷 Foto: ${m.imageMessage.caption.trim()}` : '📷 Foto';
  if (m.videoMessage) return limpo(m.videoMessage.caption) ? `🎬 Vídeo: ${m.videoMessage.caption.trim()}` : (m.videoMessage.gifPlayback ? '🎞️ GIF' : '🎬 Vídeo');
  if (m.ptvMessage) return '🎬 Vídeo';
  if (m.audioMessage) return m.audioMessage.ptt === false ? '🎵 Áudio' : '🎤 Áudio';
  if (m.documentMessage) return `📄 ${limpo(m.documentMessage.fileName) || limpo(m.documentMessage.caption) || 'Documento'}`;
  if (m.stickerMessage) return '🧩 Figurinha';
  if (m.albumMessage) return '🖼️ Álbum de fotos';
  if (m.listMessage) return limpo(m.listMessage.description) || limpo(m.listMessage.title) || '📋 Lista de opções';
  if (m.buttonsMessage) return limpo(m.buttonsMessage.contentText) || '📋 Opções';
  if (m.templateMessage) return limpo(m.templateMessage.hydratedTemplate?.hydratedContentText) || '📋 Mensagem com opções';
  if (m.interactiveMessage) return limpo(m.interactiveMessage.body?.text) || '📱 Mensagem interativa';
  if (m.listResponseMessage) return `☑️ ${limpo(m.listResponseMessage.title) || 'opção escolhida'}`;
  if (m.buttonsResponseMessage) return `☑️ ${limpo(m.buttonsResponseMessage.selectedDisplayText) || 'opção escolhida'}`;
  if (m.templateButtonReplyMessage) return `☑️ ${limpo(m.templateButtonReplyMessage.selectedDisplayText) || limpo(m.templateButtonReplyMessage.selectedId) || 'opção escolhida'}`;
  if (m.contactMessage) return `👤 ${limpo(m.contactMessage.displayName) || 'Contato'}`;
  if (m.contactsArrayMessage) return `👤 ${(m.contactsArrayMessage.contacts ?? []).length} contatos`;
  if (m.locationMessage) return `📍 ${limpo(m.locationMessage.name) || limpo(m.locationMessage.address) || 'Localização'}`;
  if (m.liveLocationMessage) return '📍 Localização em tempo real';
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) return `📊 Enquete: ${limpo((m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3)?.name) || '(sem título)'}`;
  if (m.orderMessage) return `🛒 Pedido${limpo(m.orderMessage.orderTitle) ? `: ${m.orderMessage.orderTitle.trim()}` : ''}`;
  if (m.productMessage) return `🛍️ ${limpo(m.productMessage.product?.title) || 'Produto'}`;
  if (m.eventMessage) return `📅 ${limpo(m.eventMessage.name) || 'Evento'}`;
  if (m.groupInviteMessage) return `👥 Convite para "${limpo(m.groupInviteMessage.groupName) || 'grupo'}"`;
  if (m.reactionMessage) return `${limpo(m.reactionMessage.text) || 'reação'}`;
  if (m.call) return '📞 Chamada';
  return 'uma mensagem';
}

// Primeira linha util, sem quebras, no maximo `max` chars. Se o texto for um
// marcador nosso (resposta/reacao), cita o conteudo depois do delimitador.
export function snippet(text: string | null | undefined, max = 140): string {
  let t = (text || '').replace(/\r/g, '');
  const i = t.lastIndexOf(DELIMITADOR + '\n');
  if (i >= 0) t = t.slice(i + DELIMITADOR.length + 1);
  // Em grupo a primeira linha e "Nome:" — pula se houver algo depois.
  const partes = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (partes.length > 1 && /^[^\n]{1,60}:$/.test(partes[0])) partes.shift();
  t = partes.join(' ').replace(/\s+/g, ' ').trim();
  // Balao antigo so com "Nome:" (bug pre-v48) nao e conteudo.
  if (!t || /^[^\n]{1,60}:$/.test(t)) return 'uma mensagem';
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// Bloco de citacao, no formato aprovado pelo Luan em 2026-10-14:
//   ↩️ Em resposta a:
//   "trecho"
//   _____________________
//   texto da resposta
export function renderQuote(quotedMessage: any): string | null {
  if (!quotedMessage || typeof quotedMessage !== 'object') return null;
  const label = snippet(labelMessage(quotedMessage));
  return `↩️ Em resposta a:\n"${label}"`;
}

export function renderMessage(rawMessage: any, messageType?: string): Rendered {
  if (!rawMessage || typeof rawMessage !== 'object') return { kind: 'protocol', type: messageType || 'empty' };
  const { message: m, envelopes } = unwrapMessage(rawMessage);
  if (!m || typeof m !== 'object') return { kind: 'protocol', type: messageType || 'empty' };

  if (envelopes.includes('lottieStickerMessage')) return { kind: 'content', text: '🧩 Figurinha animada', label: '🧩 Figurinha animada' };

  // Edicao no formato antigo do proto (protocolMessage.editedMessage) ou envelope editedMessage.
  if (envelopes.includes('editedMessage')) {
    const inner = renderMessage(m, messageType);
    const novo = inner.kind === 'content' ? inner.text : null;
    const targetId = rawMessage?.editedMessage?.message?.protocolMessage?.key?.id || m?.protocolMessage?.key?.id || '';
    return { kind: 'edit', targetId, newText: novo };
  }

  // Texto
  if (limpo(m.conversation)) return { kind: 'content', text: m.conversation, label: snippet(m.conversation) };
  if (limpo(m.extendedTextMessage?.text)) return { kind: 'content', text: m.extendedTextMessage.text, label: snippet(m.extendedTextMessage.text) };

  // Midia (o anexo vem por detectMedia; aqui so a legenda)
  if (m.imageMessage) return { kind: 'content', text: limpo(m.imageMessage.caption), label: labelMessage(m) };
  if (m.videoMessage) return { kind: 'content', text: limpo(m.videoMessage.caption), label: labelMessage(m) };
  if (m.ptvMessage) return { kind: 'content', text: '', label: '🎬 Vídeo' };
  if (m.audioMessage) return { kind: 'content', text: '', label: labelMessage(m) };
  if (m.documentMessage) return { kind: 'content', text: limpo(m.documentMessage.caption), label: labelMessage(m) };
  if (m.stickerMessage) return { kind: 'content', text: '', label: '🧩 Figurinha' };

  // Reacao: texto vazio = reacao removida
  if (m.reactionMessage) {
    return { kind: 'reaction', emoji: limpo(m.reactionMessage.text), targetId: limpo(m.reactionMessage.key?.id), targetFromMe: m.reactionMessage.key?.fromMe === true };
  }

  // Edicao cifrada (secretEncType 2 = MESSAGE_EDIT): so da pra dizer que editou.
  if (m.secretEncryptedMessage) {
    const tipo = Number(m.secretEncryptedMessage.secretEncType);
    const targetId = limpo(m.secretEncryptedMessage.targetMessageKey?.id);
    if (tipo === 2 && targetId) return { kind: 'edit', targetId, newText: null };
    return { kind: 'protocol', type: 'secretEncryptedMessage' };
  }

  // protocolMessage: REVOKE (0) e MESSAGE_EDIT (14) interessam; o resto e protocolo.
  if (m.protocolMessage) {
    const p = m.protocolMessage;
    const t = typeof p.type === 'string' ? p.type : Number(p.type);
    const targetId = limpo(p.key?.id);
    if ((t === 0 || t === 'REVOKE') && targetId) return { kind: 'revoke', targetId };
    if ((t === 14 || t === 'MESSAGE_EDIT') && targetId) {
      const inner = p.editedMessage ? renderMessage(p.editedMessage, messageType) : null;
      return { kind: 'edit', targetId, newText: inner && inner.kind === 'content' ? inner.text : null };
    }
    return { kind: 'protocol', type: 'protocolMessage' };
  }

  // Enquete
  const poll = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
  if (poll) { const t = renderPoll(poll); return { kind: 'content', text: t, label: snippet(t.split('\n')[0]) }; }
  if (m.pollUpdateMessage) {
    const opts = (m.pollUpdateMessage.vote?.selectedOptions ?? []).map((o: any) => limpo(typeof o === 'string' ? o : o?.optionName ?? o?.name)).filter(Boolean);
    return { kind: 'poll_vote', pollId: limpo(m.pollUpdateMessage.pollCreationMessageKey?.id), options: opts };
  }

  // Listas, botoes, templates, interativas (bots de empresa) e as respostas a elas
  if (m.listMessage) { const t = renderList(m.listMessage); return { kind: 'content', text: t, label: labelMessage(m) }; }
  if (m.buttonsMessage) { const t = renderButtons(m.buttonsMessage); return { kind: 'content', text: t, label: labelMessage(m) }; }
  if (m.templateMessage) { const t = renderTemplate(m.templateMessage); return { kind: 'content', text: t, label: labelMessage(m) }; }
  if (m.interactiveMessage) { const t = renderInteractive(m.interactiveMessage); return { kind: 'content', text: t, label: labelMessage(m) }; }
  if (m.listResponseMessage) { const t = `☑️ ${limpo(m.listResponseMessage.title) || limpo(m.listResponseMessage.singleSelectReply?.selectedRowId) || 'Opção escolhida'}`; return { kind: 'content', text: t, label: t }; }
  if (m.buttonsResponseMessage) { const t = `☑️ ${limpo(m.buttonsResponseMessage.selectedDisplayText) || limpo(m.buttonsResponseMessage.selectedButtonId) || 'Opção escolhida'}`; return { kind: 'content', text: t, label: t }; }
  if (m.templateButtonReplyMessage) { const t = `☑️ ${limpo(m.templateButtonReplyMessage.selectedDisplayText) || limpo(m.templateButtonReplyMessage.selectedId) || 'Opção escolhida'}`; return { kind: 'content', text: t, label: t }; }
  if (m.interactiveResponseMessage) {
    let t = limpo(m.interactiveResponseMessage.body?.text);
    try { const p = JSON.parse(m.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson || '{}'); t = limpo(p?.title) || limpo(p?.id) || t; } catch { /* ignora */ }
    t = `☑️ ${t || 'Opção escolhida'}`; return { kind: 'content', text: t, label: t };
  }

  // Contatos (vCard)
  if (m.contactMessage) { const t = renderVcard(limpo(m.contactMessage.vcard), m.contactMessage.displayName); return { kind: 'content', text: t, label: labelMessage(m) }; }
  if (m.contactsArrayMessage) {
    const cs = (m.contactsArrayMessage.contacts ?? []).map((c: any) => renderVcard(limpo(c?.vcard), c?.displayName));
    const t = linhas(`👤 ${cs.length} contato${cs.length === 1 ? '' : 's'} compartilhado${cs.length === 1 ? '' : 's'}:`, ...cs);
    return { kind: 'content', text: t, label: labelMessage(m) };
  }

  // Localizacao
  if (m.locationMessage) {
    const l = m.locationMessage;
    const nome = limpo(l.name), end = limpo(l.address);
    const t = linhas(`📍 ${nome || end || 'Localização'}`, nome && end && end !== nome ? end : '', limpo(l.comment), mapsLink(l.degreesLatitude, l.degreesLongitude));
    return { kind: 'content', text: t, label: labelMessage(m) };
  }
  if (m.liveLocationMessage) {
    const l = m.liveLocationMessage;
    const t = linhas('📍 Localização em tempo real', limpo(l.caption), mapsLink(l.degreesLatitude, l.degreesLongitude));
    return { kind: 'content', text: t, label: '📍 Localização em tempo real' };
  }

  // Comercio / eventos / convites / chamadas
  if (m.orderMessage) {
    const o = m.orderMessage; const n = numero(o.itemCount);
    const t = `🛒 Pedido pelo catálogo${limpo(o.orderTitle) ? `: ${o.orderTitle.trim()}` : ''}${n != null ? ` (${n} ${n === 1 ? 'item' : 'itens'})` : ''}`;
    return { kind: 'content', text: t, label: labelMessage(m) };
  }
  if (m.productMessage) {
    const p = m.productMessage.product ?? {};
    const preco = numero(p.priceAmount1000); const cur = limpo(p.currencyCode);
    const t = linhas(`🛍️ ${limpo(p.title) || 'Produto'}${preco != null ? ` — ${cur || 'R$'} ${(preco / 1000).toFixed(2).replace('.', ',')}` : ''}`, limpo(p.description));
    return { kind: 'content', text: t, label: labelMessage(m) };
  }
  if (m.requestPaymentMessage) {
    const r = m.requestPaymentMessage; const v = numero(r.amount1000);
    const t = `💸 Pedido de pagamento${v != null ? ` — ${limpo(r.currencyCodeIso4217) || 'R$'} ${(v / 1000).toFixed(2).replace('.', ',')}` : ''}`;
    return { kind: 'content', text: t, label: t };
  }
  if (m.eventMessage) {
    const e = m.eventMessage; const ts = numero(e.startTime);
    const t = linhas(`📅 Evento: ${limpo(e.name) || '(sem título)'}`, limpo(e.description), ts ? `Quando: ${new Date(ts * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : '', limpo(e.location?.name), limpo(e.joinLink));
    return { kind: 'content', text: t, label: labelMessage(m) };
  }
  if (m.groupInviteMessage) {
    const g = m.groupInviteMessage;
    const t = linhas(`👥 Convite para o grupo "${limpo(g.groupName) || 'grupo'}"`, limpo(g.caption), limpo(g.inviteCode) ? `https://chat.whatsapp.com/${g.inviteCode.trim()}` : '');
    return { kind: 'content', text: t, label: labelMessage(m) };
  }
  if (m.scheduledCallCreationMessage) { const t = `📞 Chamada agendada${limpo(m.scheduledCallCreationMessage.title) ? `: ${m.scheduledCallCreationMessage.title.trim()}` : ''}`; return { kind: 'content', text: t, label: t }; }
  if (m.call) return { kind: 'content', text: '📞 Chamada', label: '📞 Chamada' };
  if (m.stickerPackMessage) return { kind: 'content', text: `🧩 Pacote de figurinhas${limpo(m.stickerPackMessage.name) ? `: ${m.stickerPackMessage.name.trim()}` : ''}`, label: '🧩 Pacote de figurinhas' };

  // Protocolo: nada a mostrar (e nada a prefixar com "Nome:").
  const chaves = Object.keys(m).filter((k) => m[k] != null);
  if (chaves.length === 0 || chaves.every((k) => PROTOCOLO.has(k))) return { kind: 'protocol', type: chaves[0] || messageType || 'empty' };

  // Sobrou um tipo que nao conhecemos e tem conteudo: avisa em vez de sumir.
  const tipo = chaves.find((k) => !PROTOCOLO.has(k)) || messageType || 'desconhecido';
  return { kind: 'unsupported', type: tipo };
}
