import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// evolution-create-instance-v2 v24 (2026-10-21) — slot 5 e entitlement por subconta
//  - `conversationProvider` passou a ser OPCIONAL: sem ele, o provider vem da tabela `providers`
//    pelo slot da instancia (`providers.slot` = sufixo <locationId>-<n>). O front deixa de carregar
//    a lista NEXT_PUBLIC_PROVIDER1..4. Com ele (compat / teste), continua valendo o informado.
//  - Provider desconhecido e ERRO VISIVEL (400 provider_unknown). Ate a v23 caia no fallback
//    `provider_id = 1`, que foi o que mascarou a quebra de linha do WA Homio 3 em 2026-10-15.
//  - Teto de instancias por subconta lido de `location_settings.max_instances` (sem linha = 4):
//    409 max_instances_reached. A EF e publica, entao o limite tem que ser aqui, nao so no front.
//  - Nome da subpasta de midia vem de `providers.name` (o mapa fixo ficou so de reserva).
// v23 (2026-10-15): MESSAGES_SET fora do webhook. v20 (2026-08-04): orfa pareada e purgada.

const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') || '';
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') || '';
const GHL_COMPANY_ID = Deno.env.get('GHL_COMPANY_ID') || '3PL31w5rI7KFAU9Hfd8Y';

const DEFAULT_MAX_INSTANCES = 4;

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Reserva, caso a linha de `providers` venha sem nome.
const PROVIDER_FOLDER_FALLBACK: Record<string, string> = {
  '67b8e49217347407acca7fd1': 'Whats Homio',
  '67a4fa35ffae7881f31684f3': 'WA Homio',
  '679d1e13fe8b77fa62001590': 'WA Homio 2',
  '67a39b0a1d291e601c80c311': 'WA Homio 3',
  '68655eb3f257d80a13a28216': 'WA Homio 4',
};

function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

type ExistsCheck = {
  exists: boolean;
  instanceId?: string;
  hash?: string;
  connectionStatus?: string | null;
  ownerJid?: string | null;
  profileName?: string | null;
};

async function checkInstanceExists(instanceName: string): Promise<ExistsCheck> {
  try {
    const res = await fetchWithTimeout(
      `${EVOLUTION_API_URL}/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`,
      { headers: { apikey: EVOLUTION_API_KEY } },
      10000
    );
    if (!res.ok) return { exists: false };
    const data = await res.json();
    const instances = Array.isArray(data) ? data : [data];
    const found = instances.find((i: any) => i.name === instanceName || i.instance?.instanceName === instanceName);
    if (found) {
      console.log(`[create-instance] Instance ${instanceName} already exists in Evolution API`);
      return {
        exists: true,
        instanceId: found.id || found.instance?.instanceId || '',
        hash: found.token || found.hash || '',
        // Sinais de PAREAMENTO ANTERIOR: se tem dono ou esta open, nao e casca de timeout.
        connectionStatus: found.connectionStatus ?? found.instance?.state ?? null,
        ownerJid: found.ownerJid ?? found.instance?.owner ?? null,
        profileName: found.profileName ?? found.instance?.profileName ?? null,
      };
    }
    return { exists: false };
  } catch (e: any) {
    console.warn(`[create-instance] Could not check if instance exists: ${e.message}`);
    return { exists: false };
  }
}

// Confirma que a instancia sumiu da Evolution (nao confia no status do DELETE).
async function stillExistsInEvolution(instanceName: string): Promise<boolean> {
  const check = await checkInstanceExists(instanceName);
  return check.exists;
}

// A Evolution ora expoe restart como PUT, ora como POST. Tenta os dois.
async function evoRestart(instanceName: string): Promise<string> {
  for (const method of ['PUT', 'POST']) {
    try {
      const res = await fetchWithTimeout(
        `${EVOLUTION_API_URL}/instance/restart/${encodeURIComponent(instanceName)}`,
        { method, headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY } },
        15000
      );
      if (res.ok) return `${method}=${res.status}`;
      if (res.status !== 404 && res.status !== 405) return `${method}=${res.status}`;
    } catch (e: any) {
      return `${method}=erro:${e.message}`;
    }
  }
  return 'indisponivel';
}

/**
 * Remove da Evolution uma instancia ORFA (existe la, nao existe no nosso DB) que ja teve
 * pareamento. Mesma escalada da `evolution-delete-instance`: instancia com socket Baileys
 * travado devolve logout=500 + delete=400 pra sempre e so destrava com restart.
 *   1. logout -> delete
 *   2. restart -> logout -> delete
 *   3. restart -> espera mais -> logout -> delete
 */
