// ghl-sso — decifra o token SSO que a GHL entrega a uma custom page (REQUEST_USER_DATA_RESPONSE) e
// devolve a subconta ativa. Substitui o webhook do n8n "get-evolution-instances" (2026-10-28).
// Secret: GHL_SSO_KEY = SSO Key do app WhatsApp Homio no Marketplace (a mesma do node do n8n).
// Sem o secret responde 503 e a rota /api/instances da pagina de conexao volta para o n8n.
import CryptoJS from "https://esm.sh/crypto-js@4.2.0";

const SSO_KEY = Deno.env.get("GHL_SSO_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!SSO_KEY) return json({ ok: false, error: "sso_key_missing" }, 503);

  let token = "";
  try { token = String((await req.json())?.token ?? ""); } catch { /* corpo invalido */ }
  if (!token) return json({ ok: false, error: "token_required" }, 400);

  let dados: any = null;
  try {
    const texto = CryptoJS.AES.decrypt(token, SSO_KEY).toString(CryptoJS.enc.Utf8);
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = null; // chave errada ou token adulterado: "Malformed UTF-8 data"
  }
  const locationId = dados?.activeLocation;
  if (!locationId) return json({ ok: false, error: "token_invalido" }, 401);

  // Sem e-mail/nome na resposta: a rota so precisa da subconta e de quem esta olhando
  return json({ ok: true, locationId, userId: dados.userId ?? null, companyId: dados.companyId ?? null, role: dados.role ?? null, type: dados.type ?? null });
});
