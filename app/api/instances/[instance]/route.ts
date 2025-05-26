import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"


export async function DELETE(
    req: NextRequest,
    context: { params: Promise<{ instance: string }> }
) {
    const { instance } = await context.params

    try {
        const res = await fetch(
            `https://api.homio.com.br/webhook/deleteInstance/?instanceName=${instance}`,
            {
                method: "DELETE",
                headers: {
                    Token: process.env.N8N_TOKEN!,
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
