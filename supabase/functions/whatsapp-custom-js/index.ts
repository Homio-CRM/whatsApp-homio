// whatsapp-custom-js — o Custom JS consolidado da agencia (nucleo window.Homio + blocos numerados),
// servido como asset para o loader colado em Agency Settings → Company → Custom JavaScript:
//   <script src="https://mlntilbkenjjejksevdx.supabase.co/functions/v1/whatsapp-custom-js" async></script>
// Mesmo modelo da whatsapp-alerta: corrigir o script vira um deploy desta EF, sem abrir a GHL.
// Publico (verify_jwt=false): e so um asset. Cache de 5 min; quem ja tem a aba aberta precisa de Ctrl+Shift+R.
//   GET            -> o script (script.js serializado com toString())
//   GET ?v=        -> idem (so para furar cache ao testar)
import { homioCustomJs } from "./script.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const JS = "/* whatsapp-custom-js — servido pela Edge Function; fonte em whatsApp-homio/supabase/functions/whatsapp-custom-js/script.js */\n;(" + homioCustomJs.toString() + ")();\n";

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  return new Response(JS, {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=300",
    },
  });
});
