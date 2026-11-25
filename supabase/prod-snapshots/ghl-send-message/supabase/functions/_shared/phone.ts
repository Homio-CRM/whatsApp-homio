export function getOnlyNumbers(str: string): string {
  if (!str) return '';
  return str.split('@')[0].replace(/\D/g, '');
}

// Identificadores de GRUPO/newsletter do WhatsApp: JID @g.us, OU id "novo estilo" de 17+
// digitos com prefixo 120363. NAO confundir com LID de CONTATO individual (14-15 digitos,
// sem prefixo 120363) — o guard do LID-first (v46) ja usa essa mesma fronteira.
// Grupo SO entrega endereçado por @g.us; se cair no @lid a msg e aceita mas nunca entrega
// (pegadinha da conv 16252). Por isso classificamos cedo pra rotear pro caminho de grupo.
export function isGroupLikeId(id: string): boolean {
  if (!id) return false;
  if (id.includes('@g.us')) return true;
  const digits = id.replace(/\D/g, '');
  return digits.length >= 17 && digits.startsWith('120363');
}

// Dado um id classe-grupo (digitos, possivelmente ja a forma @g.us OU a forma @lid), retorna os
// JIDs @g.us CANDIDATOS a testar via findGroupInfos, em ordem de prioridade: o exato primeiro,
// depois os vizinhos +-1. A forma @lid de um grupo e ADJACENTE ao @g.us real (visto em 2/2 casos:
// grupo Claude lid=...396/g.us=...395; grupo teste contato=...380/g.us=...379 -> lid = g.us + 1).
// NUNCA confiar cego: quem chama SO entrega no candidato que findGroupInfos confirmar como grupo
// participante. Usa BigInt — ids de 18 digitos passam de Number.MAX_SAFE_INTEGER (nunca Number).
export function groupJidCandidates(id: string): string[] {
  const digits = (id || '').split('@')[0].replace(/\D/g, '');
  if (!digits) return [];
  const out = [`${digits}@g.us`];
  try {
    const n = BigInt(digits);
    out.push(`${(n - 1n).toString()}@g.us`);
    out.push(`${(n + 1n).toString()}@g.us`);
  } catch { /* nao numerico: so o exato */ }
  return out;
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

// Chaves canonicas de um telefone para COMPARAR, nunca para escolher destino (2026-10-28):
// com/sem DDI 55, com/sem o 9 do celular BR e 52/521 do Mexico. Dois numeros sao "o mesmo"
// quando alguma chave casa. Internacional fora disso casa so pela forma exata.
export function phoneKeys(raw: string | null | undefined): string[] {
  const d = getOnlyNumbers(raw || '');
  if (!d) return [];
  const keys = new Set<string>([d]);
  // digitado sem DDI (DDD + 8/9 digitos) -> assume BR
  if (d.length === 10 || d.length === 11) keys.add(`55${d}`);
  // gravado com DDI -> a forma local, para casar com quem digitou sem
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) keys.add(d.substring(2));
  if (d.startsWith('521') && d.length === 13) keys.add(`52${d.substring(3)}`);
  else if (d.startsWith('52') && d.length === 12) keys.add(`521${d.substring(2)}`);
  // variantes do 9 do celular BR, nos dois sentidos
  for (const k of [...keys]) {
    if (!k.startsWith('55') || (k.length !== 12 && k.length !== 13)) continue;
    const local = k.substring(4);
    if (local.length === 8) keys.add(`${k.substring(0, 4)}9${local}`);
    if (local.length === 9 && local.startsWith('9')) keys.add(`${k.substring(0, 4)}${local.substring(1)}`);
  }
  return [...keys];
}

export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = phoneKeys(a);
  if (ka.length === 0) return false;
  const kb = new Set(phoneKeys(b));
  return ka.some((k) => kb.has(k));
}

// Escolhe a instancia da subconta apontada por um override "#numero". Desempate (raro: dois
// numeros da mesma subconta diferindo so pelo 9): forma exata primeiro, depois a conectada.
export function pickByNumber<T extends { number_connected: string | null; status: string }>(list: T[], wanted: string): T | null {
  const raw = getOnlyNumbers(wanted);
  const matches = list.filter((i) => samePhone(i.number_connected, wanted));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    matches.sort((a, b) => {
      const exact = (i: T) => (getOnlyNumbers(i.number_connected || '') === raw ? 0 : 1);
      const open = (i: T) => (i.status === 'open' ? 0 : 1);
      return (exact(a) - exact(b)) || (open(a) - open(b));
    });
  }
  return matches[0];
}

export function cleanGroupId(jid: string): string {
  if (!jid) return '';
  let idPart = jid.split('@')[0];
  if (idPart.includes('-')) idPart = idPart.split('-').pop() || idPart;
  return idPart.replace(/\D/g, '');
}

export function resolvePhoneForSend(phone: string, isGroup?: boolean, evoGroupId?: string) {
  if (isGroup && evoGroupId) return { sendTo: evoGroupId, dbPhone: phone, dbLid: null, groupLike: true, groupJid: evoGroupId };
  const raw = phone.replace('+', '').replace(/\s/g, '');
  const noAt = raw.split('@')[0];
  // Grupo/newsletter "novo estilo" (120363...) OU @g.us explicito: NAO e LID de contato.
  // Retorna um groupJid candidato pra o handler confirmar via findGroupInfos antes de enviar
  // (o @g.us e o unico endereçamento que entrega em grupo).
  if (isGroupLikeId(phone) || isGroupLikeId(noAt)) {
    const digits = noAt.replace(/\D/g, '');
    const groupJid = phone.includes('@g.us') ? phone : `${digits}@g.us`;
    return { sendTo: groupJid, dbPhone: '', dbLid: null, groupLike: true, groupJid };
  }
  const isLid = noAt.length > 14 || phone.includes('@lid');
  if (isLid) {
    const sendTo = phone.includes('@lid') ? phone : `${noAt}@lid`;
    return { sendTo, dbPhone: '', dbLid: noAt, groupLike: false, groupJid: null };
  }
  const normalized = normalizePhone(noAt.replace(/\D/g, ''));
  return { sendTo: normalized, dbPhone: normalized, dbLid: null, groupLike: false, groupJid: null };
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
