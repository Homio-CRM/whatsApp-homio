import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCors, jsonRes } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/supabase.ts";
import { EVOLUTION_API_URL, EVOLUTION_API_KEY, fetchInstanceInfo } from "../_shared/evolution-api.ts";

const STALE_DAYS = 3; // usado so por migrate-webhooks e inspect-schema (comportamento antigo, intocado)
const STALE_STATUSES = ["close", "connecting"];
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const TARGET_WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/evolution-receive-message`;

// ─── Limpeza (v15, 2026-11-18) ───────────────────────────
// Exclui instancia fora do ar (close/connecting) ha mais de CLEANUP_DAYS, contados por instances.status_changed_at
// (o gatilho so mexe nele quando o status muda; o updated_at e renovado a cada 5 min pelo sync e nunca envelhecia).
// Exclui pela EF evolution-delete-instance (logout -> delete -> confirma, com escalada; so apaga o banco se a
// Evolution confirmar), a mesma da pagina de conexao. Antes de cada uma, confere o estado ao vivo na Evolution:
// aberta ou estado desconhecido = pula. O aviso no grupo "Homio - Avisos" sai pelo instance-down-watch
// ("Instancia removida"). 7 dias passa longe da guarda da credencial (session-guard desiste em 24 h).
const CLEANUP_DAYS = 7;
const MIN_DAYS_CONFIRM = 7; // com confirm=true o prazo nunca fica abaixo disso
const MAX_DELETE_PER_RUN = 10; // mais candidatas que isso de uma vez = algo estranho: aborta sem excluir
const TIME_BUDGET_MS = 110_000; // para antes do limite da EF; o resto fica para a proxima rodada
const DELETE_EF_URL = `${SUPABASE_URL}/functions/v1/evolution-delete-instance`;

// Sem MESSAGES_SET (2026-10-28): a descarga de historico do pareamento por esse evento disparava as quedas
// em massa de 15/10. Ele saiu das 41 instancias e da evolution-create-instance-v2 (v23); faltava aqui.
const WEBHOOK_EVENTS = [
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "MESSAGES_DELETE",
  "SEND_MESSAGE",
  "CONNECTION_UPDATE",
];

type Mode = "cleanup" | "migrate-webhooks" | "inspect-schema" | "sync-webhook-url";

// ─── Evolution API helpers ───────────────────────────────

async function evoFindWebhook(name: string): Promise<any | null> {
  try {
    const res = await fetch(`${EVOLUTION_API_URL}/webhook/find/${encodeURIComponent(name)}`, {
      headers: { apikey: EVOLUTION_API_KEY },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function evoSetWebhook(name: string, url: string, events: string[]) {
  const payload = { webhook: { enabled: true, url, byEvents: false, base64: false, events } };
  const res = await fetch(`${EVOLUTION_API_URL}/webhook/set/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

/** Estado ao vivo na Evolution: open | close | connecting | ausente | erro. "erro" = nao deu para saber. */
async function evoLiveState(name: string): Promise<string> {
  try {
    const res = await fetch(`${EVOLUTION_API_URL}/instance/fetchInstances?instanceName=${encodeURIComponent(name)}`, {
      headers: { apikey: EVOLUTION_API_KEY },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) return "ausente";
    if (!res.ok) return "erro";
    const data = await res.json();
    const list = Array.isArray(data) ? data : [data];
    const hit = list.find((i: any) => i?.name === name || i?.instance?.instanceName === name);
    if (!hit) return "ausente";
    return String(hit.connectionStatus ?? hit.instance?.state ?? hit.state ?? "erro");
  } catch {
    return "erro";
  }
}

function extractWebhookUrl(payload: any): string | null {
  if (!payload) return null;
  return payload.url ?? payload.webhook?.url ?? payload.data?.url ?? null;
}

// ─── DB helpers ──────────────────────────────────────────

/** Fora do ar ha mais de `days`, pela data em que o status mudou. status_changed_at nulo nunca entra. */
async function listCleanupCandidates(supabase: ReturnType<typeof getSupabase>, days: number) {
  const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("instances")
    .select("id, evolution_name, location_id, status, status_reason, status_changed_at, name_connected, number_connected")
    .in("status", STALE_STATUSES)
    .lt("status_changed_at", cutoffIso)
    .order("status_changed_at", { ascending: true });
  if (error) throw new Error(`listCleanupCandidates: ${error.message}`);
  return data ?? [];
}

async function listActiveInstances(supabase: ReturnType<typeof getSupabase>) {
  const cutoffIso = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("instances")
    .select("id, evolution_name, evolution_id, location_id, status, updated_at")
    .or(`status.not.in.(${STALE_STATUSES.join(",")}),updated_at.gte.${cutoffIso}`)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`listActiveInstances: ${error.message}`);
  return data ?? [];
}

