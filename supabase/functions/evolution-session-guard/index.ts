// evolution-session-guard — devolve a sessao que a Evolution apagou numa onda, sem fork e sem QR (2026-11-03).
//
// A Evolution 2.3.7 grava credencial virgem (initAuthCreds) por cima da real quando a leitura no banco falha
// numa reconexao em massa (wiki: debug_queda_em_massa_evolution_qr). No Postgres dela (DigitalOcean) ha um
// gatilho nosso, schema homio_guard: `session_last_good` guarda a ultima credencial real de cada instancia e
// `session_overwrites` registra cada real -> virgem. Esta funcao le essa fila, grava a credencial guardada de
// volta e reconecta: `GET /instance/connect` se a instancia estiver `close`, `POST /instance/restart` se nao
// (o restart e POST; PUT da 404). Wiki: processos/processo_restaurar_sessao_evolution.md.
//
// POST header x-watch-token (= public.instance_watch_token(); o cron chama de dentro do banco)
//   ?dryRun=1          diz o que faria, sem gravar nada nem avisar
//   ?restaurar=<nome>  restaura essa instancia agora, mesmo sem sobrescrita registrada (ignora SESSION_GUARD_AUTO)
// Secrets: EVO_DB_URI_GUARD (usuario homio_guard do banco da Evolution); SESSION_GUARD_AUTO=off -> so avisa.
// Cron a cada 2 min. Uma instancia por rodada, so 3 min depois da sobrescrita (na onda o banco ainda esta engasgado).
import { Client } from "jsr:@db/postgres@0.19.5";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const EVOLUTION = (Deno.env.get("EVOLUTION_API_URL") ?? "https://whatsapp.homio.com.br").replace(/\/+$/, "");
const EVO_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? "";
const AUTO = (Deno.env.get("SESSION_GUARD_AUTO") ?? "on") !== "off";
const ESPERA_MIN = 3;
const MAX_TENTATIVAS = 4;      // por instancia, em 24 h (ate 2 restarts em `connecting` + connects em `close`)
const CREDENCIAL_REAL = 1400;  // virgem tem 1.248–1.250 caracteres; real, 2.200–5.300
// aviso: mesmo caminho dos vigias (instance-down-watch)
const INSTANCIA_AVISO = Deno.env.get("RESTRICTION_ALERT_INSTANCE") ?? "sTzec3aUgGdmWIlduwGM-1"; // numero da Homio
const GRUPO = Deno.env.get("RESTRICTION_ALERT_GROUP") ?? "120363432652591332@g.us"; // "Homio - Avisos"
const AVISO_LOCATION = Deno.env.get("RESTRICTION_ALERT_LOCATION") ?? "sTzec3aUgGdmWIlduwGM";
const AVISO_CONTATO = Deno.env.get("RESTRICTION_ALERT_CONTACT") ?? "QC9sh5hJWFQ1eKCpdr5x";
// CA do projeto na DigitalOcean (publica; e a do "Download CA certificate" do cluster evolution-api). Vale ate 2035.
const DO_CA = `-----BEGIN CERTIFICATE-----
MIIETTCCArWgAwIBAgIUcaZtCgjXxwukrUAhowaBUN0ouN8wDQYJKoZIhvcNAQEM
BQAwQDE+MDwGA1UEAww1MmNkNjY4NjktMjVjZC00YjIzLTg5YWYtN2M1MTU3NGZi
YzBlIEdFTiAxIFByb2plY3QgQ0EwHhcNMjUwNTE5MTkwNDUyWhcNMzUwNTE3MTkw
NDUyWjBAMT4wPAYDVQQDDDUyY2Q2Njg2OS0yNWNkLTRiMjMtODlhZi03YzUxNTc0
ZmJjMGUgR0VOIDEgUHJvamVjdCBDQTCCAaIwDQYJKoZIhvcNAQEBBQADggGPADCC
AYoCggGBALC7AQUSanhMGhMblKpMcaNbQd+WwDPV0vxBkZTiVdGt+SMT4sRJBxej
3bDe67bZsqR2Lv4kCPbh5Q+K0xLfgdV6UUDMC7PApirO/9f7IUaKNnJJDD08Rotv
aRbs2ebzMXEKQo8j+Tp0T5MmBCHjMaxaesvDDTifPV89KlG2pmgHmYJyJ41j4wa2
udVc0yHXX4hg3deAbHtz1WFvioqjUWbyI/j0XRJKdw8uBFW+138tg0WwHBM57s5f
9QKwfIU9tpWDjPQP/8ajwTGNe4xJIANcZt+szdviFTye1p1yQDNKb0HX2B60Q7AO
VDO98QQfYoAcNV78mFeiT+nuiYxruitvOL8Uxx9XRwrU0CIXA8IXE7IkmmX9wPZS
pZyPTOjD/w+1BNrfpYMylVFiAptchaAhe9iYWcmOaPeZad77Nso/UIi91JcyO0YK
EqNFzdN0IDZrmK2Sua88t65W1TFYwH6oa5i3RVo51kD58iCm0MUYzBKqCvKwvlYD
l6nCjKmt9wIDAQABoz8wPTAdBgNVHQ4EFgQUZYMR1K4bMpi1LIWY63YbcBFGRp8w
DwYDVR0TBAgwBgEB/wIBADALBgNVHQ8EBAMCAQYwDQYJKoZIhvcNAQEMBQADggGB
AJ9YKHJacX4TYFMWxpQPCZ6+VAEwBdZfrqxOoLhBTyj22eKIxgEkElLBY7at/n+j
xAsPM+AfJcRLiSlOgkXlFdN8lfxO1UotJ5eVR+sQIN9Im0uso0vv8FhzJIzW1DBg
xtGN1MrD8qU64zZz5l5X9PDcH4wVRKZEyQWJzd2JtmkEsJckqPtVi6d4uurnkRs9
3OHmEz4dRMSNKMAWdfiJfwp13s8g+qwZH51XWbfwa2j66UXJQwgoHRLOZusNBWlO
o+b3D4DmFaPtnPIvyIZJAYkH1J4sjlBpLVnSnBJWLUC3Na+mgLAYIz3YcWIimGZ2
rDN1Ae+fkaNvU4OVqV+n4JcTSnDKWV2NrXLuE9ihmdEj42P6KuG/8OgHdhjHIE6H
WmoMVOzVSPUY3RY3Ck1Djowg2JumQbUl1SLMZO47vwkPWftsWvspv0YUCYGjr4Ke
OKkyyG10IwbeBo6X3n4rNRdUhpzMhXKjF3vafhPmnxk2AqBcpdcr5yHaNY7dvHhu
Wg==
-----END CERTIFICATE-----`;

