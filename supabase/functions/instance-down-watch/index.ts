// instance-down-watch — avisa no grupo "Homio - Avisos" quando um WhatsApp Homio fica fora (regra nº 2 do
// vigia do Painel 360) e quando o GHL manda pelo canal Whats Homio sem instancia por tras.
// So alerta, nao mexe em instancia nem em envio. Cron a cada 30 min (pg_cron job instance-down-watch).
// Complementa o instance-restriction-watch (401): a queda com 401 aparece aqui marcada.
// Foto do momento vem da RPC instance_watch_snapshot. Wiki: projetos/painel_clientes_homio.md.
//
// POST  header x-watch-token (cron; chamar sempre de dentro do banco, com public.instance_watch_token())
//   ?dryRun=1   calcula e devolve o texto, sem gravar incidente nem mandar aviso (o nome da subconta fica guardado)
//   ?teste=1    so manda uma mensagem de teste no grupo
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { getGHLToken, getValidAgencyToken, GHL_BASE, GHL_VERSION_V2 } from "../_shared/ghl-auth.ts";
import {
  deveAbrirFora, FECHA_SEM_ERRO_D, type Fora, type Item, JANELA_SEM_INSTANCIA_H, LEMBRETE_H, montarAviso,
  type SemInstancia,
} from "./aviso.ts";

const EVOLUTION = (Deno.env.get("EVOLUTION_API_URL") ?? "https://whatsapp.homio.com.br").replace(/\/+$/, "");
const INSTANCIA_AVISO = Deno.env.get("RESTRICTION_ALERT_INSTANCE") ?? "sTzec3aUgGdmWIlduwGM-1"; // numero da Homio
const GRUPO = Deno.env.get("RESTRICTION_ALERT_GROUP") ?? "120363432652591332@g.us"; // "Homio - Avisos"

type Incidente = {
  id: number; chave: string; tipo: "fora" | "sem_instancia"; instance_name: string | null; location_id: string;
  perfil: string | null; numero: string | null; desde: string; ultimo_erro_em: string | null; erros: number;
  restricao: boolean; ultimo_aviso_em: string | null; aberto_em: string;
};
type Local = { location_id: string; nome: string | null; nome_tentado_em: string | null; vigiar: boolean };