async function listAllInstances(supabase: ReturnType<typeof getSupabase>) {
  const { data, error } = await supabase
    .from("instances")
    .select("id, evolution_name, location_id, status, webhook_url, number_connected, updated_at")
    .order("evolution_name", { ascending: true });
  if (error) throw new Error(`listAllInstances: ${error.message}`);
  return data ?? [];
}

async function countConversations(supabase: ReturnType<typeof getSupabase>, instanceId: string) {
  const { count } = await supabase.from("conversations").select("id", { count: "exact", head: true }).eq("instance_id", instanceId);
  return count ?? 0;
}

// ─── Modes ───────────────────────────────────────────────

async function modeCleanup(dryRun: boolean, excludeNames: Set<string>, days: number) {
  const inicio = Date.now();
  const supabase = getSupabase();
  const allCandidates = await listCleanupCandidates(supabase, days);
  const candidates = (allCandidates as any[]).filter((i) => !excludeNames.has(i.evolution_name));
  const excluded = (allCandidates as any[]).filter((i) => excludeNames.has(i.evolution_name)).map((i) => i.evolution_name);

  const report: any = {
    mode: "cleanup",
    dry_run: dryRun,
    criteria: { statuses: STALE_STATUSES, not_open_for_days: days, by: "status_changed_at", max_per_run: MAX_DELETE_PER_RUN },
    excluded,
    total_candidates: candidates.length,
    items: [],
  };

  if (!dryRun && candidates.length > MAX_DELETE_PER_RUN) {
    report.aborted =
      `${candidates.length} candidatas de uma vez (teto ${MAX_DELETE_PER_RUN}): nada excluido. ` +
      "Conferir com dry run e excluir na mao ou com exclude.";
    report.items = candidates.map((i) => ({ evolution_name: i.evolution_name, status: i.status, status_changed_at: i.status_changed_at }));
    console.warn(`[instances-maintenance] cleanup abortada: ${report.aborted}`);
    return report;
  }

  for (const inst of candidates as any[]) {
    if (Date.now() - inicio > TIME_BUDGET_MS) {
      report.items.push({ evolution_name: inst.evolution_name, skipped: "sem_tempo_proxima_rodada" });
      continue;
    }
    const item: any = {
      id: inst.id, evolution_name: inst.evolution_name, location_id: inst.location_id,
      name_connected: inst.name_connected, number_connected: inst.number_connected,
      status: inst.status, status_reason: inst.status_reason, status_changed_at: inst.status_changed_at,
      conversations: await countConversations(supabase, inst.id),
    };
    // Nunca exclui o que esta aberto na Evolution, nem quando nao da para saber o estado.
    item.evo_state = await evoLiveState(inst.evolution_name);
    if (item.evo_state === "open" || item.evo_state === "erro") {
      item.skipped = item.evo_state === "open" ? "aberta_na_evolution" : "estado_desconhecido";
      report.items.push(item);
      continue;
    }
    if (!dryRun) {
      try {
        const r = await fetch(DELETE_EF_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instanceName: inst.evolution_name }),
          signal: AbortSignal.timeout(60_000),
        });
        const body: any = await r.json().catch(() => ({}));
        item.delete = {
          status: r.status, success: body?.success === true, evolution_removed: body?.evolutionRemoved ?? null,
          attempts: body?.evolution_attempts ?? null, error: body?.error ?? null,
        };
      } catch (e: any) {
        item.delete = { status: 0, success: false, error: String(e?.message ?? e).slice(0, 200) };
      }
      console.log(`[instances-maintenance] cleanup ${inst.evolution_name}: ${JSON.stringify(item.delete)}`);
    }
    report.items.push(item);
  }

  if (!dryRun) {
    report.summary = {
      deleted: report.items.filter((i: any) => i.delete?.success).length,
      failed: report.items.filter((i: any) => i.delete && !i.delete.success).length,
      skipped: report.items.filter((i: any) => i.skipped).length,
    };
  }
  return report;
}

