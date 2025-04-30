import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url)
    const locationId = searchParams.get("locationId")
    if (!locationId) {
        return NextResponse.json({ error: "locationId is required" }, { status: 400 })
    }
    const res = await fetch(
        `https://api.homio.com.br/webhook/get-evolution-instances?locationId=${locationId}`,
        { headers: { Token: process.env.N8N_TOKEN! } }
    )
    if (!res.ok) {
        return NextResponse.json({ error: `HTTP ${res.status}` }, { status: res.status })
    }
    const json = await res.json()
    return NextResponse.json(json)
}

export async function POST(req: NextRequest) {
    try {
        const { instanceName } = (await req.json()) as { instanceName?: string }
        if (!instanceName) {
            return NextResponse.json(
                { error: "instanceName is required" },
                { status: 400 }
            )
        }

        const res = await fetch(
            "https://api.homio.com.br/webhook-test/criar-instancia",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ instanceName }),
            }
        )

        if (!res.ok) {
            return NextResponse.json(
                { error: `HTTP ${res.status}: ${res.statusText}` },
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

