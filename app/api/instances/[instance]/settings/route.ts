import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export async function PATCH(
    req: NextRequest,
    context: { params: Promise<{ instance: string }> }
) {
    const { instance } = await context.params

    try {
        const body = await req.json() as { locationId?: string; displayName?: boolean }
        const { locationId, displayName } = body

        if (typeof locationId !== 'string' || !locationId) {
            return NextResponse.json({ error: 'locationId is required' }, { status: 400 })
        }
        if (typeof displayName !== 'boolean') {
            return NextResponse.json({ error: 'displayName must be a boolean' }, { status: 400 })
        }

        const res = await fetch(
            `${SUPABASE_URL}/functions/v1/instance-update-settings`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
                },
                body: JSON.stringify({ locationId, instanceName: instance, displayName }),
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
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 }
        )
    }
}
