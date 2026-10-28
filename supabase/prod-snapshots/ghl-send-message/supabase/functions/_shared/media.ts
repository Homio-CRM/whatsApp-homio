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

export function mimeToExt(mime: string): string {
  return MIME_TO_EXT[mime] || '.bin';
}

export interface MediaInfo { hasMedia: boolean; mimeType: string; ext: string; mediaType: string; isAudio: boolean; }

export function detectMedia(message: any): MediaInfo {
  const noMedia: MediaInfo = { hasMedia: false, mimeType: '', ext: '', mediaType: '', isAudio: false };
  if (!message) return noMedia;
  const fields = [
    { key: 'imageMessage', type: 'image' }, { key: 'videoMessage', type: 'video' },
    { key: 'audioMessage', type: 'audio' }, { key: 'documentMessage', type: 'document' },
    { key: 'stickerMessage', type: 'image' },
  ];
  for (const { key, type } of fields) {
    if (message[key]?.mimetype) {
      const mime = message[key].mimetype;
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
  mp3: { type: 'audio', mime: 'audio/mpeg' }, wav: { type: 'audio', mime: 'audio/wav' },
  ogg: { type: 'audio', mime: 'audio/ogg' },
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

export function extractMessageText(message: any): string {
  if (!message) return '';
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return '';
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binStr = atob(base64);
  const arr = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) arr[i] = binStr.charCodeAt(i);
  return arr;
}
