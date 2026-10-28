import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') ?? '';
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    let instanceName: string | null = null;

    if (req.method === 'DELETE') {
      const url = new URL(req.url);
      instanceName = url.searchParams.get('instanceName');
    } else {
      const body = await req.json();
      instanceName = body.instanceName || null;
    }

    if (!instanceName) {
      return json({ error: 'instanceName is required' }, 400);
    }

    console.log(`[delete-instance] Deleting: ${instanceName}`);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // 1. Delete from Evolution API
    try {
      const evoRes = await fetch(
        `${EVOLUTION_API_URL}/instance/delete/${encodeURIComponent(instanceName)}`,
        {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'apikey': EVOLUTION_API_KEY,
          },
        }
      );

      if (!evoRes.ok) {
        const errorText = await evoRes.text();
        console.warn(`[delete-instance] Evolution API returned ${evoRes.status}: ${errorText}`);
      } else {
        console.log(`[delete-instance] Deleted from Evolution API`);
      }
    } catch (evoErr: any) {
      console.warn(`[delete-instance] Evolution API call failed: ${evoErr.message}`);
    }

    // 2. Get ALL instance IDs matching this name (may be duplicates)
    const { data: instances } = await supabase
      .from('instances')
      .select('id')
      .eq('evolution_name', instanceName);

    if (instances && instances.length > 0) {
      const instanceIds = instances.map((i: any) => i.id);
      console.log(`[delete-instance] Found ${instanceIds.length} DB rows for ${instanceName}: ${instanceIds.join(', ')}`);

      // Delete messages for conversations of these instances
      const { data: conversations } = await supabase
        .from('conversations')
        .select('id')
        .in('instance_id', instanceIds);

      if (conversations && conversations.length > 0) {
        const convIds = conversations.map((c: any) => c.id);
        await supabase.from('messages').delete().in('conversation_id', convIds);
        await supabase.from('conversations').delete().in('instance_id', instanceIds);
        console.log(`[delete-instance] Deleted ${conversations.length} conversations and their messages`);
      }

      // Delete ALL matching instance rows
      const { error: deleteError } = await supabase
        .from('instances')
        .delete()
        .eq('evolution_name', instanceName);

      if (deleteError) {
        console.error(`[delete-instance] DB delete error:`, deleteError);
        return json({ error: 'Failed to delete from database', details: deleteError.message }, 500);
      }

      console.log(`[delete-instance] Deleted ${instanceIds.length} row(s) from DB`);
    } else {
      console.log(`[delete-instance] Instance not found in DB, may have been deleted already`);
    }

    return json({ success: true, message: `Instance ${instanceName} deleted` });

  } catch (error: any) {
    console.error('[delete-instance] Unhandled error:', error);
    return json({ error: 'Internal server error', details: error.message }, 500);
  }
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