async function modeMigrateWebhooks(dryRun: boolean) {
  const supabase = getSupabase();
  const instances = await listActiveInstances(supabase);
  const report: any = { mode: "migrate-webhooks", dry_run: dryRun, target_url: TARGET_WEBHOOK_URL, total_instances: instances.length, items: [] };

  for (const inst of instances as any[]) {
    const current = await evoFindWebhook(inst.evolution_name);
    const currentUrl = extractWebhookUrl(current);
    const needsChange = currentUrl !== TARGET_WEBHOOK_URL;
    const item: any = { id: inst.id, evolution_name: inst.evolution_name, status: inst.status, current_url: currentUrl, needs_change: needsChange };

    if (needsChange && !dryRun) {
      const resSet = await evoSetWebhook(inst.evolution_name, TARGET_WEBHOOK_URL, WEBHOOK_EVENTS);
      item.set_result = { status: resSet.status, ok: resSet.ok };
      if (!resSet.ok) {
        item.set_body = resSet.body.slice(0, 300);
      } else {
        const { error: updErr } = await supabase.from("instances").update({ webhook_url: TARGET_WEBHOOK_URL }).eq("id", inst.id);
        if (updErr) item.db_update = `error: ${updErr.message}`;
        else item.db_update = "ok";
      }
    }
    report.items.push(item);
  }

  report.summary = {
    total: report.items.length,
    need_change: report.items.filter((i: any) => i.needs_change).length,
    changed_ok: dryRun ? 0 : report.items.filter((i: any) => i.set_result?.ok).length,
    changed_failed: dryRun ? 0 : report.items.filter((i: any) => i.set_result && !i.set_result.ok).length,
  };
  return report;
}

// Novo: reconcilia instances.webhook_url <- webhook real na Evolution + coleta estado de conexao
async function modeSyncWebhookUrl(dryRun: boolean) {
  const supabase = getSupabase();
  const instances = await listAllInstances(supabase);

  const report: any = {
    mode: "sync-webhook-url",
    dry_run: dryRun,
    target_url: TARGET_WEBHOOK_URL,
    total_instances: instances.length,
    items: [],
  };

  for (const inst of instances as any[]) {
    const webhook = await evoFindWebhook(inst.evolution_name);
    const evoUrl = extractWebhookUrl(webhook);
    const info = await fetchInstanceInfo(inst.evolution_name);
    const evoState = info?.instance?.state ?? info?.state ?? info?.connectionStatus ?? null;
    const evoProfile = info?.instance?.profileName ?? info?.profileName ?? null;

    const db_matches_evo = inst.webhook_url === evoUrl;
    const evo_matches_target = evoUrl === TARGET_WEBHOOK_URL;

    const item: any = {
      id: inst.id,
      evolution_name: inst.evolution_name,
      location_id: inst.location_id,
      db_status: inst.status,
      db_webhook_url: inst.webhook_url,
      evo_webhook_url: evoUrl,
      evo_state: evoState,
      evo_profile: evoProfile,
      db_matches_evo,
      evo_matches_target,
    };

    if (!db_matches_evo && !dryRun) {
      const { error: updErr } = await supabase.from("instances").update({ webhook_url: evoUrl }).eq("id", inst.id);
      item.db_update = updErr ? `error: ${updErr.message}` : "ok";
    }
    report.items.push(item);
  }

  report.summary = {
    total: report.items.length,
    db_stale: report.items.filter((i: any) => !i.db_matches_evo).length,
    evo_off_target: report.items.filter((i: any) => !i.evo_matches_target).length,
    db_updated_ok: dryRun ? 0 : report.items.filter((i: any) => i.db_update === "ok").length,
    db_update_errors: dryRun ? 0 : report.items.filter((i: any) => i.db_update && i.db_update !== "ok").length,
    not_connected_state: report.items.filter((i: any) => i.evo_state && i.evo_state !== "open").length,
  };
  return report;
}

