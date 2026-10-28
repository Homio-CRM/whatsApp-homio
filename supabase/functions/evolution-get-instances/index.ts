import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// evolution-get-instances v22 (2026-10-21)
//  - devolve `maxInstances` e `routingMode` lidos de `location_settings` (sem linha: 4 / 'provider').
//    E o que a pagina de conexao usa pra desenhar N cards em vez dos 4 fixos.
//  - `providerName` sai sem espaco sobrando (a linha 1 da tabela e 'Whats Homio ' com espaco).
// v21 (2026-10-20): signatureMode / signatureName.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const DEFAULT_MAX_INSTANCES = 4;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    let locationId: string | null = null;
    let checkEvolution = false;
    let filterInstanceName: string | null = null;

    if (req.method === 'GET') {
      const url = new URL(req.url);
      locationId = url.searchParams.get('locationId');
      checkEvolution = url.searchParams.get('checkEvolution') === 'true';
      filterInstanceName = url.searchParams.get('instanceName');
    } else if (req.method === 'POST') {
      const body = await req.json();
      locationId = body.locationId || null;
      checkEvolution = body.checkEvolution || false;
      filterInstanceName = body.instanceName || null;
    }

    if (!locationId) {
      return json({ error: 'locationId is required' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const evolutionUrl = Deno.env.get('EVOLUTION_API_URL');
    const evolutionKey = Deno.env.get('EVOLUTION_API_KEY');

    if (!supabaseUrl || !supabaseKey) {
      return json({ error: 'Missing Supabase environment variables' }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Query instances from DB
    let query = supabase
      .from('instances')
      .select('id, evolution_name, evolution_id, location_id, provider_id, display_name, signature_mode, signature_name, number_connected, name_connected, status, status_reason, conversation_provider, instance_api_key, created_at')
      .eq('location_id', locationId);

    if (filterInstanceName) {
      query = query.eq('evolution_name', filterInstanceName);
    }

    const { data: instances, error: queryError } = await query.order('id', { ascending: true });

    if (queryError) {
      console.error('Query error details:', JSON.stringify(queryError));
      return json({ error: 'Failed to query instances', details: queryError.message }, 500);
    }

    // If checkEvolution=true, fetch live status from Evolution API and update DB
    if (checkEvolution && evolutionUrl && evolutionKey && instances && instances.length > 0) {
      try {
        // If filtering by specific instance, only fetch that one (much faster)
        let evoInstances: any[] = [];
        if (filterInstanceName) {
          const evoRes = await fetch(
            `${evolutionUrl}/instance/fetchInstances?instanceName=${encodeURIComponent(filterInstanceName)}`,
            { headers: { apikey: evolutionKey } }
          );
          if (evoRes.ok) {
            const data = await evoRes.json();
            evoInstances = Array.isArray(data) ? data : [data];
          }
        } else {
          const evoRes = await fetch(`${evolutionUrl}/instance/fetchInstances`, {
            headers: { apikey: evolutionKey },
          });
          if (evoRes.ok) {
            evoInstances = await evoRes.json();
          }
        }

        const evoMap: Record<string, any> = {};
        for (const evo of evoInstances) {
          if (evo.name) {
            evoMap[evo.name] = evo;
          }
        }

        // Update DB status for each instance if it changed
        for (const inst of instances) {
          const evo = evoMap[inst.evolution_name];
          if (evo) {
            const liveStatus = evo.connectionStatus || null;
            const liveNumber = evo.ownerJid ? evo.ownerJid.split('@')[0] : null;
            const liveName = evo.profileName || null;

            const needsUpdate =
              (liveStatus && inst.status !== liveStatus) ||
              (liveNumber && inst.number_connected !== liveNumber) ||
              (liveName && inst.name_connected !== liveName);

            if (needsUpdate) {
              const updateData: any = {};
              if (liveStatus) updateData.status = liveStatus;
              if (liveNumber) updateData.number_connected = liveNumber;
              if (liveName) updateData.name_connected = liveName;

              await supabase
                .from('instances')
                .update(updateData)
                .eq('id', inst.id);

              // Update local object so response reflects live data
              if (liveStatus) inst.status = liveStatus;
              if (liveNumber) inst.number_connected = liveNumber;
              if (liveName) inst.name_connected = liveName;

              console.log(`Updated instance ${inst.evolution_name}: status=${liveStatus}, number=${liveNumber}, name=${liveName}`);
            }
          }
        }
      } catch (evoError: any) {
        console.error('Evolution API check failed (non-fatal):', evoError.message);
      }
    }

    // Get providers
    let providersMap: Record<number, any> = {};
    try {
      const { data: providers } = await supabase.from('providers').select('id, name, provider_id');
      if (providers) {
        for (const p of providers) {
          providersMap[p.id] = p;
        }
      }
    } catch (e) {
      console.error('Failed to fetch providers:', e);
    }

    // Entitlement da subconta: quantos slots a pagina oferece e como o envio escolhe a instancia.
    // Sem linha em location_settings = comportamento historico (4 slots, 1 provider por slot).
    let maxInstances = DEFAULT_MAX_INSTANCES;
    let routingMode = 'provider';
    try {
      const { data: settings } = await supabase
        .from('location_settings')
        .select('max_instances, routing_mode')
        .eq('location_id', locationId)
        .maybeSingle();
      if (settings?.max_instances) maxInstances = Number(settings.max_instances);
      if (settings?.routing_mode) routingMode = String(settings.routing_mode);
    } catch (e) {
      console.error('Failed to fetch location_settings (non-fatal):', e);
    }

    // Transform to match frontend Connection type
    const formatted = (instances || []).map((inst: any) => {
      const provider = providersMap[inst.provider_id];
      return {
        instanceName: inst.evolution_name,
        name: inst.name_connected || '',
        connectionStatus: inst.status || '',
        number: inst.number_connected || '',
        provider: inst.conversation_provider || provider?.provider_id || '',
        providerName: (provider?.name || '').trim(),
        // assinatura do atendente no envio (instances.display_name) — editavel na pagina de conexao
        displayName: inst.display_name === true,
        // texto da assinatura: first | full | custom (signatureName)
        signatureMode: inst.signature_mode || 'full',
        signatureName: inst.signature_name || null,
      };
    });

    return json({ instances: formatted, locationId, maxInstances, routingMode });

  } catch (error: any) {
    console.error('Unhandled error:', error);
    return json({ error: 'Internal server error', details: error.message }, 500);
  }
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