type Linha = { id: number; session_id: string; instance_name: string | null; at: Date; avisado_em: Date | null };
type Alvo = { session_id: string; nome: string | null; ids: number[]; at: Date | null };
type Resultado = { linha: string; aviso?: string; mexeu: boolean };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const fmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});
const brt = (d: Date) => fmt.format(d).replace(",", "");
const numero = (meId: string | null) => (meId ?? "").split(/[:@]/)[0];
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function evo(method: string, path: string): Promise<{ status: number; body: unknown }> {
  try {
    const r = await fetch(`${EVOLUTION}${path}`, {
      method, headers: { apikey: EVO_KEY }, signal: AbortSignal.timeout(20_000),
    });
    const t = await r.text();
    let body: unknown = t;
    try { body = JSON.parse(t); } catch { /* texto */ }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: String((e as Error)?.message ?? e) };
  }
}

async function estado(nome: string): Promise<string> {
  const r = await evo("GET", `/instance/connectionState/${encodeURIComponent(nome)}`);
  // deno-lint-ignore no-explicit-any
  return (r.body as any)?.instance?.state ?? `http_${r.status}`;
}

async function restaurar(db: Client, a: Alvo, dryRun: boolean, manual: boolean): Promise<Resultado> {
  const fechar = async (resultado: string) => {
    if (dryRun || !a.ids.length) return;
    await db.queryArray`update homio_guard.session_overwrites set restaurado_em = now(), resultado = ${resultado}
      where id = any(${a.ids}::bigint[])`;
  };
  const inst = await db.queryObject<{ name: string }>`select "name" from public."Instance" where id = ${a.session_id}`;
  const nome = inst.rows[0]?.name;
  if (!nome) { await fechar("instancia_apagada"); return { linha: `${a.session_id}: instancia apagada`, mexeu: false }; }

  const ses = await db.queryObject<{ len: number | null }>`
    select length(creds) as len from public."Session" where "sessionId" = ${a.session_id}`;
  if (!ses.rows.length) {
    // a Evolution apagou a Session (401 de verdade ou logout): o aparelho saiu do celular, so QR
    await fechar("sem_session");
    return { linha: `${nome}: sem Session (aparelho desvinculado)`, mexeu: false };
  }
  if (Number(ses.rows[0].len ?? 0) >= CREDENCIAL_REAL) {
    await fechar("ja_real");
    return { linha: `${nome}: credencial ja e real (releu o QR ou voltou sozinha)`, mexeu: false };
  }
  const guarda = await db.queryObject<{ creds: string; me_id: string | null; saved_at: Date }>`
    select creds, me_id, saved_at from homio_guard.session_last_good where session_id = ${a.session_id}`;
  const g = guarda.rows[0];
  if (!g) {
    await fechar("sem_guarda");
    return { linha: `${nome}: sem credencial guardada`, aviso: `⚠️ *${nome}* perdeu a sessão e não há credencial guardada: só QR.`, mexeu: false };
  }

  const tent = await db.queryObject<{ n: number }>`
    select coalesce(sum(tentativas), 0)::int as n from homio_guard.session_overwrites
    where session_id = ${a.session_id} and at > now() - interval '24 hours'`;
  const feitas = Number(tent.rows[0]?.n ?? 0);
  const antes = await estado(nome);
  if (!manual && feitas >= MAX_TENTATIVAS) {
    await fechar(`desistiu_${feitas}_tentativas`);
    return {
      linha: `${nome}: ${feitas} tentativas em 24 h, desisti`,
      aviso: `❌ *${nome}* não voltou com a credencial guardada depois de ${feitas} tentativas (${antes}). Precisa QR na página de conexão.`,
      mexeu: false,
    };
  }
  // Em `connecting` (ainda no ciclo de QR) so da `restart`, que nao foi provado aqui. Duas tentativas e depois
  // espera o limite de QR deixar a instancia `close` (~40 min), onde o `connect` relê a credencial (10/10 em 16/10).
  if (!manual && antes !== "close" && antes !== "open" && feitas >= 2) {
    return { linha: `${nome}: ${feitas} restarts sem voltar; esperando ficar close para tentar pelo connect`, mexeu: false };
  }
  const desc = `${nome} (${numero(g.me_id)}), estado ${antes}, credencial guardada em ${brt(g.saved_at)}`;
  if (dryRun) return { linha: `restauraria ${desc}`, mexeu: false };
  if (!AUTO && !manual) return { linha: `restauracao automatica desligada: ${desc}`, mexeu: false };

  if (a.ids.length) {
    await db.queryArray`update homio_guard.session_overwrites set tentativas = tentativas + 1 where id = any(${a.ids}::bigint[])`;
  }
  const up = await db.queryArray`update public."Session" set creds = ${g.creds}
    where "sessionId" = ${a.session_id} and length(creds) < ${CREDENCIAL_REAL}`;
  if (!up.rowCount) { await fechar("ja_real"); return { linha: `${nome}: virou real antes de gravar`, mexeu: false }; }

  if (antes === "open") {
    // em memoria a sessao e a real; so o banco estava virgem. Gravar ja protege o proximo restart.
    await fechar("gravada_aberta");
    return { linha: `${nome}: estava open, credencial regravada no banco`, mexeu: true };
  }
  const acao = antes === "close"
    ? await evo("GET", `/instance/connect/${encodeURIComponent(nome)}`)
    : await evo("POST", `/instance/restart/${encodeURIComponent(nome)}`);
  let depois = antes;
  for (let i = 0; i < 15 && depois !== "open"; i++) {
    await dormir(3000);
    depois = await estado(nome);
  }
  if (depois === "open") {
    await fechar("restaurada");
    return {
      linha: `${nome}: restaurada (${antes} -> open)`,
      aviso: `✅ *Sessão restaurada sem QR:* ${nome} · ${numero(g.me_id)} (estava ${antes})`,
      mexeu: true,
    };
  }
  const total = feitas + 1;
  if (manual) {
    await fechar(`falhou_${depois}`);
    return {
      linha: `${nome}: nao voltou (${depois}) depois de ${total} tentativa(s); acao ${acao.status}`,
      aviso: `❌ *${nome}* · ${numero(g.me_id)} não voltou com a credencial guardada (${depois}). ` +
        `O aparelho pode ter sido desvinculado no celular: precisa QR na página de conexão.`,
      mexeu: true,
    };
  }
  return { linha: `${nome}: tentativa ${total} sem open (${depois}, acao ${acao.status}); tenta de novo`, mexeu: true };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const { data: esperado, error: tokErr } = await sb.rpc("instance_watch_token");
  if (tokErr || !esperado) return json({ ok: false, error: "token indisponivel" }, 500);
  if ((req.headers.get("x-watch-token") ?? "") !== esperado) return json({ ok: false, error: "unauthorized" }, 401);

  const uri = Deno.env.get("EVO_DB_URI_GUARD");
  if (!uri) return json({ ok: false, error: "EVO_DB_URI_GUARD ausente" }, 500);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const manual = url.searchParams.get("restaurar");

  const u = new URL(uri);
  const db = new Client({
    hostname: u.hostname, port: Number(u.port || 25060), database: u.pathname.slice(1) || "defaultdb",
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    tls: { enabled: true, enforce: true, caCertificates: [DO_CA] }, connection: { attempts: 1 },
  });
  const log: string[] = [];
  const avisos: string[] = [];
  try {
    await db.connect();
    await db.queryArray`set statement_timeout = '20s'`;
    const lock = await db.queryObject<{ ok: boolean }>`select pg_try_advisory_lock(727001) as ok`;
    if (!lock.rows[0]?.ok) return json({ ok: true, skipped: "outra rodada em andamento" });

    let alvos: Alvo[] = [];
    if (manual) {
      const r = await db.queryObject<{ id: string }>`select id from public."Instance" where "name" = ${manual}`;
      if (!r.rows.length) return json({ ok: false, error: `instancia ${manual} nao existe na Evolution` }, 404);
      const pend = await db.queryObject<{ id: number }>`select id from homio_guard.session_overwrites
        where session_id = ${r.rows[0].id} and restaurado_em is null`;
      alvos = [{ session_id: r.rows[0].id, nome: manual, ids: pend.rows.map((x) => Number(x.id)), at: null }];
    } else {
      const fila = await db.queryObject<Linha>`select id, session_id, instance_name, at, avisado_em
        from homio_guard.session_overwrites where restaurado_em is null and at > now() - interval '7 days' order by at`;
      const novas = fila.rows.filter((l) => !l.avisado_em);
      if (novas.length && !dryRun) {
        const nomes = [...new Set(novas.map((l) => l.instance_name ?? l.session_id))];
        avisos.push(
          `🛡️ *Evolution apagou a sessão de ${nomes.length} instância(s)* (${brt(novas[0].at)})\n` +
            nomes.map((n) => `• ${n}`).join("\n") + "\n" +
            (AUTO
              ? `A credencial boa está guardada; a restauração começa ${ESPERA_MIN} min depois, uma por vez.`
              : "Restauração automática desligada (SESSION_GUARD_AUTO=off): restaurar com ?restaurar=<nome>."),
        );
        await db.queryArray`update homio_guard.session_overwrites set avisado_em = now()
          where id = any(${novas.map((l) => Number(l.id))}::bigint[])`;
      }
      const porSessao = new Map<string, Alvo>();
      for (const l of fila.rows) {
        const a = porSessao.get(l.session_id) ?? { session_id: l.session_id, nome: l.instance_name, ids: [], at: l.at };
        a.ids.push(Number(l.id));
        if (l.at > (a.at ?? l.at)) a.at = l.at;
        porSessao.set(l.session_id, a);
      }
      // o numero dos avisos primeiro: sem ele, o resto dos avisos nao chega
      alvos = [...porSessao.values()].sort((x, y) => Number(y.nome === INSTANCIA_AVISO) - Number(x.nome === INSTANCIA_AVISO));
    }

    const limite = Date.now() - ESPERA_MIN * 60_000;
    for (const a of alvos) {
      if (!manual && a.at && a.at.getTime() > limite) { log.push(`${a.nome}: esperando ${ESPERA_MIN} min`); continue; }
      const r = await restaurar(db, a, dryRun, Boolean(manual));
      log.push(r.linha);
      if (r.aviso) avisos.push(r.aviso);
      if (r.mexeu) break; // uma por rodada
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    console.error("[session-guard]", msg);
    log.push(`erro: ${msg}`);
  } finally {
    await db.end().catch(() => {});
  }

  if (avisos.length && !dryRun) await enviar(sb, avisos.join("\n\n"));
  console.log(`[session-guard] auto=${AUTO} dryRun=${dryRun} ${log.join(" | ") || "nada a fazer"}`);
  return json({ ok: true, auto: AUTO, dryRun, log, avisos });
});

