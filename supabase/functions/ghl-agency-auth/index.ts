import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get('HOMIO_AUTH_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('HOMIO_AUTH_CLIENT_SECRET') ?? '';
const GHL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';

// Chave de quem pode pegar o token de agência (2026-11-11). Até a v8 a função era pública e devolvia o token a
// qualquer um com a URL. Chamadores conhecidos: suporte-conta e delpim-contrato do Homio Operations, que mandam
// `x-api-key` com o secret WA_AGENCY_AUTH_KEY de lá (mesmo valor deste AGENCY_AUTH_KEY). Sem o secret, fecha.
const AUTH_KEY = Deno.env.get('AGENCY_AUTH_KEY') ?? '';

function autorizado(req: Request): boolean {
  if (!AUTH_KEY) return false;
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  return [req.headers.get('x-api-key'), req.headers.get('apikey'), bearer].some((v) => v === AUTH_KEY);
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

Deno.serve(async (req: Request) => {
  if (!autorizado(req)) {
    console.warn(`[ghl-agency-auth] 401: chamada sem chave (ua=${req.headers.get('user-agent') ?? '-'})`);
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  // 1. Buscar token atual
  const { data, error } = await supabase
    .from('agency_token')
    .select('*')
    .eq('key', 'agency')
    .single();

  if (error || !data) {
    return new Response(JSON.stringify({
      error: 'Nenhum token encontrado. Acesse /oauth-callback?route=authorize primeiro.',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  // 2. Verificar se precisa renovar (2 min antes de expirar)
  const now = Math.floor(Date.now() / 1000);
  const tokenExp = Math.floor(new Date(data.expires_at).getTime() / 1000);

  if (tokenExp - 120 > now) {
    // Token ainda válido
    return new Response(JSON.stringify({ access_token: data.access_token }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. Refresh do token
  console.log('[ghl-agency-auth] Token expirando, fazendo refresh...');

  const refreshRes = await fetch(GHL_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: data.refresh_token,
    }),
  });

  if (!refreshRes.ok) {
    const txt = await refreshRes.text();
    console.error(`[ghl-agency-auth] Refresh failed: ${txt}`);
    return new Response(JSON.stringify({ error: `Refresh falhou: ${txt}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const nd = await refreshRes.json();
  const newExpiresAt = new Date(Date.now() + (nd.expires_in || 86400) * 1000).toISOString();

  const { error: updErr } = await supabase
    .from('agency_token')
    .update({
      access_token: nd.access_token,
      refresh_token: nd.refresh_token,
      expires_at: newExpiresAt,
    })
    .eq('key', 'agency');

  if (updErr) {
    console.error(`[ghl-agency-auth] DB update failed: ${updErr.message}`);
    return new Response(JSON.stringify({ error: `DB update failed: ${updErr.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log('[ghl-agency-auth] Token refreshed successfully');

  return new Response(JSON.stringify({ access_token: nd.access_token }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
