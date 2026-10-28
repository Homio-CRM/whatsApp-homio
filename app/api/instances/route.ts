import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url)
    const token = searchParams.get("token")
    const locationId = searchParams.get("locationId")

    try {
        // If we have locationId, go directly to Supabase
        if (locationId) {
            return await fetchFromSupabase(locationId)
        }

        // If we have token, resolve it via n8n first to get locationId, then fetch from Supabase
        if (token) {
            // Step 1a (2026-10-28): decifra o SSO na Edge Function ghl-sso (secret GHL_SSO_KEY no Supabase).
            // Sem o secret, ou se ela falhar, segue para o n8n como antes.
            const ssoLocationId = await resolveViaEdgeFunction(token)
            if (ssoLocationId) return await fetchFromSupabase(ssoLocationId)

            // Step 1b: Resolve token → locationId via n8n (fallback)
            const n8nRes = await fetch('https://api.homio.com.br/webhook/get-evolution-instances', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
            })

            if (!n8nRes.ok) {
                const text = await n8nRes.text()
                return NextResponse.json(
                    { error: `Token resolution failed: ${n8nRes.status} - ${text}` },
                    { status: n8nRes.status }
                )
            }

            const n8nData = await n8nRes.json()
            const resolvedLocationId = n8nData?.locationId

            if (!resolvedLocationId) {
                return NextResponse.json(
                    { error: "Could not resolve locationId from token" },
                    { status: 400 }
                )
            }

            // Step 2: Fetch instances from Supabase
            return await fetchFromSupabase(resolvedLocationId)
        }

        return NextResponse.json({ error: "token or locationId is required" }, { status: 400 })
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 }
        )
    }
}

async function resolveViaEdgeFunction(token: string): Promise<string | null> {
    try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/ghl-sso`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
            body: JSON.stringify({ token }),
            signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) {
            console.warn(`[sso] ghl-sso ${res.status}; usando o n8n`)
            return null
        }
        const data = await res.json()
        return typeof data?.locationId === 'string' && data.locationId ? data.locationId : null
    } catch (e) {
        console.warn('[sso] ghl-sso falhou; usando o n8n:', e instanceof Error ? e.message : e)
        return null
    }
}

async function fetchFromSupabase(locationId: string) {
    const res = await fetch(
        `${SUPABASE_URL}/functions/v1/evolution-get-instances?locationId=${encodeURIComponent(locationId)}`,
        {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            },
        }
    )

    if (!res.ok) {
        const text = await res.text()
        return NextResponse.json(
            { error: `Supabase error: ${res.status} - ${text}` },
            { status: res.status }
        )
    }

    const data = await res.json()
    return NextResponse.json(data)
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as {
            locationId?: string;
            instanceName?: string;
            location?: {
                name?: string;
                id?: string;
                provider?: string;
            }
        }

        // Forma atual (2026-10-21): { locationId } — slot e provider sao escolhidos pela EF.
        // Forma antiga: { instanceName, location: { id, provider } } — ainda aceita; o provider
        // informado e repassado e a EF valida contra a tabela providers.
        const locationId = body.locationId || body.location?.id
        const conversationProvider = body.location?.provider
        if (typeof locationId !== 'string' || !locationId) {
            return NextResponse.json({ error: 'locationId is required' }, { status: 400 })
        }

        const res = await fetch(
            `${SUPABASE_URL}/functions/v1/evolution-create-instance-v2`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                },
                body: JSON.stringify({
                    locationId,
                    ...(typeof conversationProvider === 'string' && conversationProvider ? { conversationProvider } : {}),
                    connectInstance: true,
                }),
            }
        )

        if (!res.ok) {
            const errorText = await res.text()
            return NextResponse.json(
                { error: errorText || `HTTP ${res.status}: ${res.statusText}` },
                { status: res.status }
            )
        }

        const data = await res.json()
        return NextResponse.json(data)
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        )
    }
}
