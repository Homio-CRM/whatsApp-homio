// contact-photo-sync — foto do WhatsApp no contato da GHL (2026-11-16).
// Wiki: projetos/whatsapp_homio_foto_contato.md. Migration: 20261116202500_contact_photos.sql.
//
// A evolution-receive-message so enfileira (rpc contact_photo_touch); esta funcao faz o trabalho e pode
// falhar sozinha — mensagem nunca depende dela. Por linha devida:
//   foto na Evolution (POST /chat/fetchProfilePictureUrl, aceita telefone, LID e grupo)
//   -> sem foto: `sem_foto` (a GHL fica com a ultima; decisao do Luan)
//   -> mesmo caminho da URL que ja gravamos: nada a fazer
//   -> GET do contato na GHL: foto que nao e a nossa = `manual`, nunca mais mexe
//   -> baixa a imagem, sobe pelo upload de conversa (POST /conversations/messages/upload: o token do app
//      nao tem escopo medias.*, entao Media Library nao da) e grava em `profilePhoto` (campo nao documentado)
//
// POST header x-watch-token (= public.instance_watch_token(); o cron chama de dentro do banco)
//   ?contactId=<id>   processa agora a linha desse contato (teste), ignorando o next_check_at
// Interruptor: contact_photo_config.mode (off | pilot | on) + location_settings.contact_photo.
import { getSupabase } from "../_shared/supabase.ts";

// cliente sem tipos gerados (o createClient sem schema devolve `never` no check)
// deno-lint-ignore no-explicit-any
type SupabaseClient = any;
import { getGHLToken, GHL_BASE, GHL_VERSION_V1, GHL_VERSION_V2 } from "../_shared/ghl-auth.ts";

const EVOLUTION = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/+$/, "");
const EVO_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? "";
const ORCAMENTO_MS = 100_000;          // a rodada para aqui; o resto volta pra fila (cron e de 2 em 2 min)
const MAX_POR_RODADA = 200;
const PAUSA_MS = 400;                  // entre consultas da mesma instancia
const FOTO_MAX_BYTES = 5 * 1024 * 1024; // foto do WhatsApp tem 25–60 KB
const BACKOFF_MIN = [10, 60, 360, 1440, 1440];
const MANUAL_REVER_DIAS = 3650;        // `manual` nao volta pela fila (o claim ja exclui); data so pra constar

type Linha = {
  id: number; location_id: string; contact_id: string; conversation_id: string | null; jid: string;
  instance_name: string; is_group: boolean; status: string; wa_photo_path: string | null; ghl_url: string | null;
  tentativas: number;
};
type Config = { mode: string; per_instance: number; recheck_hours: number };
type Resultado = { id: number; contato: string; instancia: string; acao: string; detalhe?: string };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const curto = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);

async function fotoNoWhatsApp(instancia: string, jid: string): Promise<{ ok: true; url: string | null } | { ok: false; erro: string }> {
  try {
    const r = await fetch(`${EVOLUTION}/chat/fetchProfilePictureUrl/${encodeURIComponent(instancia)}`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: EVO_KEY },
      body: JSON.stringify({ number: jid }), signal: AbortSignal.timeout(20_000),
    });
    const t = await r.text();
    if (!r.ok) return { ok: false, erro: `evolution ${r.status}: ${curto(t, 200)}` };
    let d: any;
    try { d = JSON.parse(t); } catch { return { ok: false, erro: `evolution: resposta nao-JSON (${curto(t, 100)})` }; }
    const url = typeof d?.profilePictureUrl === "string" && /^https?:\/\//.test(d.profilePictureUrl) ? d.profilePictureUrl : null;
    return { ok: true, url };
  } catch (e) { return { ok: false, erro: `evolution: ${(e as Error).message}` }; }
}

