import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export async function POST(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url)
        const locationId = searchParams.get("locationId")
        if (!locationId) {
            return NextResponse.json({ error: "locationId is required" }, { status: 400 })
        }
        const res = await fetch(
            'https://api.homio.com.br/webhook/request-whatsapp-meta',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ locationId }),
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