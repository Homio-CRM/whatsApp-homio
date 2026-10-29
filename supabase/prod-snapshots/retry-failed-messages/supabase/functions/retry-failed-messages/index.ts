import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCors, jsonRes } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/supabase.ts";

// v7 (2026-10-28): o reenvio vai com `x-retry-of: <id>` e a evolution-receive-message reaproveita a
// MESMA linha (antes criava um clone com hash novo e, no 2o reenvio, a dedup respondia 200 "duplicate",
// que esta funcao contava como sucesso: ~250 mensagens da MM7 marcadas processed sem nunca chegar ao GHL).
// O veredito agora vem do status da linha depois do reenvio, nao do HTTP. Ver
// wiki debug_retry_webhook_marca_processed_sem_postar.
// v8 (2026-10-28, pedido do Luan): so regrava o que tem ate 30 min. Mensagem recebida gravada com atraso
// dispara automacao da GHL atrasada ("cliente respondeu", agente de IA). Passou de 30 min -> dead_letter,
// para reprocessar a mao com a data original no texto (receita na wiki).
const MAX_TENTATIVAS = 3;
const MAX_IDADE_MIN = 30;       // idade maxima do evento para regravar automaticamente
const POR_RODADA = 20;          // reenvios por execucao do cron (*/10)
const BACKOFF_MIN = [2, 5, 10]; // espera antes da tentativa 1, 2 e 3

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const supabase = getSupabase();
  const limite = new Date(Date.now() - MAX_IDADE_MIN * 60 * 1000).toISOString();

  // Velhos demais para regravar sem risco de automacao atrasada: saem da fila
  const { data: expirados } = await supabase
    .from("webhook_events")
    .update({ status: "dead_letter", last_retry_at: new Date().toISOString() })
    .eq("status", "failed")
    .lt("received_at", limite)
    .select("id");
  if (expirados && expirados.length) console.log(`[retry-failed-messages] ${expirados.length} evento(s) com mais de ${MAX_IDADE_MIN} min -> dead_letter (reprocessar a mao)`);

  const { data: candidatos, error: queryError } = await supabase
    .from("webhook_events")
    .select("id, retry_count, last_retry_at, received_at, payload")
    .eq("status", "failed")
    .lt("retry_count", MAX_TENTATIVAS)
    .gte("received_at", limite)
    .order("received_at", { ascending: true })
    .limit(200);

  if (queryError) {
    console.error("[retry-failed-messages] Query error:", queryError);
    return jsonRes({ error: "Failed to query webhook_events", details: queryError.message }, 500);
  }

  const agora = Date.now();
  const elegiveis = (candidatos ?? []).filter((e: any) => {
    const tentativa = e.retry_count ?? 0;
    const base = new Date(e.last_retry_at || e.received_at).getTime();
    return agora - base >= BACKOFF_MIN[Math.min(tentativa, BACKOFF_MIN.length - 1)] * 60 * 1000;
  }).slice(0, POR_RODADA);

  if (elegiveis.length === 0) {
    return jsonRes({ message: "No failed events to retry", expirados: expirados?.length ?? 0, pendentes: candidatos?.length ?? 0, retried: 0, succeeded: 0, failed: 0 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  let succeeded = 0;
  let failed = 0;

  for (const event of elegiveis as any[]) {
    const newRetryCount = (event.retry_count ?? 0) + 1;

    await supabase.from("webhook_events").update({ status: "retrying" }).eq("id", event.id);

    let httpInfo = "";
    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/evolution-receive-message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          "x-retry-of": String(event.id),
        },
        body: JSON.stringify(event.payload),
        signal: AbortSignal.timeout(60_000),
      });
      httpInfo = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
    } catch (err) {
      httpInfo = err instanceof Error ? err.message : String(err);
    }

    // Veredito pelo status que a receive gravou na propria linha
    const { data: depois } = await supabase.from("webhook_events").select("status, error_message").eq("id", event.id).maybeSingle();
    const status = (depois as any)?.status;

    if (status === "processed") {
      await supabase.from("webhook_events").update({
        retry_count: newRetryCount,
        last_retry_at: new Date().toISOString(),
        error_message: null,
      }).eq("id", event.id);
      succeeded++;
      console.log(`[retry-failed-messages] Event ${event.id} reprocessed successfully (attempt ${newRetryCount})`);
    } else {
      const finalStatus = newRetryCount >= MAX_TENTATIVAS ? "dead_letter" : "failed";
      const errorMessage = (depois as any)?.error_message || httpInfo || `status ${status ?? "?"} apos reenvio`;
      await supabase.from("webhook_events").update({
        status: finalStatus,
        retry_count: newRetryCount,
        error_message: errorMessage,
        last_retry_at: new Date().toISOString(),
      }).eq("id", event.id);
      failed++;
      console.error(`[retry-failed-messages] Event ${event.id} failed (attempt ${newRetryCount}/${MAX_TENTATIVAS}, status: ${finalStatus}): ${errorMessage}`);
    }
  }

  const summary = { message: "Retry run completed", expirados: expirados?.length ?? 0, pendentes: candidatos?.length ?? 0, retried: elegiveis.length, succeeded, failed };
  console.log("[retry-failed-messages] Summary:", summary);
  return jsonRes(summary);
});
