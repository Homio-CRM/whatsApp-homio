import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url)
    const token = searchParams.get("token")
    try {
        if (!token) {
            return NextResponse.json({ error: "token is required" }, { status: 400 })
        }
        const res = await fetch(`https://api.homio.com.br/webhook/get-evolution-instances`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(token),
        });
        if (!res.ok) {
            const text = await res.text();
            return NextResponse.json(
                { error: `Erro ao chamar API externa: ${res.status} - ${text}` },
                { status: res.status }
            );
        }
        const json = await res.json()
        if (json == null) {
            return NextResponse.json(
                { error: "Resposta da API veio vazia." },
                { status: 502 }
            );
        }
        return NextResponse.json(json);
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 }
        )
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json() as {
                instanceName?: string;
                location?: {
                name?: string;
                id?: string;
                provider?: string;
            }
        }

        const { instanceName, location } = body
        if (!instanceName) {
            return NextResponse.json(
                { error: 'instanceName is required' },
                { status: 400 }
            )
        }
        if (
            !location ||
            typeof location.name !== 'string' ||
            typeof location.id !== 'string' ||
            typeof location.provider !== 'string'
        ) {
            return NextResponse.json(
                { error: 'location.name, location.id and location.provider are required' },
                { status: 400 }
            )
        }

        const res = await fetch(
            'https://api.homio.com.br/webhook/criar-instancia',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ instanceName, location }),
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