async function modeInspectSchema() {
  const supabase = getSupabase();
  const probes: Record<string, any> = {};
  for (const t of ["instances", "conversations", "messages"]) {
    const { count, error } = await supabase.from(t).select("id", { count: "exact", head: true });
    probes[t] = error ? { error: error.message } : { count };
  }

  const { data: all, error: allErr } = await supabase
    .from("instances")
    .select("id, evolution_name, status, updated_at, created_at, status_changed_at");
  if (allErr) return { mode: "inspect-schema", probes, error: allErr.message };

  const now = Date.now();
  const byStatus: Record<string, number> = {};
  for (const inst of all ?? []) {
    const s = (inst as any).status ?? "(null)";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }

  const closeConnecting = (all ?? [])
    .filter((r: any) => STALE_STATUSES.includes(r.status))
    .map((r: any) => ({
      name: r.evolution_name, status: r.status, status_changed_at: r.status_changed_at,
      days_not_open: r.status_changed_at ? ((now - new Date(r.status_changed_at).getTime()) / 86_400_000).toFixed(1) : null,
      cleanup_candidate: !!r.status_changed_at && now - new Date(r.status_changed_at).getTime() > CLEANUP_DAYS * 86_400_000,
    }))
    .sort((a: any, b: any) => String(a.status_changed_at).localeCompare(String(b.status_changed_at)));

  return {
    mode: "inspect-schema", probes,
    status_breakdown: byStatus, cleanup_days: CLEANUP_DAYS,
    close_connecting_all: closeConnecting,
  };
}

// ─── Entrypoint ──────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const url = new URL(req.url);
    const mode = (url.searchParams.get("mode") ?? "inspect-schema") as Mode;
    const confirm = url.searchParams.get("confirm") === "true";
    const dryRun = !confirm;
    const excludeNames = new Set(
      (url.searchParams.get("exclude") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const daysParam = Number(url.searchParams.get("days"));
    const days = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : CLEANUP_DAYS;

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
      return jsonRes({ ok: false, error: "EVOLUTION_API_URL/EVOLUTION_API_KEY nao configurados" }, 500);
    }

    let result: any;
    if (mode === "cleanup") {
      if (confirm && days < MIN_DAYS_CONFIRM) {
        return jsonRes({ ok: false, error: `days=${days}: com confirm=true o minimo e ${MIN_DAYS_CONFIRM}` }, 400);
      }
      result = await modeCleanup(dryRun, excludeNames, days);
    } else if (mode === "migrate-webhooks") result = await modeMigrateWebhooks(dryRun);
    else if (mode === "sync-webhook-url") result = await modeSyncWebhookUrl(dryRun);
    else if (mode === "inspect-schema") result = await modeInspectSchema();
    else return jsonRes({ ok: false, error: `mode invalido: ${mode}` }, 400);

    return jsonRes({ ok: true, ...result });
  } catch (e: any) {
    console.error("[instances-maintenance] error:", e?.message ?? e);
    return jsonRes({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
