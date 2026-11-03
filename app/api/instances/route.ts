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

        // Token SSO da GHL → locationId pela Edge Function ghl-sso (secret GHL_SSO_KEY no Supabase).
        // 2026-11-03: o fallback pelo webhook n8n `get-evolution-instances` saiu. De 28/10 a 03/11 foram
        // 160 aberturas, todas 200 na EF, e o n8n era o ponto que ja derrubou a pagina com a SSO Key velha.
        if (token) {
            const sso = await resolveViaEdgeFunction(token)
            if ('error' in sso) return NextResponse.json({ error: sso.error }, { status: sso.status })
            return await fetchFromSupabase(sso.locationId)
        }

        return NextResponse.json({ error: "token or locationId is required" }, { status: 400 })
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 }
        )
    }
}

async function resolveViaEdgeFunction(token: string): Promise<{ locationId: string } | { error: string; status: number }> {
    try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/ghl-sso`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
            body: JSON.stringify({ token }),
            signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) {
            const text = await res.text()
            console.warn(`[sso] ghl-sso ${res.status}: ${text.slice(0, 200)}`)
            // 401 = token que a SSO Key atual nao abre (sessao velha ou chave rotacionada na GHL)
            return { error: `Token resolution failed: ${res.status} - ${text.slice(0, 200)}`, status: res.status }
        }
        const data = await res.json()
        if (typeof data?.locationId === 'string' && data.locationId) return { locationId: data.locationId }
        return { error: 'Could not resolve locationId from token', status: 400 }
    } catch (e) {
        console.warn('[sso] ghl-sso falhou:', e instanceof Error ? e.message : e)
        return { error: 'Token resolution failed: ghl-sso indisponivel', status: 502 }
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
