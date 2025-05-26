import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ instance: string }> }
) {
    const { instance } = await params

    try {
        const res = await fetch(
            `https://whatsapp.homio.com.br/instance/logout/${encodeURIComponent(instance)}`,
            {
                method: "DELETE",
                headers: {
                    apiKey: process.env.EVOLUTION_API_KEY!,
                    "Content-Type": "application/json",
                },
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
