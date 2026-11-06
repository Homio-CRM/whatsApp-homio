import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, PATCH, OPTIONS',
};

const SIGNATURE_MODES = ['first', 'full', 'custom'];
const SIGNATURE_NAME_MAX = 40;
const SYNC_SCOPES = ['all', 'known'];

/**
 * Atualiza configuracoes editaveis pelo cliente na pagina de conexao.
 *
 * Assinatura do atendente, que a `ghl-send-message` prefixa como `*Nome:*` em cada texto enviado:
 * - `displayName`   (instances.display_name)   liga/desliga
 * - `signatureMode` (instances.signature_mode) first = primeiro nome, full = nome completo, custom = nome fixo
 * - `signatureName` (instances.signature_name) o nome fixo do modo custom (obrigatorio junto com custom)
 *
 * Quais conversas entram no CRM (2026-11-06), lido pela `evolution-receive-message`:
 * - `syncScope`     (instances.sync_scope)     all = todas; known = só de quem já é contato (+ lead de anúncio)
 *
 * Body: { locationId, instanceName, displayName?, signatureMode?, signatureName?, syncScope? } — ao menos um.
 * O `locationId` e guard obrigatorio: sem ele, saber o nome da instancia
 * bastaria pra mexer na configuracao de outra subconta.
 */
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const locationId = typeof body?.locationId === 'string' ? body.locationId.trim() : '';
    const instanceName = typeof body?.instanceName === 'string' ? body.instanceName.trim() : '';

    if (!locationId || !instanceName) {
      return json({ ok: false, error: 'locationId and instanceName are required' }, 400);
    }

    const update: Record<string, unknown> = {};

    if (body?.displayName !== undefined) {
      if (typeof body.displayName !== 'boolean') {
        return json({ ok: false, error: 'displayName must be a boolean' }, 400);
      }
      update.display_name = body.displayName;
    }

    if (body?.signatureMode !== undefined) {
      if (!SIGNATURE_MODES.includes(body.signatureMode)) {
        return json({ ok: false, error: `signatureMode must be one of: ${SIGNATURE_MODES.join(', ')}` }, 400);
      }
      update.signature_mode = body.signatureMode;
    }

    if (body?.signatureName !== undefined) {
      if (body.signatureName !== null && typeof body.signatureName !== 'string') {
        return json({ ok: false, error: 'signatureName must be a string or null' }, 400);
      }
      update.signature_name = cleanSignatureName(body.signatureName);
    }

    if (body?.syncScope !== undefined) {
      if (!SYNC_SCOPES.includes(body.syncScope)) {
        return json({ ok: false, error: `syncScope must be one of: ${SYNC_SCOPES.join(', ')}` }, 400);
      }
      update.sync_scope = body.syncScope;
    }

    if (Object.keys(update).length === 0) {
      return json({ ok: false, error: 'Nothing to update: send displayName, signatureMode, signatureName or syncScope' }, 400);
    }
    if (update.signature_mode === 'custom' && !update.signature_name) {
      return json({ ok: false, error: 'signatureName is required when signatureMode is custom' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      return json({ ok: false, error: 'Missing Supabase environment variables' }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase
      .from('instances')
      .update({ ...update, updated_at: new Date().toISOString() })
      .eq('evolution_name', instanceName)
      .eq('location_id', locationId)
      .select('id, evolution_name, location_id, display_name, signature_mode, signature_name, sync_scope');

    if (error) {
      console.error('[instance-settings] Update error:', JSON.stringify(error));
      return json({ ok: false, error: 'Failed to update instance', details: error.message }, 500);
    }

    if (!data || data.length === 0) {
      console.warn(`[instance-settings] No instance ${instanceName} for location ${locationId}`);
      return json({ ok: false, error: 'Instance not found for this location' }, 404);
    }

    console.log(`[instance-settings] ${instanceName} (location=${locationId}) ${JSON.stringify(update)}`);

    return json({
      ok: true,
      instance: {
        instanceName: data[0].evolution_name,
        displayName: data[0].display_name === true,
        signatureMode: data[0].signature_mode || 'full',
        signatureName: data[0].signature_name || null,
        syncScope: data[0].sync_scope === 'known' ? 'known' : 'all',
      },
    });
  } catch (error: any) {
    console.error('[instance-settings] Unhandled error:', error);
    return json({ ok: false, error: 'Internal server error', details: error?.message }, 500);
  }
});

// O nome vai dentro de `*...*` no WhatsApp: tira os marcadores de formatacao e a quebra de linha,
// que quebrariam o negrito ou a linha da assinatura. Vazio vira null.
function cleanSignatureName(raw: string | null): string | null {
  if (raw === null) return null;
  const cleaned = raw.replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim().slice(0, SIGNATURE_NAME_MAX).trim();
  return cleaned || null;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
