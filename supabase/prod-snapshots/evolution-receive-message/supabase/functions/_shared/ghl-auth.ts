import type { SupabaseClient } from './supabase.ts';

const AUTH_CLIENT_ID = Deno.env.get('HOMIO_AUTH_CLIENT_ID') ?? '';
const AUTH_CLIENT_SECRET = Deno.env.get('HOMIO_AUTH_CLIENT_SECRET') ?? '';
const AUTH_COMPANY_ID = Deno.env.get('HOMIO_AUTH_COMPANY_ID') ?? '';

export const GHL_BASE = 'https://services.leadconnectorhq.com';
export const GHL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';
export const GHL_LOCATION_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/locationToken';
export const GHL_VERSION_V2 = '2021-07-28';
export const GHL_VERSION_V1 = '2021-04-15';
export { AUTH_COMPANY_ID };

export async function getValidAgencyToken(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.from('agency_token').select('access_token, refresh_token, expires_at').eq('key', 'agency').maybeSingle();
  if (error || !data) { console.error('[agency-token] Not found'); return null; }
  const expMs = new Date(data.expires_at).getTime();
  if (expMs - 120_000 > Date.now()) return data.access_token;
  try {
    const res = await fetch(GHL_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: AUTH_CLIENT_ID, client_secret: AUTH_CLIENT_SECRET, refresh_token: data.refresh_token }) });
    if (!res.ok) { console.error(`[agency-token] Refresh failed ${res.status}: ${await res.text()}`); return null; }
    const nd = await res.json();
    const newExpiresAt = new Date(Date.now() + (nd.expires_in || 86400) * 1000).toISOString();
    await supabase.from('agency_token').update({ access_token: nd.access_token, refresh_token: nd.refresh_token, expires_at: newExpiresAt }).eq('key', 'agency');
    return nd.access_token;
  } catch (e: any) { console.error('[agency-token] Refresh error:', e.message); return null; }
}

export async function getGHLToken(supabase: SupabaseClient, locationId: string): Promise<string | null> {
  const { data: cached } = await supabase.from('location_tokens').select('access_token, expires_at').eq('location_id', locationId).maybeSingle();
  if (cached?.access_token && cached?.expires_at) {
    if (Date.now() < new Date(cached.expires_at).getTime()) return cached.access_token;
  }
  const agencyToken = await getValidAgencyToken(supabase);
  if (!agencyToken) { console.error('[token] No valid agency token'); return null; }
  try {
    const res = await fetch(GHL_LOCATION_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': `Bearer ${agencyToken}`, 'Version': GHL_VERSION_V2 }, body: JSON.stringify({ companyId: AUTH_COMPANY_ID, locationId }) });
    if (!res.ok) { console.error(`[token] Location token failed ${res.status}: ${await res.text()}`); return null; }
    const data = await res.json();
    const token = data.access_token;
    if (!token) { console.error('[token] No access_token in response'); return null; }
    const expiresIn = Number(data.expires_in || 86400);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    await supabase.from('location_tokens').upsert({ location_id: locationId, access_token: token, expires_at: expiresAt, updated_at: new Date().toISOString() }, { onConflict: 'location_id' });
    return token;
  } catch (e: any) { console.error('[token] Error:', e.message); return null; }
}
