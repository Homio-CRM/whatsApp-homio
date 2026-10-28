import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, PATCH, OPTIONS',
};

/**
 * Atualiza configuracoes editaveis pelo cliente na pagina de conexao.
 *
 * Hoje so `displayName` (instances.display_name), que faz a `ghl-send-message`
 * prefixar cada texto enviado com `*Nome do usuario:*`.
 *
 * Body: { locationId, instanceName, displayName }
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
    const displayName = body?.displayName;

    if (!locationId || !instanceName) {
      return json({ ok: false, error: 'locationId and instanceName are required' }, 400);
    }
    if (typeof displayName !== 'boolean') {
      return json({ ok: false, error: 'displayName must be a boolean' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      return json({ ok: false, error: 'Missing Supabase environment variables' }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase
      .from('instances')
      .update({ display_name: displayName, updated_at: new Date().toISOString() })
      .eq('evolution_name', instanceName)
      .eq('location_id', locationId)
      .select('id, evolution_name, location_id, display_name');

    if (error) {
      console.error('[instance-settings] Update error:', JSON.stringify(error));
      return json({ ok: false, error: 'Failed to update instance', details: error.message }, 500);
    }

    if (!data || data.length === 0) {
      console.warn(`[instance-settings] No instance ${instanceName} for location ${locationId}`);
      return json({ ok: false, error: 'Instance not found for this location' }, 404);
    }

    console.log(`[instance-settings] ${instanceName} (location=${locationId}) display_name=${displayName}`);

    return json({
      ok: true,
      instance: {
        instanceName: data[0].evolution_name,
        displayName: data[0].display_name === true,
      },
    });
  } catch (error: any) {
    console.error('[instance-settings] Unhandled error:', error);
    return json({ ok: false, error: 'Internal server error', details: error?.message }, 500);
  }
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