async function contatoNaGHL(token: string, id: string): Promise<{ status: number; contato?: any; erro?: string }> {
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${id}`, {
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION_V2, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const t = await r.text();
    if (!r.ok) return { status: r.status, erro: curto(t, 200) };
    return { status: r.status, contato: JSON.parse(t)?.contact ?? null };
  } catch (e) { return { status: 0, erro: (e as Error).message }; }
}

async function subirImagem(token: string, locationId: string, conversaId: string, bytes: ArrayBuffer, mime: string, nome: string): Promise<{ url?: string; erro?: string }> {
  try {
    const fd = new FormData();
    fd.append("fileAttachment", new Blob([bytes], { type: mime }), nome);
    fd.append("conversationId", conversaId);
    fd.append("locationId", locationId);
    const r = await fetch(`${GHL_BASE}/conversations/messages/upload`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION_V1 }, body: fd,
      signal: AbortSignal.timeout(30_000),
    });
    const t = await r.text();
    if (!r.ok) return { erro: `upload ${r.status}: ${curto(t, 200)}` };
    const url = Object.values(JSON.parse(t)?.uploadedFiles ?? {})[0];
    return typeof url === "string" && url ? { url } : { erro: `upload sem url: ${curto(t, 200)}` };
  } catch (e) { return { erro: `upload: ${(e as Error).message}` }; }
}

async function gravarFoto(token: string, contatoId: string, url: string): Promise<{ ok: boolean; erro?: string }> {
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${contatoId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION_V2, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ profilePhoto: url }), signal: AbortSignal.timeout(20_000),
    });
    const t = await r.text();
    if (!r.ok) return { ok: false, erro: `PUT profilePhoto ${r.status}: ${curto(t, 200)}` };
    // campo nao documentado: se a resposta trouxer o contato, confere que ficou
    let d: any = null;
    try { d = JSON.parse(t); } catch { /* sem corpo */ }
    const gravada = d?.contact && "profilePhoto" in d.contact ? d.contact.profilePhoto : undefined;
    if (gravada !== undefined && gravada !== url) return { ok: false, erro: `PUT 200 mas profilePhoto = ${curto(String(gravada), 120)}` };
    return { ok: true };
  } catch (e) { return { ok: false, erro: `PUT profilePhoto: ${(e as Error).message}` }; }
}

async function gravar(sb: SupabaseClient, id: number, campos: Record<string, unknown>) {
  const { error } = await sb.from("contact_photos")
    .update({ ...campos, claimed_until: null, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) console.error(`[foto] gravar linha ${id} falhou: ${error.message}`);
}

async function processar(sb: SupabaseClient, cfg: Config, l: Linha, tokenDe: (loc: string) => Promise<string | null>): Promise<Resultado> {
  const agora = new Date();
  const base = { id: l.id, contato: l.contact_id, instancia: l.instance_name };
  const proxima = new Date(agora.getTime() + cfg.recheck_hours * 3600_000).toISOString();
  const ok = (acao: string, campos: Record<string, unknown>, detalhe?: string): Promise<Resultado> =>
    gravar(sb, l.id, { erro: null, tentativas: 0, checked_at: agora.toISOString(), next_check_at: proxima, ...campos })
      .then(() => ({ ...base, acao, detalhe }));
  const falhar = async (erro: string, definitivo = false): Promise<Resultado> => {
    const t = definitivo ? 99 : l.tentativas + 1;
    const min = BACKOFF_MIN[Math.min(t, BACKOFF_MIN.length) - 1];
    await gravar(sb, l.id, {
      status: "erro", erro: curto(erro, 500), tentativas: t, checked_at: agora.toISOString(),
      next_check_at: new Date(agora.getTime() + min * 60_000).toISOString(),
    });
    return { ...base, acao: "erro", detalhe: erro };
  };

  // 1. foto no WhatsApp
  const foto = await fotoNoWhatsApp(l.instance_name, l.jid);
  if (!foto.ok) return falhar(foto.erro);
  if (!foto.url) return ok("sem_foto", { status: "sem_foto" });   // GHL fica com a ultima (decisao do Luan)
  let caminho: string;
  try { caminho = new URL(foto.url).pathname; } catch { return falhar(`url invalida: ${curto(foto.url, 120)}`); }
  if (caminho === l.wa_photo_path && l.ghl_url) return ok("igual", { status: "ok" });

  // 2. contato na GHL: so mexe na foto que NOS gravamos
  const token = await tokenDe(l.location_id);
  if (!token) return falhar("sem token da GHL para a subconta");
  const c = await contatoNaGHL(token, l.contact_id);
  if (c.status === 404 || (c.status === 400 && /not found/i.test(c.erro ?? ""))) return falhar(`contato nao existe mais na GHL (${c.status})`, true);
  if (!c.contato) return falhar(`GET contato ${c.status}: ${c.erro ?? "sem corpo"}`);
  const atual: string | null = c.contato.profilePhoto || null;
  if (atual && atual !== l.ghl_url) {
    await gravar(sb, l.id, {
      status: "manual", erro: curto(`foto posta por outra via: ${atual}`, 500), tentativas: 0,
      checked_at: agora.toISOString(), next_check_at: new Date(agora.getTime() + MANUAL_REVER_DIAS * 86400_000).toISOString(),
    });
    return { ...base, acao: "manual" };
  }

  // 3. conversa para o upload (a receive manda; se faltar, a mais recente do contato)
  let conversaId = l.conversation_id;
  if (!conversaId) {
    const { data } = await sb.from("conversations").select("homio_id").eq("contact_id", l.contact_id)
      .not("homio_id", "is", null).order("updated_at", { ascending: false }).limit(1);
    conversaId = (data?.[0] as any)?.homio_id ?? null;
  }
  if (!conversaId) return falhar("sem conversa na GHL para o upload");

  // 4. baixa, sobe e grava
  let bytes: ArrayBuffer, mime: string;
  try {
    const r = await fetch(foto.url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return falhar(`download da foto ${r.status}`);
    mime = (r.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
    if (!mime.startsWith("image/")) return falhar(`download devolveu ${mime}`);
    bytes = await r.arrayBuffer();
  } catch (e) { return falhar(`download da foto: ${(e as Error).message}`); }
  if (bytes.byteLength > FOTO_MAX_BYTES) return falhar(`foto de ${bytes.byteLength} bytes passa do teto`, true);
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const up = await subirImagem(token, l.location_id, conversaId, bytes, mime, `foto-whatsapp-${l.contact_id}.${ext}`);
  if (!up.url) return falhar(up.erro ?? "upload falhou");
  const put = await gravarFoto(token, l.contact_id, up.url);
  if (!put.ok) return falhar(put.erro ?? "PUT falhou");
  return ok(l.wa_photo_path ? "trocada" : "gravada",
    { status: "ok", wa_photo_path: caminho, ghl_url: up.url, conversation_id: conversaId }, `${bytes.byteLength} bytes`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  const sb: SupabaseClient = getSupabase();
  const { data: esperado, error: tokErr } = await sb.rpc("instance_watch_token");
  if (tokErr || !esperado) return json({ ok: false, error: "token de vigia indisponivel" }, 500);
  if ((req.headers.get("x-watch-token") ?? "") !== esperado) return json({ ok: false, error: "unauthorized" }, 401);

  const inicio = Date.now();
  const so = new URL(req.url).searchParams.get("contactId");
  const { data: cfg } = await sb.from("contact_photo_config").select("mode, per_instance, recheck_hours").eq("id", 1).maybeSingle();
  if (!cfg || cfg.mode === "off") return json({ ok: true, mode: cfg?.mode ?? "sem_config", processadas: 0 });

  let linhas: Linha[] = [];
  if (so) {
    const { data, error } = await sb.from("contact_photos").select("*").eq("contact_id", so).neq("status", "manual");
    if (error) return json({ ok: false, error: error.message }, 500);
    linhas = (data ?? []) as Linha[];
  } else {
    const { data, error } = await sb.rpc("contact_photo_claim", { p_per_instance: cfg.per_instance, p_total: MAX_POR_RODADA });
    if (error) return json({ ok: false, error: error.message }, 500);
    linhas = (data ?? []) as Linha[];
  }
  if (!linhas.length) return json({ ok: true, mode: cfg.mode, processadas: 0 });

  const tokens = new Map<string, Promise<string | null>>();
  const tokenDe = (loc: string) => {
    if (!tokens.has(loc)) tokens.set(loc, getGHLToken(sb, loc).catch(() => null));
    return tokens.get(loc)!;
  };

  // instancias em paralelo; dentro de cada uma, uma consulta por vez
  const porInstancia = new Map<string, Linha[]>();
  for (const l of linhas) porInstancia.set(l.instance_name, [...(porInstancia.get(l.instance_name) ?? []), l]);
  const resultados: Resultado[] = [];
  const sobra: number[] = [];
  await Promise.all([...porInstancia.values()].map(async (fila) => {
    for (let i = 0; i < fila.length; i++) {
      if (Date.now() - inicio > ORCAMENTO_MS) { sobra.push(...fila.slice(i).map((l) => l.id)); return; }
      try { resultados.push(await processar(sb, cfg as Config, fila[i], tokenDe)); }
      catch (e) {
        console.error(`[foto] linha ${fila[i].id}: ${(e as Error).message}`);
        resultados.push({ id: fila[i].id, contato: fila[i].contact_id, instancia: fila[i].instance_name, acao: "excecao", detalhe: (e as Error).message });
        await gravar(sb, fila[i].id, {});   // solta a trava; volta na proxima rodada
      }
      if (i < fila.length - 1) await dormir(PAUSA_MS);
    }
  }));
  if (sobra.length) await sb.from("contact_photos").update({ claimed_until: null }).in("id", sobra);

  const porAcao: Record<string, number> = {};
  for (const r of resultados) porAcao[r.acao] = (porAcao[r.acao] ?? 0) + 1;
  console.log(`[foto] ${resultados.length} em ${Date.now() - inicio} ms ${JSON.stringify(porAcao)}${sobra.length ? ` (${sobra.length} voltaram pra fila)` : ""}`);
  return json({ ok: true, mode: cfg.mode, processadas: resultados.length, porAcao, sobra: sobra.length, resultados: resultados.slice(0, 50) });
});
