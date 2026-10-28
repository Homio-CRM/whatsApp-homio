// whatsapp-alerta — aviso de WhatsApp desconectado dentro da GHL.
//   GET                    -> o script (alerta.js serializado), para o loader do Custom JS do app
//   GET ?locationId=<id>   -> instancias fora do ar ha mais de MIN_FORA_MIN minutos
// Publico (verify_jwt=false): e asset + leitura minima. Numero sai mascarado (4 ultimos digitos).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { alertaWhats } from "./alerta.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const JS = ";(" + alertaWhats.toString() + ")();\n";
const MIN_FORA_MIN = 10; // tolera reconexao rapida sem piscar aviso
const LOCATION_RE = /^[A-Za-z0-9]{10,40}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const locationId = url.searchParams.get("locationId");

  if (!locationId) {
    return new Response(JS, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/javascript; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  if (!LOCATION_RE.test(locationId)) return json({ ok: false, error: "locationId invalido" }, 400);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const limite = new Date(Date.now() - MIN_FORA_MIN * 60_000).toISOString();
    const { data, error } = await supabase
      .from("instances")
      .select("evolution_name, name_connected, number_connected, status, status_changed_at, provider_id")
      .eq("location_id", locationId)
      .neq("status", "open")
      .lte("status_changed_at", limite)
      .order("status_changed_at", { ascending: true });
    if (error) throw error;

    const ids = [...new Set((data ?? []).map((i) => i.provider_id).filter((v) => v != null))];
    const nomes: Record<number, string> = {};
    if (ids.length) {
      const { data: provs } = await supabase.from("providers").select("id, name").in("id", ids);
      for (const p of provs ?? []) nomes[p.id] = (p.name ?? "").trim();
    }

    const fora = (data ?? []).map((i) => ({
      instancia: i.evolution_name,
      nome: i.name_connected || "",
      numero: i.number_connected ? String(i.number_connected).slice(-4) : "",
      provedor: nomes[i.provider_id] ?? "",
      status: i.status,
      desde: i.status_changed_at,
    }));

    return json({ ok: true, locationId, fora }, 200, "public, max-age=60");
  } catch (e) {
    console.error("[whatsapp-alerta]", e);
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});

function json(data: unknown, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": cache },
  });
}
