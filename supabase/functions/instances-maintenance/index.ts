import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCors, jsonRes } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/supabase.ts";
import { EVOLUTION_API_URL, EVOLUTION_API_KEY } from "../_shared/evolution-api.ts";

const STALE_DAYS = 3;
const STALE_STATUSES = ["close", "connecting"];
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const TARGET_WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/evolution-receive-message`;
// Mesma lista usada em evolution-create-instance-v2 (canonico)
const WEBHOOK_EVENTS = [
  "MESSAGES_SET",
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "MESSAGES_DELETE",
  "SEND_MESSAGE",
  "CONNECTION_UPDATE",
];

type Mode = "cleanup" | "migrate-webhooks" | "inspect-schema";

// ─── Evolution API helpers ───────────────────────────────

async function evoDeleteInstance(name: string): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(`${EVOLUTION_API_URL}/instance/delete/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { apikey: EVOLUTION_API_KEY },
  });
  const body = await res.text();
  return { ok: res.ok || res.status === 404, status: res.status, body };
}

async function evoLogoutInstance(name: string): Promise<void> {
  try {
    await fetch(`${EVOLUTION_API_URL}/instance/logout/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: { apikey: EVOLUTION_API_KEY },
    });
  } catch (_) {
    // best-effort
  }
}

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

async function evoSetWebhook(name: string, url: string, events: string[]): Promise<{ ok: boolean; status: number; body: string }> {
  // Mesmo shape usado em evolution-create-instance-v2 (byEvents/base64, nao webhookByEvents/webhookBase64)
  const payload = {
    webhook: {
      enabled: true,
      url,
      byEvents: false,
      base64: false,
      events,
    },
  };
  const res = await fetch(`${EVOLUTION_API_URL}/webhook/set/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

// ─── DB helpers ──────────────────────────────────────────

async function inspectFkCascade(supabase: ReturnType<typeof getSupabase>) {
  const { data, error } = await supabase.rpc("_inspect_instances_fks" as any).single();
  if (!error && data) return data;
  // Fallback: raw SELECT via PostgREST is limited. Return marker for manual check.
  return {
    note:
      "Sem RPC dedicada; veja logs da function (abaixo) ou rode o SQL manual no wiki.",
  };
}

async function listStaleInstances(supabase: ReturnType<typeof getSupabase>) {
  const cutoffIso = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("instances")
    .select("id, evolution_name, evolution_id, location_id, status, updated_at, created_at, number_connected")
    .in("status", STALE_STATUSES)
    .lt("updated_at", cutoffIso)
    .order("updated_at", { ascending: true });
  if (error) throw new Error(`listStaleInstances: ${error.message}`);
  return data ?? [];
}

async function listActiveInstances(supabase: ReturnType<typeof getSupabase>) {
  const cutoffIso = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
  // "Restantes" = todas que NAO seriam deletadas.
  // NOT (status in stale AND updated_at < cutoff)  <=>  status not in stale OR updated_at >= cutoff
  const { data, error } = await supabase
    .from("instances")
    .select("id, evolution_name, evolution_id, location_id, status, updated_at")
    .or(`status.not.in.(${STALE_STATUSES.join(",")}),updated_at.gte.${cutoffIso}`)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`listActiveInstances: ${error.message}`);
  return data ?? [];
}

async function countRelated(supabase: ReturnType<typeof getSupabase>, instanceId: string) {
  const { data: convos } = await supabase
    .from("conversations")
    .select("id")
    .eq("instance_id", instanceId);
  const convIds = (convos ?? []).map((c: any) => c.id);
  let messageCount = 0;
  if (convIds.length > 0) {
    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .in("conversation_id", convIds);
    messageCount = count ?? 0;
  }
  return { conversations: convIds.length, messages: messageCount, convIds };
}

async function cascadeDelete(
  supabase: ReturnType<typeof getSupabase>,
  instanceId: string,
  convIds: string[],
) {
  // Defensive 3-step delete. Idempotent — no-op se FK cascade ja limpou.
  if (convIds.length > 0) {
    const { error: mErr } = await supabase.from("messages").delete().in("conversation_id", convIds);
    if (mErr) throw new Error(`delete messages: ${mErr.message}`);
  }
  const { error: cErr } = await supabase.from("conversations").delete().eq("instance_id", instanceId);
  if (cErr) throw new Error(`delete conversations: ${cErr.message}`);
  const { error: iErr } = await supabase.from("instances").delete().eq("id", instanceId);
  if (iErr) throw new Error(`delete instance: ${iErr.message}`);
}

// ─── Modes ───────────────────────────────────────────────

async function modeCleanup(dryRun: boolean, excludeNames: Set<string>) {
  const supabase = getSupabase();
  const allCandidates = await listStaleInstances(supabase);
  const candidates = (allCandidates as any[]).filter((i) => !excludeNames.has(i.evolution_name));
  const excluded = (allCandidates as any[])
    .filter((i) => excludeNames.has(i.evolution_name))
    .map((i) => i.evolution_name);

  const report: any = {
    mode: "cleanup",
    dry_run: dryRun,
    criteria: { statuses: STALE_STATUSES, older_than_days: STALE_DAYS },
    excluded,
    total_candidates: candidates.length,
    items: [],
  };

  for (const inst of candidates as any[]) {
    const rel = await countRelated(supabase, inst.id);
    const item: any = {
      id: inst.id,
      evolution_name: inst.evolution_name,
      location_id: inst.location_id,
      status: inst.status,
      updated_at: inst.updated_at,
      conversations: rel.conversations,
      messages: rel.messages,
    };

    if (!dryRun) {
      await evoLogoutInstance(inst.evolution_name);
      const evo = await evoDeleteInstance(inst.evolution_name);
      item.evolution_delete = { status: evo.status, ok: evo.ok };
      try {
        await cascadeDelete(supabase, inst.id, rel.convIds);
        item.db_delete = "ok";
      } catch (e: any) {
        item.db_delete = `error: ${e?.message ?? e}`;
      }
    }

    report.items.push(item);
  }

  if (!dryRun) {
    report.summary = {
      attempted: report.items.length,
      db_ok: report.items.filter((i: any) => i.db_delete === "ok").length,
      db_errors: report.items.filter((i: any) => i.db_delete && i.db_delete !== "ok").length,
      evo_non_2xx_or_404: report.items.filter(
        (i: any) => i.evolution_delete && !i.evolution_delete.ok,
      ).length,
    };
  }

  return report;
}

async function modeMigrateWebhooks(dryRun: boolean) {
  const supabase = getSupabase();
  const instances = await listActiveInstances(supabase);

  const report: any = {
    mode: "migrate-webhooks",
    dry_run: dryRun,
    target_url: TARGET_WEBHOOK_URL,
    total_instances: instances.length,
    items: [],
  };

  for (const inst of instances as any[]) {
    const current = await evoFindWebhook(inst.evolution_name);
    const currentUrl =
      current?.url ?? current?.webhook?.url ?? current?.data?.url ?? null;
    const needsChange = currentUrl !== TARGET_WEBHOOK_URL;

    const item: any = {
      id: inst.id,
      evolution_name: inst.evolution_name,
      status: inst.status,
      current_url: currentUrl,
      needs_change: needsChange,
    };

    if (needsChange && !dryRun) {
      const resSet = await evoSetWebhook(
        inst.evolution_name,
        TARGET_WEBHOOK_URL,
        WEBHOOK_EVENTS,
      );
      item.set_result = { status: resSet.status, ok: resSet.ok };
      if (!resSet.ok) {
        item.set_body = resSet.body.slice(0, 300);
      } else {
        const { error: updErr } = await supabase
          .from("instances")
          .update({ webhook_url: TARGET_WEBHOOK_URL })
          .eq("id", inst.id);
        if (updErr) item.db_update = `error: ${updErr.message}`;
        else item.db_update = "ok";
      }
    }

    report.items.push(item);
  }

  report.summary = {
    total: report.items.length,
    need_change: report.items.filter((i: any) => i.needs_change).length,
    changed_ok: dryRun
      ? 0
      : report.items.filter((i: any) => i.set_result?.ok).length,
    changed_failed: dryRun
      ? 0
      : report.items.filter((i: any) => i.set_result && !i.set_result.ok).length,
  };

  return report;
}

async function modeInspectSchema() {
  const supabase = getSupabase();
  const probes: Record<string, any> = {};
  for (const t of ["instances", "conversations", "messages"]) {
    const { count, error } = await supabase
      .from(t)
      .select("id", { count: "exact", head: true });
    probes[t] = error ? { error: error.message } : { count };
  }

  // Distribuicao por status
  const { data: all, error: allErr } = await supabase
    .from("instances")
    .select("id, evolution_name, status, updated_at, created_at");
  if (allErr) return { mode: "inspect-schema", probes, error: allErr.message };

  const now = Date.now();
  const cutoff = now - STALE_DAYS * 86_400_000;
  const byStatus: Record<string, number> = {};
  const staleByStatus: Record<string, number> = {};
  const staleRows: any[] = [];

  for (const inst of all ?? []) {
    const s = (inst as any).status ?? "(null)";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    if (STALE_STATUSES.includes(s)) {
      const u = new Date((inst as any).updated_at).getTime();
      if (u < cutoff) {
        staleByStatus[s] = (staleByStatus[s] ?? 0) + 1;
        staleRows.push({
          id: (inst as any).id,
          name: (inst as any).evolution_name,
          status: s,
          updated_at: (inst as any).updated_at,
          created_at: (inst as any).created_at,
          days_since_update: ((now - u) / 86_400_000).toFixed(1),
        });
      }
    }
  }

  // Amostra de close/connecting ordenadas por updated_at
  const closeConnecting = (all ?? [])
    .filter((r: any) => STALE_STATUSES.includes(r.status))
    .map((r: any) => ({
      name: r.evolution_name,
      status: r.status,
      updated_at: r.updated_at,
      days_since_update: ((now - new Date(r.updated_at).getTime()) / 86_400_000).toFixed(1),
    }))
    .sort((a: any, b: any) => (a.updated_at < b.updated_at ? -1 : 1));

  return {
    mode: "inspect-schema",
    probes,
    status_breakdown: byStatus,
    stale_threshold_days: STALE_DAYS,
    stale_by_status: staleByStatus,
    stale_candidates: staleRows,
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

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
      return jsonRes(
        { ok: false, error: "EVOLUTION_API_URL/EVOLUTION_API_KEY nao configurados" },
        500,
      );
    }

    let result: any;
    if (mode === "cleanup") result = await modeCleanup(dryRun, excludeNames);
    else if (mode === "migrate-webhooks") result = await modeMigrateWebhooks(dryRun);
    else if (mode === "inspect-schema") result = await modeInspectSchema();
    else return jsonRes({ ok: false, error: `mode invalido: ${mode}` }, 400);

    return jsonRes({ ok: true, ...result });
  } catch (e: any) {
    console.error("[instances-maintenance] error:", e?.message ?? e);
    return jsonRes({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
