// Menu em enquete (2026-10-20). Mensagem do GHL que comeca com /enquete vira sendPoll na Evolution; o voto
// (ou o numero digitado enquanto a enquete esta aberta) vira o campo de contato "Menu escolhido", que o
// workflow do cliente espera ("Wait → condicoes") e usa no If/Else. Usado pela ghl-send-message e pela
// evolution-receive-message — as duas copias deste arquivo tem que ficar IGUAIS.
//
// Formato aceito:
//   /enquete
//   Pergunta (uma ou mais linhas, tudo antes da 1a opcao)
//   1 - Primeira opcao
//   2 - Segunda opcao
// O valor gravado no campo e o NUMERO da opcao ("1", "2"...), nao o texto.
import { GHL_BASE, GHL_VERSION_V2 } from './ghl-auth.ts';

export const MENU_FIELD_KEY = 'contact.menu_escolhido';
export const MENU_FIELD_NAME = 'Menu escolhido';
// Schema do sendPoll na Evolution 2.3.7: values minItems 2, maxItems 10, uniqueItems.
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
// Numero digitado so conta como escolha se a ultima enquete da conversa tem ate 24h.
export const MENU_TYPED_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PollOption { label: string; value: string }
export type PollParse =
  | { ok: true; question: string; options: PollOption[] }
  | { ok: false; error: string };

const MARKER = /^\s*\/enquete(?=\s|$)[ \t]*/i;
const OPTION_LINE = /^(\d{1,2})\s*[-–—.)]\s*(\S.*)$/;
const TYPED_CHOICE = /^\s*(\d{1,2})\s*[-–—.)]?\s*$/;

export function isPollCommand(text: string): boolean {
  return MARKER.test(text || '');
}

export function parsePollCommand(text: string): PollParse {
  const body = (text || '').replace(/\r\n?/g, '\n').replace(MARKER, '');
  const question: string[] = [];
  const options: PollOption[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(OPTION_LINE);
    if (m) { options.push({ label: line, value: String(parseInt(m[1], 10)) }); continue; }
    if (options.length) return { ok: false, error: `texto depois das opções: "${line.slice(0, 40)}"` };
    question.push(line);
  }
  if (!question.length) return { ok: false, error: 'falta a pergunta antes das opções' };
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
    return { ok: false, error: `são ${options.length} opções; use de ${POLL_MIN_OPTIONS} a ${POLL_MAX_OPTIONS}, uma por linha, começando com o número` };
  }
  const values = new Set(options.map((o) => o.value));
  if (values.size !== options.length) return { ok: false, error: 'número de opção repetido' };
  const labels = new Set(options.map((o) => o.label));
  if (labels.size !== options.length) return { ok: false, error: 'opção repetida' };
  return { ok: true, question: question.join('\n'), options };
}

// Numero solto digitado pelo contato ("5", "5.", "5)") -> "5"; qualquer outra coisa -> null.
export function typedChoice(text: string | null | undefined): string | null {
  const m = (text || '').match(TYPED_CHOICE);
  return m ? String(parseInt(m[1], 10)) : null;
}

// Valor de uma opcao votada: pelo texto exato na lista gravada no envio; senao o numero do comeco do texto.
export function voteValue(selected: string, options: PollOption[]): string | null {
  const hit = options.find((o) => o.label === selected.trim());
  if (hit) return hit.value;
  const m = selected.trim().match(OPTION_LINE);
  return m ? String(parseInt(m[1], 10)) : null;
}

// Id do campo "Menu escolhido" na location; cria (TEXT) se nao existir. null = nao deu (loga o motivo).
export async function ensureMenuField(token: string, locationId: string): Promise<string | null> {
  const headers = { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json' };
  try {
    const res = await fetch(`${GHL_BASE}/locations/${encodeURIComponent(locationId)}/customFields?model=contact`, { headers });
    if (!res.ok) { console.warn(`[menu] listar campos ${res.status}: ${(await res.text()).slice(0, 200)}`); return null; }
    const fields: any[] = (await res.json())?.customFields ?? [];
    const found = fields.find((f) => f?.fieldKey === MENU_FIELD_KEY)
      ?? fields.find((f) => String(f?.name ?? '').trim().toLowerCase() === MENU_FIELD_NAME.toLowerCase());
    if (found?.id) return found.id as string;
    const cr = await fetch(`${GHL_BASE}/locations/${encodeURIComponent(locationId)}/customFields`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: MENU_FIELD_NAME, dataType: 'TEXT', model: 'contact' }),
    });
    if (!cr.ok) { console.warn(`[menu] criar campo ${cr.status}: ${(await cr.text()).slice(0, 200)}`); return null; }
    const cd = await cr.json();
    const id = cd?.customField?.id ?? cd?.id ?? null;
    console.log(`[menu] campo "${MENU_FIELD_NAME}" criado na location ${locationId}: ${id}`);
    return id;
  } catch (e: any) { console.warn('[menu] ensureMenuField erro:', e?.message ?? e); return null; }
}

// Grava (ou limpa, com '') o campo no contato. Testado em 2026-10-20: '' remove o valor e nao mexe nas tags.
export async function setMenuField(token: string, contactId: string, fieldId: string, value: string): Promise<boolean> {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Version': GHL_VERSION_V2, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: [{ id: fieldId, field_value: value }] }),
    });
    if (!res.ok) { console.warn(`[menu] PUT campo ${res.status}: ${(await res.text()).slice(0, 200)}`); return false; }
    return true;
  } catch (e: any) { console.warn('[menu] setMenuField erro:', e?.message ?? e); return false; }
}
