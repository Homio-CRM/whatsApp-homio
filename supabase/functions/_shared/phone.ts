export function getOnlyNumbers(str: string): string {
  if (!str) return '';
  return str.split('@')[0].replace(/\D/g, '');
}

// Regra BR (revisada 2026-06-16):
//  - celular: 55 + DDD + 9 + 8 digitos (o 9 e obrigatorio)
//  - fixo:    55 + DDD + 8 digitos (primeiro digito 2-5)
//
// O JID do WhatsApp (@s.whatsapp.net) e CANONICO: ja traz o 9 real do celular. As faixas
// novas de SP (e outros DDDs) emitem celular com 9 seguido de 0-5, entao NUNCA removemos o
// 9 de um numero de 13 digitos — o branch antigo de "remover 9" corrompia esses celulares
// (gravava 12 digitos, colidia com fixo e quebrava o envio). So ADICIONAMOS o 9 quando ele
// falta num numero de 12 digitos que NAO e fixo (primeiro digito do local != 2-5).
export function normalizePhone(phone: string): string {
  let p = getOnlyNumbers(phone);
  if (p.startsWith('55')) {
    const ddd = p.substring(2, 4);
    const rest = p.substring(4);
    if (rest.length === 8) {
      const firstDigit = parseInt(rest[0], 10);
      // fixo (2-5) fica como esta; qualquer outro = celular sem o 9 -> adiciona o 9
      if (!Number.isNaN(firstDigit) && (firstDigit < 2 || firstDigit > 5)) {
        p = `55${ddd}9${rest}`;
      }
    }
    // rest.length === 9 (ja tem o 9): mantem intacto, confiando no canonico do WhatsApp
  } else if (p.startsWith('52') && !p.startsWith('521')) {
    p = '521' + p.substring(2);
  }
  return p;
}

// Remove o 9 de um celular BR (13 -> 12) APENAS quando o resultado seria um fixo plausivel
// (digito apos o 9 entre 2-5). Usado no RETRY de envio pro caso raro de um fixo cadastrado
// no GHL com um 9 colado por engano (ex: +5511952170133, fixo 5217-0133 com 9 na frente).
// Retorna null quando nao se aplica (ex: 9 seguido de 0/1 e sempre celular real).
export function stripBrNine(phone: string): string | null {
  const p = getOnlyNumbers(phone);
  if (p.startsWith('55')) {
    const ddd = p.substring(2, 4);
    const rest = p.substring(4);
    if (rest.length === 9 && rest.startsWith('9')) {
      const after = rest.substring(1);
      const firstDigitAfter9 = parseInt(after[0], 10);
      if (!Number.isNaN(firstDigitAfter9) && firstDigitAfter9 >= 2 && firstDigitAfter9 <= 5) {
        return `55${ddd}${after}`;
      }
    }
  }
  return null;
}

// Adiciona o 9 a um celular BR de 12 digitos (55 + DDD + 8) gerando 13 digitos.
// Usado no RETRY de envio pra recuperar celular cujo 9 foi removido por engano e ficou
// gravado sem o 9 no DB (corrupcao do strip antigo, ate 2026-06-16). Retorna null quando
// nao se aplica (numero ja tem 13 digitos, ou nao e BR).
export function addBrNine(phone: string): string | null {
  const p = getOnlyNumbers(phone);
  if (p.startsWith('55')) {
    const ddd = p.substring(2, 4);
    const rest = p.substring(4);
    if (rest.length === 8) {
      return `55${ddd}9${rest}`;
    }
  }
  return null;
}

export function cleanGroupId(jid: string): string {
  if (!jid) return '';
  let idPart = jid.split('@')[0];
  if (idPart.includes('-')) idPart = idPart.split('-').pop() || idPart;
  return idPart.replace(/\D/g, '');
}