async function purgeEvolutionInstance(instanceName: string): Promise<{ ok: boolean; details: string[] }> {
  const details: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      details.push(`restart#${attempt}=${await evoRestart(instanceName)}`);
      await sleep(attempt === 2 ? 4000 : 8000);
    }

    try {
      const logoutRes = await fetchWithTimeout(
        `${EVOLUTION_API_URL}/instance/logout/${encodeURIComponent(instanceName)}`,
        { method: 'DELETE', headers: { apikey: EVOLUTION_API_KEY } },
        15000
      );
      details.push(`logout#${attempt}=${logoutRes.status}`);
    } catch (e: any) {
      details.push(`logout#${attempt}=erro:${e.message}`);
    }

    await sleep(attempt === 1 ? 800 : 2000);

    try {
      const delRes = await fetchWithTimeout(
        `${EVOLUTION_API_URL}/instance/delete/${encodeURIComponent(instanceName)}`,
        { method: 'DELETE', headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY } },
        15000
      );
      details.push(`delete#${attempt}=${delRes.status}`);
    } catch (e: any) {
      details.push(`delete#${attempt}=erro:${e.message}`);
    }

    if (!(await stillExistsInEvolution(instanceName))) {
      details.push(`confirmado_removido#${attempt}`);
      return { ok: true, details };
    }
    details.push(`ainda_existe#${attempt}`);
  }

  return { ok: false, details };
}

async function getGHLToken(locationId: string): Promise<string | null> {
  try {
    const res = await fetch('https://services.leadconnectorhq.com/oauth/locationToken', {
      method: 'POST',
      headers: {
        'Version': '2021-07-28',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ locationId, companyId: GHL_COMPANY_ID }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token || null;
  } catch (_e) {
    return null;
  }
}

async function createGHLFolders(
  locationId: string,
  instanceFolderName: string,
  instanceDbId: number,
  supabase: ReturnType<typeof createClient>
): Promise<void> {
  console.log('[create-instance] Creating GHL media folders...');

  const token = await getGHLToken(locationId);
  if (!token) {
    console.error('[create-instance] No GHL token for folder creation');
    return;
  }

  const ghlHeaders: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': 'Bearer ' + token,
    'Version': '2021-07-28',
  };

  const foldersRes = await fetch(
    'https://services.leadconnectorhq.com/medias/files?sortBy=createdAt&sortOrder=asc&type=folder&altType=location&altId=' + locationId,
    { headers: ghlHeaders }
  );
  if (!foldersRes.ok) {
    console.error('[create-instance] Failed to list GHL folders');
    return;
  }

  const foldersData = await foldersRes.json();
  let whatsappFolder = (foldersData.files || []).find((f: any) => f.name === 'Whatsapp Homio');

  if (!whatsappFolder) {
    console.log('[create-instance] Creating Whatsapp Homio folder');
    const createRes = await fetch('https://services.leadconnectorhq.com/medias/folder', {
      method: 'POST',
      headers: { ...ghlHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ altId: locationId, altType: 'location', name: 'Whatsapp Homio' }),
    });
    if (createRes.ok) {
      whatsappFolder = await createRes.json();
    } else {
      console.error('[create-instance] Failed to create Whatsapp Homio folder');
      return;
    }
  }

  const whatsappFolderId = whatsappFolder._id || whatsappFolder.id;
  if (!whatsappFolderId) {
    console.error('[create-instance] No Whatsapp Homio folder ID');
    return;
  }

  const subFoldersRes = await fetch(
    'https://services.leadconnectorhq.com/medias/files?sortBy=createdAt&sortOrder=asc&type=folder&altType=location&altId=' + locationId + '&parentId=' + whatsappFolderId,
    { headers: ghlHeaders }
  );

  let instanceFolder: any = null;
  if (subFoldersRes.ok) {
    const subData = await subFoldersRes.json();
    instanceFolder = (subData.files || []).find((f: any) => f.name === instanceFolderName);
  }

  if (!instanceFolder) {
    console.log('[create-instance] Creating subfolder: ' + instanceFolderName);
    const createSubRes = await fetch('https://services.leadconnectorhq.com/medias/folder', {
      method: 'POST',
      headers: { ...ghlHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        altId: locationId,
        altType: 'location',
        name: instanceFolderName,
        parentId: whatsappFolderId,
      }),
    });
    if (createSubRes.ok) {
      instanceFolder = await createSubRes.json();
    } else {
      console.error('[create-instance] Failed to create subfolder');
      return;
    }
  }

  const instanceFolderId = instanceFolder._id || instanceFolder.id;
  if (instanceFolderId) {
    const { error } = await supabase
      .from('instances')
      .update({ instance_folder_id: instanceFolderId })
      .eq('id', instanceDbId);
    if (error) {
      console.error('[create-instance] Failed to update instance_folder_id:', error);
    } else {
      console.log('[create-instance] Folder ID saved: ' + instanceFolderId);
    }
  }
}

