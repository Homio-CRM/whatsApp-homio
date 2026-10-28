// client-usage-ingest v1 — recebe janelas agregadas do Custom JS agency-level.
// Publica (verify_jwt=false), mas fechada por origem, allowlist de location, formato e tamanho.
// Os dados sao telemetria operacional; user/location do cliente NAO autorizam nenhuma acao.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const ALLOWED_ORIGINS = new Set([
  "https://app.homio.com.br",
  "https://app.gohighlevel.com",
  "https://app.leadconnectorhq.com",
]);
const LOCATION_RE = /^[A-Za-z0-9]{10,40}$/;
const USER_RE = /^[A-Za-z0-9_-]{5,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODULES = new Set([
  "apps", "automations", "calendars", "contacts", "conversations", "dashboard",
  "marketing", "opportunities", "other", "payments", "reporting", "settings", "sites",
]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH_EVENTS = 25;

type UsageConfig = {
  location_id: string;
  enabled: boolean;
  batch_seconds: number;
  idle_seconds: number;
};

type IncomingEvent = {
  eventId?: unknown;
  sessionId?: unknown;
  module?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  activeSeconds?: unknown;
  pageViews?: unknown;
};

function headers(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://app.homio.com.br";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
}

function json(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: headers(req) });
}

function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  // Sem Origin e permitido para smoke/curl. Browser sempre envia Origin no cross-site.
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function integer(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

async function getConfig(supabase: ReturnType<typeof createClient>, locationId: string): Promise<UsageConfig | null> {
  const { data, error } = await supabase
    .from("client_usage_locations")
    .select("location_id, enabled, batch_seconds, idle_seconds")
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) throw error;
  return data as UsageConfig | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    if (!originAllowed(req)) return json(req, { ok: false, error: "origin_not_allowed" }, 403);
    return new Response("ok", { headers: headers(req) });
  }
  if (!originAllowed(req)) return json(req, { ok: false, error: "origin_not_allowed" }, 403);
  if (req.method !== "GET" && req.method !== "POST") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  try {
    if (req.method === "GET") {
      const locationId = new URL(req.url).searchParams.get("locationId") ?? "";
      if (!LOCATION_RE.test(locationId)) return json(req, { ok: false, error: "invalid_location" }, 400);
      const config = await getConfig(supabase, locationId);
      return json(req, {
        ok: true,
        enabled: config?.enabled === true,
        batchSeconds: config?.batch_seconds ?? 300,
        idleSeconds: config?.idle_seconds ?? 120,
        maxBatchEvents: MAX_BATCH_EVENTS,
      });
    }

    const declaredLength = Number(req.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_BODY_BYTES) return json(req, { ok: false, error: "payload_too_large" }, 413);
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json(req, { ok: false, error: "payload_too_large" }, 413);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json(req, { ok: false, error: "invalid_json" }, 400);
    }

    const locationId = cleanText(body.locationId, 40);
    const version = cleanText(body.version, 30) || "unknown";
    const user = body.user && typeof body.user === "object" ? body.user as Record<string, unknown> : {};
    const userId = cleanText(user.id, 80);
    if (!LOCATION_RE.test(locationId)) return json(req, { ok: false, error: "invalid_location" }, 400);
    if (!USER_RE.test(userId)) return json(req, { ok: false, error: "invalid_user" }, 400);

    const config = await getConfig(supabase, locationId);
    if (!config?.enabled) return json(req, { ok: true, accepted: 0, disabled: true }, 202);

    const incoming = Array.isArray(body.events) ? body.events as IncomingEvent[] : [];
    if (!incoming.length || incoming.length > MAX_BATCH_EVENTS) {
      return json(req, { ok: false, error: "invalid_event_count" }, 400);
    }

    const now = Date.now();
    const oldest = now - 24 * 60 * 60 * 1000;
    const newest = now + 5 * 60 * 1000;
    const maxWindowSeconds = Math.min(1800, Math.max(120, config.batch_seconds * 2 + 60));
    const rows: Array<Record<string, unknown>> = [];

    for (const event of incoming) {
      const eventId = cleanText(event.eventId, 36);
      const sessionId = cleanText(event.sessionId, 36);
      const moduleName = cleanText(event.module, 40);
      const startedAt = Date.parse(cleanText(event.startedAt, 40));
      const endedAt = Date.parse(cleanText(event.endedAt, 40));
      const activeSeconds = integer(event.activeSeconds, 0, maxWindowSeconds);
      const pageViews = integer(event.pageViews, 0, 50);

      if (!UUID_RE.test(eventId) || !UUID_RE.test(sessionId) || !MODULES.has(moduleName)) {
        return json(req, { ok: false, error: "invalid_event_identity" }, 400);
      }
      if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || startedAt < oldest || endedAt > newest || endedAt < startedAt) {
        return json(req, { ok: false, error: "invalid_event_time" }, 400);
      }
      const observedWindowSeconds = Math.ceil((endedAt - startedAt) / 1000);
      if (observedWindowSeconds > maxWindowSeconds || activeSeconds === null || pageViews === null || activeSeconds > observedWindowSeconds + 5) {
        return json(req, { ok: false, error: "invalid_event_metrics" }, 400);
      }

      rows.push({
        event_id: eventId,
        session_id: sessionId,
        location_id: locationId,
        user_id: userId,
        module: moduleName,
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        active_seconds: activeSeconds,
        page_views: pageViews,
        collector_version: version,
        source: "ghl_custom_js",
      });
    }

    const { error: userError } = await supabase.from("client_usage_users").upsert({
      location_id: locationId,
      user_id: userId,
      display_name: cleanText(user.name, 200),
      user_role: cleanText(user.role, 80),
      user_type: cleanText(user.type, 40),
      // Horario de recebimento evita uma repeticao antiga regredir last_seen_at.
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "location_id,user_id", ignoreDuplicates: false });
    if (userError) throw userError;

    const { error: eventError } = await supabase
      .from("client_usage_events")
      .upsert(rows, { onConflict: "event_id", ignoreDuplicates: true });
    if (eventError) throw eventError;

    return json(req, { ok: true, accepted: rows.length });
  } catch (error) {
    console.error("[client-usage-ingest]", error);
    return json(req, { ok: false, error: "internal_error" }, 500);
  }
});