export function resolvePhoneForSend(phone: string, isGroup?: boolean, evoGroupId?: string) {
  if (isGroup && evoGroupId) return { sendTo: evoGroupId, dbPhone: phone, dbLid: null };
  const raw = phone.replace('+', '').replace(/\s/g, '');
  const noAt = raw.split('@')[0];
  const isLid = noAt.length > 14 || phone.includes('@lid');
  if (isLid) {
    const sendTo = phone.includes('@lid') ? phone : `${noAt}@lid`;
    return { sendTo, dbPhone: '', dbLid: noAt };
  }
  const normalized = normalizePhone(noAt.replace(/\D/g, ''));
  return { sendTo: normalized, dbPhone: normalized, dbLid: null };
}

export interface PhoneResolution {
  isGroup: boolean;
  groupJid: string | null;
  phone: string;
  whatsappLid: string | null;
  realPhone: string | null;
  hasRealPhone: boolean;
  isLidOnly: boolean;
  dbPhone: string;
  dbLid: string | null;
  sendTo: string;
  pushName: string;
}

export function resolvePhoneFromData(data: any, instanceOwnerJid: string): PhoneResolution {
  const key = data.key || {};
  const remoteJid = key.remoteJid || data.remoteJid || '';
  const remoteJidAlt = key.remoteJidAlt || data.remoteJidAlt || '';
  const participant = key.participant || data.participant || '';
  const pushName = data.pushName || '';

  let candidates = [remoteJid, remoteJidAlt, participant]
    .filter(Boolean)
    .filter(jid => jid !== instanceOwnerJid);
  if (candidates.length === 0 && remoteJid) candidates.push(remoteJid);

  const rawLid = candidates.find(jid => jid.includes('@lid')) || null;
  const rawPhoneJid = candidates.find(jid => jid.includes('@s.whatsapp.net')) || null;
  const isGroup = remoteJid.includes('@g.us');
  const groupJid = isGroup ? remoteJid : null;

  const realPhone = rawPhoneJid ? normalizePhone(rawPhoneJid) : null;
  const lidNumber = rawLid ? getOnlyNumbers(rawLid) : null;

  console.log(`[resolve] remoteJid=${remoteJid} remoteJidAlt=${remoteJidAlt} participant=${participant} ownerJid=${instanceOwnerJid}`);
  console.log(`[resolve] candidates=${JSON.stringify(candidates)} rawLid=${rawLid} rawPhoneJid=${rawPhoneJid} realPhone=${realPhone} lidNumber=${lidNumber}`);

  if (isGroup) {
    const groupId = cleanGroupId(remoteJid);
    const senderPhone = participant ? normalizePhone(participant) : '';
    return {
      isGroup: true, groupJid, phone: groupId, whatsappLid: null,
      realPhone: senderPhone || null, hasRealPhone: !!senderPhone, isLidOnly: false,
      dbPhone: senderPhone, dbLid: null, sendTo: groupId, pushName,
    };
  }

  if (realPhone) {
    return {
      isGroup: false, groupJid: null, phone: realPhone, whatsappLid: lidNumber,
      realPhone, hasRealPhone: true, isLidOnly: false,
      dbPhone: realPhone, dbLid: lidNumber, sendTo: realPhone, pushName,
    };
  }

  if (lidNumber) {
    return {
      isGroup: false, groupJid: null, phone: lidNumber, whatsappLid: lidNumber,
      realPhone: null, hasRealPhone: false, isLidOnly: true,
      dbPhone: '', dbLid: lidNumber, sendTo: lidNumber, pushName,
    };
  }

  const cleaned = getOnlyNumbers(remoteJid);
  const normalized = normalizePhone(remoteJid);
  return {
    isGroup: false, groupJid: null, phone: normalized || cleaned, whatsappLid: null,
    realPhone: normalized || null, hasRealPhone: !!normalized, isLidOnly: false,
    dbPhone: normalized || cleaned, dbLid: null, sendTo: normalized || cleaned, pushName,
  };
}