type ProviderRow = { id: number; name: string | null; provider_id: string; slot: number | null };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonRes({ error: 'Method not allowed' }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }

  const locationId: string = body.locationId || '';
  const requestedProvider: string = String(body.conversationProvider || '').trim();
  const shouldConnect: boolean = body.connectInstance !== false;

  // Toggle de sincronizacao de grupo. Default: IGNORA grupos (comportamento historico da
  // Evolution — evita poluir o GHL de quem nao usa grupo). Passar syncGroups:true (ou
  // groupsIgnore:false) faz a instancia RECEBER mensagens de grupo — o inbound cria o
  // contato-grupo no GHL automaticamente (feature GHL<->grupo). Sem o toggle, grupo continua
  // ignorado ate desligar manualmente na Evolution (PUT /settings/set).
  const groupsIgnore: boolean = !(body.syncGroups === true || body.groupsIgnore === false);

  if (!locationId) {
    return jsonRes({ error: 'Missing required field: locationId' }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  );

  try {
    // Step 1: Query existing instances for this location
    const { data: existingInstances, error: queryError } = await supabase
      .from('instances')
      .select('id, evolution_name')
      .eq('location_id', locationId)
      .order('id', { ascending: true });

    if (queryError) {
      console.error('[create-instance] Query error:', queryError);
      return jsonRes({ error: 'Failed to query existing instances' }, 500);
    }

    // Step 1b: Teto de slots da subconta (location_settings; sem linha = 4).
    let maxInstances = DEFAULT_MAX_INSTANCES;
    const { data: settings } = await supabase
      .from('location_settings')
      .select('max_instances')
      .eq('location_id', locationId)
      .maybeSingle();
    if (settings?.max_instances) maxInstances = Number(settings.max_instances);

    if ((existingInstances || []).length >= maxInstances) {
      console.warn(`[create-instance] ${locationId}: ja tem ${(existingInstances || []).length} instancias, teto ${maxInstances}`);
      return jsonRes({
        error: 'max_instances_reached',
        message: `Esta subconta ja usa os ${maxInstances} numeros de WhatsApp do plano. Fale com a Homio para liberar mais.`,
        maxInstances,
      }, 409);
    }

    // Step 2: Auto-number — preenche o menor sufixo livre (1, 2, 3, ...).
    // Count + 1 quebrava com gaps (ex: so existe -2 -> next=2 -> 409 eterno).
    // MAX + 1 funcionava mas pulava buracos (so existe -2 -> proxima -3, deixando -1 vazio).
    // Logica certa: itera 1.. e usa o primeiro numero que nao existe no DB.
    const suffixRegex = new RegExp('^' + locationId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$');
    const usedNumbers = new Set<number>();
    for (const i of existingInstances || []) {
      const m = (i as any).evolution_name?.match(suffixRegex);
      if (m) usedNumbers.add(parseInt(m[1], 10));
    }
    let nextNumber = 1;
    while (usedNumbers.has(nextNumber)) nextNumber++;
    const instanceName = locationId + '-' + String(nextNumber);

    console.log('[create-instance] ' + locationId + ': used=[' + Array.from(usedNumbers).sort((a, b) => a - b).join(',') + '] -> ' + instanceName + ' groupsIgnore=' + groupsIgnore + ' max=' + maxInstances);

    const isDuplicate = (existingInstances || []).some(
      (i: any) => i.evolution_name === instanceName
    );
    if (isDuplicate) {
      return jsonRes({ error: 'Instance ' + instanceName + ' already exists', instanceName }, 409);
    }

    // Step 2b: Provider do slot — ANTES de criar na Evolution, pra provider errado nao deixar
    // instancia pela metade. Informado no body: tem que existir em `providers`. Omitido: o da
    // linha cujo `slot` = sufixo da instancia.
    let providerRow: ProviderRow | null = null;
    if (requestedProvider) {
      const { data } = await supabase
        .from('providers')
        .select('id, name, provider_id, slot')
        .eq('provider_id', requestedProvider)
        .limit(1)
        .maybeSingle();
      providerRow = (data as ProviderRow | null) ?? null;
      if (!providerRow) {
        console.error(`[create-instance] provider desconhecido: "${requestedProvider}"`);
        return jsonRes({ error: 'provider_unknown', message: `Conversation provider ${requestedProvider} nao esta cadastrado em providers`, conversationProvider: requestedProvider }, 400);
      }
    } else {
      const { data } = await supabase
        .from('providers')
        .select('id, name, provider_id, slot')
        .eq('slot', nextNumber)
        .limit(1)
        .maybeSingle();
      providerRow = (data as ProviderRow | null) ?? null;
      if (!providerRow) {
        console.error(`[create-instance] sem provider cadastrado para o slot ${nextNumber}`);
        return jsonRes({ error: 'provider_slot_unavailable', message: `Nao ha Conversation Provider cadastrado para o slot ${nextNumber}`, slot: nextNumber }, 400);
      }
    }
    const conversationProvider = providerRow.provider_id.trim();
    const providerIdFK = providerRow.id;
    const providerName = (providerRow.name || '').trim() || PROVIDER_FOLDER_FALLBACK[conversationProvider] || 'WhatsApp Instance';
    console.log(`[create-instance] slot ${nextNumber} -> provider ${providerName} (${conversationProvider}, fk=${providerIdFK})${requestedProvider ? ' [informado no body]' : ''}`);

    // Step 3: A instancia ja existe na Evolution mas nao no nosso DB. Dois casos MUITO
    // diferentes, que ate 2026-08-04 eram tratados igual:
    //
    //   (a) CASCA de timeout — o /instance/create anterior estourou os 30s mas vingou do
    //       lado da Evolution. Nunca foi pareada. Recuperar e o certo.
    //   (b) ORFA de pareamento antigo — instancia com dono (ownerJid) ou 'open', que ficou
    //       viva na Evolution porque o delete falhou e a linha do DB foi apagada assim mesmo.
    //       Recuperar aqui era o BUG: nao nascia instancia nova, o /instance/connect nao
    //       devolvia QR (a sessao ja tinha credencial) e o card ficava "Conectado" com o
    //       NUMERO ANTIGO — o cliente nunca via o QR pra parear o dele.
    //
    // Distincao: ownerJid preenchido ou connectionStatus 'open' => (b). Nesse caso purga
    // (logout + delete + confirma, com restart na escalada) e cria do zero. Se a purga
    // falhar, ERRO VISIVEL — seguir em frente reintroduz exatamente o bug.
    const existsCheck = await checkInstanceExists(instanceName);

    let reuseShell = false;
    let purgedOrphan = false;

    if (existsCheck.exists) {
      const pairedWith = existsCheck.ownerJid ? String(existsCheck.ownerJid).split('@')[0] : null;
      const wasPaired = !!pairedWith || existsCheck.connectionStatus === 'open';

      if (wasPaired) {
        console.warn(
          `[create-instance] ORFA detectada: ${instanceName} existe na Evolution pareada com ` +
          `${pairedWith ?? '(sem jid)'} (status=${existsCheck.connectionStatus}, perfil=${existsCheck.profileName}) ` +
          `e nao esta no DB. Purgando antes de criar.`
        );
        const purge = await purgeEvolutionInstance(instanceName);
        console.log(`[create-instance] purge ${instanceName}: ok=${purge.ok} [${purge.details.join(' ')}]`);

        if (!purge.ok) {
          return jsonRes({
            error: 'orphan_instance_not_purgeable',
            message:
              `A instancia ${instanceName} ja existe na Evolution API pareada com ` +
              `${pairedWith ?? 'outro numero'} e nao pode ser removida automaticamente. ` +
              `Criar por cima reusaria aquela sessao e a instancia apareceria como conectada ` +
              `no numero errado, sem QR. Remova a instancia manualmente na Evolution e tente de novo.`,
            instanceName,
            pairedWith,
            profileName: existsCheck.profileName ?? null,
            evolution_attempts: purge.details,
          }, 409);
        }

        purgedOrphan = true;
        await sleep(1500); // deixa a Evolution assentar antes do create
      } else {
        console.log(`[create-instance] Recovering orphaned shell ${instanceName} (sem pareamento) from Evolution API`);
        reuseShell = true;
      }
    }

    let evolutionId = '';
    let instanceApiKey = '';

    if (reuseShell) {
      evolutionId = existsCheck.instanceId || '';
      instanceApiKey = existsCheck.hash || '';
    } else {
      try {
        const evoRes = await fetchWithTimeout(
          EVOLUTION_API_URL + '/instance/create/',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
            body: JSON.stringify({
              instanceName,
              qrcode: true,
              groupsIgnore,
              integration: 'WHATSAPP-BAILEYS',
              websocket_enabled: true,
            }),
          },
          30000
        );

        if (!evoRes.ok) {
          const errText = await evoRes.text();
          console.error('[create-instance] Evolution error ' + evoRes.status + ': ' + errText);
          return jsonRes({ error: 'Failed to create instance in Evolution API', details: errText }, 502);
        }

        const evoResult = await evoRes.json();
        evolutionId = evoResult.instance?.instanceId || '';
        instanceApiKey = evoResult.hash || '';
      } catch (e: any) {
        if (e.name === 'AbortError') {
          console.warn('[create-instance] Evolution API timed out (30s), checking if instance was created...');
          await sleep(2000);
          const retryCheck = await checkInstanceExists(instanceName);
          if (retryCheck.exists) {
            console.log('[create-instance] Instance was created despite timeout, recovering...');
            evolutionId = retryCheck.instanceId || '';
            instanceApiKey = retryCheck.hash || '';
          } else {
            return jsonRes({ error: 'Evolution API timed out and instance was not created. Please try again.' }, 504);
          }
        } else {
          throw e;
        }
      }
    }

    console.log('[create-instance] Evolution OK: ' + instanceName + ' id=' + evolutionId);

    // Step 4: Configure webhook — always point to Supabase Edge Function
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const webhookUrl = `${supabaseUrl}/functions/v1/evolution-receive-message`;
    console.log('[create-instance] Webhook URL: ' + webhookUrl);

    let webhookConfigured = false;
    try {
      const wRes = await fetchWithTimeout(
        EVOLUTION_API_URL + '/webhook/set/' + instanceName,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
          body: JSON.stringify({
            webhook: {
              enabled: true,
              url: webhookUrl,
              byEvents: false,
              base64: false,
              events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'SEND_MESSAGE', 'CONNECTION_UPDATE'],
            },
          }),
        },
        15000
      );
      webhookConfigured = wRes.ok;
    } catch (_e) {
      console.warn('[create-instance] Webhook setup failed');
    }

    // Step 5: Save to DB (provider ja resolvido no Step 2b)
    const { data: savedInstance, error: insertError } = await supabase
      .from('instances')
      .insert({
        evolution_name: instanceName,
        evolution_id: evolutionId,
        location_id: locationId,
        provider_id: providerIdFK,
        display_name: false,
        number_connected: null,
        name_connected: null,
        status: 'connecting',
        status_reason: 'Instance created, awaiting QR code scan',
        conversation_provider: conversationProvider,
        instance_api_key: instanceApiKey,
        webhook_url: webhookUrl,
        token_creation_date: new Date().toISOString(),
        instance_folder_id: null,
      })
      .select()
      .single();

    if (insertError) {
      console.error('[create-instance] DB insert failed:', insertError);
      return jsonRes({ error: 'Created in Evolution but DB save failed', details: insertError.message, instanceName }, 500);
    }

    console.log('[create-instance] DB saved: id=' + savedInstance.id);

    // Step 6: QR Code
    let qrCode: string | null = null;
    if (shouldConnect) {
      await sleep(2000);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const qrRes = await fetchWithTimeout(
            EVOLUTION_API_URL + '/instance/connect/' + instanceName,
            { headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY } },
            10000
          );
          if (qrRes.ok) {
            const qrData = await qrRes.json();
            qrCode = qrData.base64 || (qrData.qrcode ? qrData.qrcode.base64 : null) || null;
            if (qrCode) {
              console.log('[create-instance] QR OK attempt ' + (attempt + 1));
              break;
            }
          }
        } catch (_e) {
          console.warn('[create-instance] QR attempt ' + (attempt + 1) + ' failed');
        }
        if (attempt < 2) await sleep(1500);
      }
      if (!qrCode) {
        // Sem QR numa instancia recem-criada e sinal de sessao herdada — era o sintoma do bug.
        console.warn('[create-instance] ATENCAO: instancia nova ' + instanceName + ' sem QR apos 3 tentativas');
      }
    }

    // Step 7: GHL folders (fire and forget)
    createGHLFolders(locationId, providerName, savedInstance.id, supabase)
      .catch((err) => console.error('[create-instance] GHL folders error:', err));

    // Step 8: Response
    return jsonRes({
      success: true,
      data: {
        id: savedInstance.id,
        instanceName,
        instanceId: evolutionId,
        locationId,
        instanceNumber: nextNumber,
        maxInstances,
        status: 'connecting',
        conversationProvider,
        providerName,
        webhookConfigured,
        groupsIgnore,
        qrCode,
        recovered: reuseShell,
        purgedOrphan,
      },
    });
  } catch (error) {
    console.error('[create-instance] Unhandled:', error);
    return jsonRes({ error: 'Internal server error', details: (error as any).message }, 500);
  }
});
