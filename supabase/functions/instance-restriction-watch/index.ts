// instance-restriction-watch — avisa no grupo "Homio - Avisos" quando uma instancia cai com 401
// (WhatsApp deslogou o dispositivo vinculado: restricao, banimento ou logout).
// So alerta, nao pausa envio. Cron a cada 5 min (pg_cron job instance-restriction-watch).
// Regra: avisa se nao voltou a abrir em 10 min OU se ja houve outro 401 nas 24 h anteriores.
// Contexto das 24 h antes da queda vem da RPC restriction_watch_candidates.
// Wiki: debug/debug_restricao_temporaria_whatsapp.md
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { type Candidato, deveAvisar, ESPERA_MIN, montarAviso } from "./aviso.ts";

const EVOLUTION = (Deno.env.get("EVOLUTION_API_URL") ?? "https://whatsapp.homio.com.br").replace(/\/+$/, "");
const INSTANCIA_AVISO = Deno.env.get("RESTRICTION_ALERT_INSTANCE") ?? "sTzec3aUgGdmWIlduwGM-1"; // numero da Homio
const GRUPO = Deno.env.get("RESTRICTION_ALERT_GROUP") ?? "120363432652591332@g.us"; // "Homio - Avisos"

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    const { data: esperado, error: tokErr } = await sb.rpc("restriction_watch_token");
    if (tokErr || !esperado) return json({ ok: false, error: "token indisponivel" }, 500);
    if ((req.headers.get("x-watch-token") ?? "") !== esperado) return json({ ok: false, error: "unauthorized" }, 401);

    const enviar = async (texto: string): Promise<{ status: number; erro: string | null }> => {
      const { data: inst } = await sb.from("instances").select("instance_api_key")
        .eq("evolution_name", INSTANCIA_AVISO).maybeSingle();
      const chave = inst?.instance_api_key ?? Deno.env.get("EVOLUTION_API_KEY") ?? "";
      try {
        const r = await fetch(`${EVOLUTION}/message/sendText/${INSTANCIA_AVISO}`, {
          method: "POST",
          headers: { apikey: chave, "Content-Type": "application/json" },
          body: JSON.stringify({ number: GRUPO, text: texto }),
          signal: AbortSignal.timeout(20_000),
        });
        return { status: r.status, erro: r.ok ? null : (await r.text()).slice(0, 300) };
      } catch (e) {
        return { status: 0, erro: String((e as Error)?.message ?? e).slice(0, 300) };
      }
    };

    if (url.searchParams.get("teste") === "1") {
      const r = await enviar(
        "🧪 *Teste do vigia de restrição*\nEste grupo passa a receber o aviso de WhatsApp Homio que cai com 401 " +
          "(possível restrição ou banimento), com o volume das 24 h anteriores. Nada a fazer com esta mensagem.",
      );
      return json({ ok: !r.erro, ...r });
    }

    const dryRun = url.searchParams.get("dryRun") === "1";
    // lookback maior so em dryRun (teste sobre historico)
    const lookbackH = dryRun ? Math.min(Number(url.searchParams.get("lookbackHours") ?? 24) || 24, 24 * 14) : 24;

    const { data, error } = await sb.rpc("restriction_watch_candidates", {
      p_since: "-infinity", p_wait: `${ESPERA_MIN} minutes`, p_lookback: `${lookbackH} hours`,
    });
    if (error) throw new Error(`candidatos: ${error.message}`);
    const candidatos = (data ?? []) as Candidato[];

    if (dryRun) {
      return json({
        ok: true, dryRun: true, total: candidatos.length,
        itens: candidatos.map((c) => ({ event_id: c.event_id, instance: c.instance_name, avisar: deveAvisar(c), texto: deveAvisar(c) ? montarAviso(c) : null })),
      });
    }

    let avisados = 0, registrados = 0;
    for (const c of candidatos) {
      const avisar = deveAvisar(c);
      const texto = avisar ? montarAviso(c) : null;
      const stats = {
        api_sends: c.api_sends, api_dest: c.api_dest, device_sends: c.device_sends,
        device_sources: c.device_sources, inbound: c.inbound, cold_dest: c.cold_dest,
        number_connected: c.number_connected, name_connected: c.name_connected,
      };
      // Registra antes de enviar: duas rodadas sobrepostas nao avisam duas vezes
      const { error: insErr } = await sb.from("instance_restriction_alerts").insert({
        event_id: c.event_id, instance_name: c.instance_name, location_id: c.location_id,
        closed_at: c.closed_at, reopened_at: c.reopened_at, prev_401_24h: c.prev_401_24h,
        alerted: false, stats, message: texto,
      });
      if (insErr) {
        if (insErr.code !== "23505") console.error(`[watch] insert ${c.event_id}: ${insErr.message}`);
        continue;
      }
      registrados++;
      if (!avisar) continue;

      const { status, erro } = await enviar(texto!);
      await sb.from("instance_restriction_alerts")
        .update({ alerted: !erro, send_status: status, send_error: erro }).eq("event_id", c.event_id);
      if (!erro) avisados++;
      console.log(`[watch] ${c.instance_name} 401 ${c.closed_at} -> ${erro ? `falhou ${status}: ${erro}` : "avisado"}`);
    }
    return json({ ok: true, candidatos: candidatos.length, registrados, avisados });
  } catch (e) {
    console.error(`[watch] erro: ${String((e as Error)?.message ?? e)}`);
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