const COLS = "id, chave, tipo, instance_name, location_id, perfil, numero, desde, ultimo_erro_em, erros, restricao, ultimo_aviso_em, aberto_em";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Nome da subconta na GHL: token da location e, sem ele, o da agencia. Null se a GHL nao responder. */
async function nomeDaGHL(sb: unknown, locationId: string): Promise<string | null> {
  // os helpers do _shared tipam o client pelo supabase-js@2 sem versao; o objeto e o mesmo
  // deno-lint-ignore no-explicit-any
  const c = sb as any;
  for (const pegar of [() => getGHLToken(c, locationId), () => getValidAgencyToken(c)]) {
    const token = await pegar().catch(() => null);
    if (!token) continue;
    try {
      const r = await fetch(`${GHL_BASE}/locations/${locationId}`, {
        headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION_V2, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) { console.log(`[down-watch] nome ${locationId}: ${r.status}`); continue; }
      const nome = (await r.json())?.location?.name;
      if (String(nome ?? "").trim()) return String(nome).trim();
    } catch (e) {
      console.log(`[down-watch] nome ${locationId}: ${String((e as Error)?.message ?? e)}`);
    }
  }
  return null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    const { data: esperado, error: tokErr } = await sb.rpc("instance_watch_token");
    if (tokErr || !esperado) return json({ ok: false, error: "token indisponivel" }, 500);
    if ((req.headers.get("x-watch-token") ?? "") !== esperado) return json({ ok: false, error: "unauthorized" }, 401);

    const enviar = async (texto: string): Promise<{ status: number; erro: string | null }> => {
      const { data: inst } = await sb.from("instances").select("instance_api_key")
        .eq("evolution_name", INSTANCIA_AVISO).maybeSingle();
      const chave = (inst as { instance_api_key?: string } | null)?.instance_api_key ?? Deno.env.get("EVOLUTION_API_KEY") ?? "";
      let res: { status: number; erro: string | null };
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
      await sb.from("instance_watch_avisos").insert({ texto, status: res.status, erro: res.erro });
      return res;
    };

    if (url.searchParams.get("teste") === "1") {
      const r = await enviar(
        "🧪 *Teste do vigia de WhatsApp fora*\nEste grupo passa a receber o aviso de WhatsApp Homio fora há mais de " +
          "2 h e de envio pelo canal Whats Homio sem instância. Nada a fazer com esta mensagem.",
      );
      return json({ ok: !r.erro, ...r });
    }

    const dryRun = url.searchParams.get("dryRun") === "1";
    const agoraMs = Date.now();
    const agora = new Date(agoraMs).toISOString();
    const venceu = (iso: string | null, h: number) => !iso || agoraMs - Date.parse(iso) >= h * 3600_000;

    const { data: snap, error: snapErr } = await sb.rpc("instance_watch_snapshot", {
      p_desde: new Date(agoraMs - JANELA_SEM_INSTANCIA_H * 3600_000).toISOString(),
    });
    if (snapErr) throw new Error(`snapshot: ${snapErr.message}`);
    const fora = (snap?.fora ?? []) as Fora[];
    const abertas = new Set((snap?.abertas ?? []) as string[]);
    const semInstancia = (snap?.sem_instancia ?? []) as SemInstancia[];

    const { data: incs, error: incErr } = await sb.from("instance_watch_incidents").select(COLS).is("fechado_em", null);
    if (incErr) throw new Error(`incidentes: ${incErr.message}`);
    const porChave = new Map(((incs ?? []) as Incidente[]).map((i) => [i.chave, i]));

    const { data: locs } = await sb.from("instance_watch_locations").select("location_id, nome, nome_tentado_em, vigiar");
    const locais = new Map(((locs ?? []) as Local[]).map((l) => [l.location_id, l]));
    const vigiar = (loc: string) => locais.get(loc)?.vigiar !== false;

    // ---------- decidir (nada gravado ainda) ----------
    type Abrir = { tipo: "fora" | "sem_instancia"; linha: Omit<Item, "nome">; registro: Record<string, unknown> };
    const abrir: Abrir[] = [];
    const atualizar: { inc: Incidente; campos: Record<string, unknown>; lembrete?: Omit<Item, "nome"> }[] = [];
    const fechar: { inc: Incidente; por: string; linha?: Omit<Item, "nome"> }[] = [];

    const foraPorNome = new Map(fora.map((f) => [f.instance_name, f]));
    for (const f of fora) {
      const inc = porChave.get(`fora:${f.instance_name}`);
      if (!vigiar(f.location_id)) { if (inc) fechar.push({ inc, por: "silenciada" }); continue; }
      const linha = {
        location_id: f.location_id, perfil: f.perfil, numero: f.numero, status: f.status,
        desde: inc?.desde ?? f.desde, erros: Math.max(inc?.erros ?? 0, f.erros ?? 0), restricao: !!(inc?.restricao || f.restricao),
      };
      if (inc) {
        const lembrar = venceu(inc.ultimo_aviso_em, LEMBRETE_H);
        atualizar.push({
          inc, lembrete: lembrar ? linha : undefined,
          campos: { erros: linha.erros, ultimo_erro_em: f.ultimo_erro_em ?? inc.ultimo_erro_em, restricao: linha.restricao, ...(lembrar ? { ultimo_aviso_em: agora } : {}) },
        });
      } else if (deveAbrirFora(f, agoraMs)) {
        abrir.push({
          tipo: "fora", linha,
          registro: {
            chave: `fora:${f.instance_name}`, tipo: "fora", instance_name: f.instance_name, location_id: f.location_id,
            perfil: f.perfil, numero: f.numero, desde: f.desde, ultimo_erro_em: f.ultimo_erro_em, erros: f.erros ?? 0,
            restricao: !!f.restricao, ultimo_aviso_em: agora,
          },
        });
      }
    }
    for (const inc of porChave.values()) {
      if (inc.tipo !== "fora" || foraPorNome.has(inc.instance_name ?? "")) continue;
      const como = abertas.has(inc.instance_name ?? "") ? "voltou" : "removida";
      fechar.push({
        inc, por: como,
        linha: vigiar(inc.location_id)
          ? { location_id: inc.location_id, perfil: inc.perfil, numero: inc.numero, desde: inc.desde, erros: inc.erros, como }
          : undefined,
      });
    }

    const semPorLoc = new Map(semInstancia.map((s) => [s.location_id, s]));
    for (const s of semInstancia) {
      const inc = porChave.get(`sem_instancia:${s.location_id}`);
      if (!vigiar(s.location_id)) { if (inc) fechar.push({ inc, por: "silenciada" }); continue; }
      if (!inc) {
        abrir.push({
          tipo: "sem_instancia",
          linha: { location_id: s.location_id, desde: s.primeiro, primeiro: s.primeiro, ultimo: s.ultimo, erros: s.erros, instancias: s.instancias },
          registro: {
            chave: `sem_instancia:${s.location_id}`, tipo: "sem_instancia", location_id: s.location_id,
            desde: s.primeiro, ultimo_erro_em: s.ultimo, erros: s.erros, ultimo_aviso_em: agora,
          },
        });
        continue;
      }
      const temNovo = Date.parse(s.ultimo) > Date.parse(inc.ultimo_erro_em ?? inc.desde);
      // lembra uma vez por dia, e so se houve erro depois do ultimo aviso
      const lembrar = venceu(inc.ultimo_aviso_em, LEMBRETE_H) && (!inc.ultimo_aviso_em || Date.parse(s.ultimo) > Date.parse(inc.ultimo_aviso_em));
      if (!temNovo && !lembrar) continue;
      let erros = inc.erros;
      if (temNovo) {
        const { count } = await sb.from("send_errors").select("id", { count: "exact", head: true })
          .eq("location_id", s.location_id).eq("error_type", "no_instance").gte("created_at", inc.desde);
        erros = count ?? inc.erros;
      }
      atualizar.push({
        inc,
        lembrete: lembrar ? { location_id: s.location_id, desde: inc.desde, ultimo: s.ultimo, erros, instancias: s.instancias } : undefined,
        campos: { erros, ultimo_erro_em: s.ultimo, ...(lembrar ? { ultimo_aviso_em: agora } : {}) },
      });
    }
    for (const inc of porChave.values()) {
      if (inc.tipo === "sem_instancia" && !semPorLoc.has(inc.location_id) && venceu(inc.ultimo_erro_em ?? inc.desde, FECHA_SEM_ERRO_D * 24)) {
        fechar.push({ inc, por: "sem_erro_7d" });
      }
    }

    // ---------- gravar (o incidente novo entra antes do aviso: rodadas sobrepostas nao avisam duas vezes) ----------
    const abertosAgora: Abrir[] = [];
    const avisadosIds: number[] = [];
    if (dryRun) {
      abertosAgora.push(...abrir);
    } else {
      for (const a of abrir) {
        const { data, error } = await sb.from("instance_watch_incidents").insert(a.registro).select("id").single();
        if (error) { if (error.code !== "23505") console.error(`[down-watch] abrir ${a.registro.chave}: ${error.message}`); continue; }
        abertosAgora.push(a);
        avisadosIds.push((data as { id: number }).id);
      }
      for (const u of atualizar) {
        await sb.from("instance_watch_incidents").update(u.campos).eq("id", u.inc.id);
        if (u.lembrete) avisadosIds.push(u.inc.id);
      }
      for (const f of fechar) {
        await sb.from("instance_watch_incidents").update({ fechado_em: agora, fechado_por: f.por }).eq("id", f.inc.id);
      }
    }

    // ---------- nomes das subcontas que vao aparecer no aviso ----------
    const linhas = [
      ...abertosAgora.map((a) => a.linha), ...atualizar.flatMap((u) => (u.lembrete ? [u.lembrete] : [])),
      ...fechar.flatMap((f) => (f.linha ? [f.linha] : [])),
    ];
    const buscar = [...new Set(linhas.map((l) => l.location_id))].filter((loc) => {
      const l = locais.get(loc);
      return !l?.nome && venceu(l?.nome_tentado_em ?? null, 24);
    });
    for (let i = 0; i < buscar.length; i += 4) {
      await Promise.all(buscar.slice(i, i + 4).map(async (loc) => {
        const nome = await nomeDaGHL(sb, loc);
        locais.set(loc, { location_id: loc, nome, nome_tentado_em: agora, vigiar: locais.get(loc)?.vigiar ?? true });
        await sb.from("instance_watch_locations").upsert({ location_id: loc, nome, nome_tentado_em: agora }, { onConflict: "location_id" });
      }));
    }
    const comNome = (l: Omit<Item, "nome">): Item => ({ ...l, nome: locais.get(l.location_id)?.nome ?? l.location_id });

    const texto = montarAviso({
      novosFora: abertosAgora.filter((a) => a.tipo === "fora").map((a) => comNome(a.linha)),
      novosSem: abertosAgora.filter((a) => a.tipo === "sem_instancia").map((a) => comNome(a.linha)),
      lembretesFora: atualizar.filter((u) => u.lembrete && u.inc.tipo === "fora").map((u) => comNome(u.lembrete!)),
      lembretesSem: atualizar.filter((u) => u.lembrete && u.inc.tipo === "sem_instancia").map((u) => comNome(u.lembrete!)),
      voltaram: fechar.flatMap((f) => (f.linha ? [comNome(f.linha)] : [])),
      agora,
    });

    const resumo = {
      fora: fora.length, abertos: abertosAgora.length, atualizados: atualizar.length, fechados: fechar.length,
      lembretes: atualizar.filter((u) => u.lembrete).length,
    };
    if (dryRun) return json({ ok: true, dryRun: true, ...resumo, texto: texto || null });

    let aviso: { status: number; erro: string | null } | null = null;
    if (texto) {
      aviso = await enviar(texto);
      // aviso que nao saiu: o incidente fica com aviso pendente e entra como lembrete na proxima rodada
      if (aviso.erro && avisadosIds.length) {
        await sb.from("instance_watch_incidents").update({ ultimo_aviso_em: null }).in("id", avisadosIds);
      }
      console.log(`[down-watch] aviso ${aviso.erro ? `falhou ${aviso.status}: ${aviso.erro}` : "enviado"}`);
    }
    return json({ ok: true, ...resumo, aviso });
  } catch (e) {
    console.error(`[down-watch] erro: ${String((e as Error)?.message ?? e)}`);
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
