import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, handleCors, jsonRes } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "GET") {
    return jsonRes({ error: "Method not allowed" }, 405);
  }

  // API key check
  const requiredKey = Deno.env.get("METRICS_API_KEY");
  if (requiredKey) {
    const providedKey = req.headers.get("x-api-key");
    if (providedKey !== requiredKey) {
      return jsonRes({ error: "Unauthorized" }, 401);
    }
  }

  const supabase = getSupabase();

  try {
    const [daily, byInstance, instanceHealth, failedEvents, hourly, messagesSummary] =
      await Promise.all([
        supabase.from("v_metrics_daily").select("*").limit(30),
        supabase.from("v_metrics_by_instance").select("*"),
        supabase.from("v_instance_health").select("*"),
        supabase.from("v_failed_events").select("*").limit(20),
        supabase.from("v_metrics_hourly").select("*").limit(48),
        supabase.from("v_messages_summary").select("*").limit(30),
      ]);

    // Check for errors
    const queries = [
      { name: "daily", result: daily },
      { name: "by_instance", result: byInstance },
      { name: "instance_health", result: instanceHealth },
      { name: "failed_events", result: failedEvents },
      { name: "hourly", result: hourly },
      { name: "messages_summary", result: messagesSummary },
    ];

    const errors = queries
      .filter((q) => q.result.error)
      .map((q) => `${q.name}: ${q.result.error!.message}`);

    if (errors.length > 0) {
      return jsonRes({ error: "Query errors", details: errors }, 500);
    }

    return jsonRes({
      generated_at: new Date().toISOString(),
      daily: daily.data,
      by_instance: byInstance.data,
      instance_health: instanceHealth.data,
      failed_events: failedEvents.data,
      hourly: hourly.data,
      messages_summary: messagesSummary.data,
    });
  } catch (err) {
    return jsonRes({ error: "Internal server error", message: String(err) }, 500);
  }
});
