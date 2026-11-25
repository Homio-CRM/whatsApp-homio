import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const EVENT_HANDLERS: Record<string, string> = {
  'connection.update': 'connection-update',
  'messages.delete': 'messages-delete',
  'messages.set': 'messages-set',
  'messages.update': 'messages-update',
  'messages.upsert': 'messages-upsert',
  'qrcode.update': 'qrcode-update',
  'send.message': 'send-message',
};

function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function generateEventHash(data: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(data))
  );
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const body = await req.json();
    const { event, instance, data, date_time } = body;
    console.log(`Webhook received: ${event} for instance: ${instance}`);

    // Generate event hash for deduplication
    const hashHex = await generateEventHash(body);

    // Save webhook event to database
    const { error: eventError } = await supabase
      .from('webhook_events')
      .insert({
        event_type: event,
        payload: body,
        event_time: date_time || new Date().toISOString(),
        event_hash: hashHex,
        handled: false,
      });

    if (eventError) {
      console.error('Error storing webhook event:', eventError);
    }

    // Route event to appropriate handler
    const handlerName = EVENT_HANDLERS[event];
    if (!handlerName) {
      console.warn(`No handler for event: ${event}`);
      return jsonRes({ success: true, handler: 'no-handler' });
    }

    console.log(`Routing ${event} to handler: ${handlerName}`);

    let result: { success: boolean; handler: string; error?: string };

    switch (handlerName) {
      case 'connection-update':
        result = await handleConnectionUpdate(supabase, body);
        break;
      case 'messages-upsert':
        result = await handleMessagesUpsert(body);
        break;
      default:
        result = { success: true, handler: handlerName };
        break;
    }

    if (result.success) {
      return jsonRes({ success: true, handler: result.handler });
    } else {
      console.error(`Handler failed for ${event}:`, result.error);
      return jsonRes({ error: 'Event handler failed', details: result.error }, 500);
    }
  } catch (error: any) {
    console.error('Error in webhook orchestrator:', error);
    return jsonRes({ error: 'Internal server error', details: error.message }, 500);
  }
});

async function handleConnectionUpdate(
  supabase: ReturnType<typeof createClient>,
  payload: any
): Promise<{ success: boolean; handler: string; error?: string }> {
  const { instance, data } = payload;
  const state = data?.state || data?.status || null;
  const statusReason = data?.statusReason || null;

  console.log(`[connection-update] Instance: ${instance}, state: ${state}, reason: ${statusReason}`);

  if (!instance || !state) {
    console.warn('[connection-update] Missing instance or state');
    return { success: true, handler: 'connection-update' };
  }

  try {
    const updateData: Record<string, any> = { status: state };

    if (statusReason !== null && statusReason !== undefined) {
      updateData.status_reason = String(statusReason);
    }

    // If connected, fetch owner info from Evolution API
    if (state === 'open') {
      const evolutionUrl = Deno.env.get('EVOLUTION_API_URL');
      const evolutionKey = Deno.env.get('EVOLUTION_API_KEY');

      if (evolutionUrl && evolutionKey) {
        try {
          const evoRes = await fetch(
            `${evolutionUrl}/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
            { headers: { apikey: evolutionKey } }
          );

          if (evoRes.ok) {
            const evoData = await evoRes.json();
            const evoInstance = Array.isArray(evoData) ? evoData[0] : evoData;

            if (evoInstance) {
              if (evoInstance.ownerJid) {
                updateData.number_connected = evoInstance.ownerJid.split('@')[0];
              }
              if (evoInstance.profileName) {
                updateData.name_connected = evoInstance.profileName;
              }
              console.log(`[connection-update] Owner: number=${updateData.number_connected}, name=${updateData.name_connected}`);
            }
          }
        } catch (evoError: any) {
          console.error('[connection-update] Failed to fetch owner info:', evoError.message);
        }
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('instances')
      .update(updateData)
      .eq('evolution_name', instance)
      .select('id, evolution_name, status');

    if (updateError) {
      console.error('[connection-update] DB update error:', updateError);
      return { success: false, handler: 'connection-update', error: updateError.message };
    }

    if (!updated || updated.length === 0) {
      console.warn(`[connection-update] Instance ${instance} not found in DB`);
    } else {
      console.log(`[connection-update] Updated ${instance} -> status=${state}`);
    }

    return { success: true, handler: 'connection-update' };
  } catch (error: any) {
    console.error('[connection-update] Error:', error);
    return { success: false, handler: 'connection-update', error: error.message };
  }
}

async function handleMessagesUpsert(
  payload: any
): Promise<{ success: boolean; handler: string; error?: string }> {
  const { instance, data } = payload;
  const key = data?.key;
  const message = data?.message;

  if (!key || !message) {
    return { success: true, handler: 'messages-upsert' };
  }

  console.log(`[messages-upsert] Instance: ${instance}, message: ${key.id}`);
  return { success: true, handler: 'messages-upsert' };
}
