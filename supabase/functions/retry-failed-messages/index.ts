import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCors, jsonRes } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const supabase = getSupabase();

  // Query failed events eligible for retry
  const { data: failedEvents, error: queryError } = await supabase
    .from("webhook_events")
    .select("*")
    .eq("status", "failed")
    .lt("retry_count", 3)
    .gt("received_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("received_at", { ascending: true })
    .limit(10);

  if (queryError) {
    console.error("[retry-failed-messages] Query error:", queryError);
    return jsonRes({ error: "Failed to query webhook_events", details: queryError.message }, 500);
  }

  if (!failedEvents || failedEvents.length === 0) {
    return jsonRes({ message: "No failed events to retry", retried: 0, succeeded: 0, failed: 0 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  let succeeded = 0;
  let failed = 0;

  for (const event of failedEvents) {
    const newRetryCount = (event.retry_count ?? 0) + 1;

    // Mark as retrying
    await supabase
      .from("webhook_events")
      .update({ status: "retrying" })
      .eq("id", event.id);

    try {
      const response = await fetch(
        `${supabaseUrl}/functions/v1/evolution-receive-message`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify(event.payload),
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }

      // Success
      await supabase
        .from("webhook_events")
        .update({
          status: "processed",
          retry_count: newRetryCount,
          last_retry_at: new Date().toISOString(),
        })
        .eq("id", event.id);

      succeeded++;
      console.log(`[retry-failed-messages] Event ${event.id} reprocessed successfully`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const finalStatus = newRetryCount >= 3 ? "dead_letter" : "failed";

      await supabase
        .from("webhook_events")
        .update({
          status: finalStatus,
          retry_count: newRetryCount,
          error_message: errorMessage,
          last_retry_at: new Date().toISOString(),
        })
        .eq("id", event.id);

      failed++;
      console.error(
        `[retry-failed-messages] Event ${event.id} failed (attempt ${newRetryCount}/3, status: ${finalStatus}):`,
        errorMessage
      );
    }
  }

  const summary = {
    message: "Retry run completed",
    retried: failedEvents.length,
    succeeded,
    failed,
  };

  console.log("[retry-failed-messages] Summary:", summary);
  return jsonRes(summary);
});