// Mesmo caminho do instance-down-watch: 1º pela GHL (aparece na conversa do grupo), senao direto na Evolution.
// deno-lint-ignore no-explicit-any
async function enviar(sb: any, texto: string): Promise<void> {
  let res: { status: number; erro: string | null } | null = null;
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  try {
    const g = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-message-api`, {
      method: "POST",
      headers: { Authorization: `Bearer ${anon}`, apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({ locationId: AVISO_LOCATION, contactId: AVISO_CONTATO, message: texto }),
      signal: AbortSignal.timeout(20_000),
    });
    if (g.ok) res = { status: g.status, erro: null };
    else console.error(`[session-guard] aviso pela GHL falhou: ${g.status} ${(await g.text()).slice(0, 200)}`);
  } catch (e) {
    console.error("[session-guard] aviso pela GHL falhou:", String((e as Error)?.message ?? e).slice(0, 200));
  }
  if (!res) {
    const { data: inst } = await sb.from("instances").select("instance_api_key").eq("evolution_name", INSTANCIA_AVISO).maybeSingle();
    const chave = (inst as { instance_api_key?: string } | null)?.instance_api_key ?? EVO_KEY;
    try {
      const r = await fetch(`${EVOLUTION}/message/sendText/${INSTANCIA_AVISO}`, {
        method: "POST",
        headers: { apikey: chave, "Content-Type": "application/json" },
        body: JSON.stringify({ number: GRUPO, text: texto }),
        signal: AbortSignal.timeout(20_000),
      });
      res = { status: r.status, erro: r.ok ? null : (await r.text()).slice(0, 300) };
    } catch (e) {
      res = { status: 0, erro: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  }
  await sb.from("instance_watch_avisos").insert({ texto, status: res.status, erro: res.erro });
}
