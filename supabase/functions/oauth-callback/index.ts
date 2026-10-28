import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get('HOMIO_AUTH_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('HOMIO_AUTH_CLIENT_SECRET') ?? '';
const COMPANY_ID = Deno.env.get('HOMIO_AUTH_COMPANY_ID') ?? '';
const REDIRECT_URL = Deno.env.get('HOMIO_AUTH_REDIRECT_URL') ?? '';
const GHL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';

const SCOPES = [
  'locations.readonly',
  'contacts.readonly',
  'contacts.write',
  'opportunities.readonly',
  'opportunities.write',
  'users.readonly',
  'conversations/message.write',
  'conversations/message.readonly',
  'conversations.readonly',
  'conversations.write',
  'workflows.readonly',
  'conversations/reports.readonly',
  'locations/customFields.readonly',
  'locations/customFields.write',
  'calendars.write',
  'calendars.readonly',
  'calendars/events.readonly',
  'calendars/events.write',
  'calendars/groups.readonly',
  'calendars/groups.write',
  'calendars/resources.readonly',
  'calendars/resources.write',
  'businesses.readonly',
  'businesses.write',
  'companies.readonly',
].join(' ');

function getSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );
}

function htmlRes(html: string, status = 200) {
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  try {
    const part = String(token ?? '').split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const route = url.searchParams.get('route');
  const code = url.searchParams.get('code');

  // ── AUTHORIZE: redirect to GHL OAuth consent page ──
  if (route === 'authorize') {
    if (!CLIENT_ID || !REDIRECT_URL) {
      return htmlRes('<h2>Error</h2><p>HOMIO_AUTH_CLIENT_ID or HOMIO_AUTH_REDIRECT_URL not configured.</p>', 500);
    }
    const authUrl = new URL('https://marketplace.leadconnectorhq.com/oauth/chooselocation');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', REDIRECT_URL);
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('scope', SCOPES);
    return Response.redirect(authUrl.toString(), 302);
  }

  // ── CALLBACK: exchange code for agency token ──
  // Accepts both ?route=callback&code=xxx AND ?code=xxx (GHL sends just ?code=xxx)
  if (code) {
    console.log('[oauth] Received callback with code, exchanging for agency token...');

    try {
      const res = await fetch(GHL_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          user_type: 'Company',
          redirect_uri: REDIRECT_URL,
        }),
      });

      const text = await res.text();
      console.log(`[oauth] Token response status: ${res.status}`);

      if (!res.ok) {
        console.error(`[oauth] Token exchange failed: ${text}`);
        return htmlRes(`<h2>Token Exchange Failed</h2><p>Status: ${res.status}</p><pre>${text}</pre>`, 500);
      }

      const tokenData = JSON.parse(text);
      const expiresAt = new Date(Date.now() + (tokenData.expires_in || 86400) * 1000).toISOString();
      const claims = decodeJwtPayload(tokenData.access_token);
      // A classe vem do JWT; userType da resposta e reserva
      const authClass = String(claims?.authClass || tokenData.userType || 'Unknown');
      const companyId = String(claims?.authClassId && authClass === 'Company' ? claims.authClassId : (tokenData.companyId || ''));
      const userType = authClass;

      console.log(`[oauth] Token type: ${authClass}, companyId: ${companyId || '-'}, locationId: ${tokenData.locationId || claims?.authClassId || '-'}`);

      // Instalacao por subconta devolve token Location. Gravar ele como 'agency' derrubaria o
      // /oauth/locationToken de todos os clientes (debug_ghl_location_token_user_type).
      // O token da agencia ja alcanca a subconta nova, entao nada a gravar.
      if (authClass !== 'Company') {
        console.log(`[oauth] Instalacao ${authClass} ignorada; agency_token preservado`);
        return htmlRes(`
        <h2>&#9989; WhatsApp Homio instalado</h2>
        <p>Instalação registrada. Você já pode fechar esta janela.</p>
      `);
      }

      if (COMPANY_ID && companyId !== COMPANY_ID) {
        console.error(`[oauth] Token Company de outra agencia (${companyId}) recusado; agency_token preservado`);
        return htmlRes(`<h2>Agência não autorizada</h2><p>Este app só aceita a agência configurada.</p>`, 403);
      }

      const supabase = getSupabase();

      // Atualiza so a linha 'agency' (a tabela nao tem UNIQUE em key); sem linha, insere
      const fields = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
      };
      const { data: updated, error: updErr } = await supabase
        .from('agency_token')
        .update(fields)
        .eq('key', 'agency')
        .select('id');

      if (updErr) {
        console.error(`[oauth] DB update error: ${updErr.message}`);
        return htmlRes(`<h2>DB Error</h2><pre>${updErr.message}</pre>`, 500);
      }

      if (!updated || updated.length === 0) {
        const { error: insErr } = await supabase.from('agency_token').insert({ key: 'agency', ...fields });
        if (insErr) {
          console.error(`[oauth] DB insert error: ${insErr.message}`);
          return htmlRes(`<h2>DB Error</h2><pre>${insErr.message}</pre>`, 500);
        }
      }

      return htmlRes(`
        <h2>&#9989; Agency Token Saved!</h2>
        <p><strong>Type:</strong> ${userType}</p>
        <p><strong>Company:</strong> ${companyId}</p>
        <p><strong>Expires:</strong> ${expiresAt}</p>
        <p><strong>Scopes:</strong> ${tokenData.scope || SCOPES}</p>
        <p>You can now close this window.</p>
      `);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[oauth] Error:', msg);
      return htmlRes(`<h2>Error</h2><pre>${msg}</pre>`, 500);
    }
  }

  // ── STATUS: check current token ──
  if (route === 'status') {
    const supabase = getSupabase();
    const { data: agencyToken } = await supabase
      .from('agency_token')
      .select('id, key, expires_at, created_at')
      .eq('key', 'agency')
      .maybeSingle();

    return jsonRes({
      agency_token: agencyToken ? {
        exists: true,
        expires_at: agencyToken.expires_at,
        created_at: agencyToken.created_at,
        is_valid: new Date(agencyToken.expires_at) > new Date(),
      } : { exists: false },
      config: {
        client_id_set: !!CLIENT_ID,
        client_secret_set: !!CLIENT_SECRET,
        company_id: COMPANY_ID,
        redirect_url: REDIRECT_URL,
      },
    });
  }

  return htmlRes(`
    <h2>GHL Agency OAuth</h2>
    <p>Available routes:</p>
    <ul>
      <li><a href="?route=authorize">?route=authorize</a> - Start OAuth flow</li>
      <li><a href="?route=status">?route=status</a> - Check token status</li>
      <li><code>?code=xxx</code> - OAuth callback (automatic from GHL redirect)</li>
    </ul>
  `);
});
