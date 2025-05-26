import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url)
    const instance = searchParams.get("instance")
    if (!instance) {
        return NextResponse.json({ error: "instance is required" }, { status: 400 })
    }
    try {
        await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/api/emit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(instance),
        });

        return NextResponse.json({ ok: true });
    } catch (err) {
        console.error('Erro ao emitir evento via socket:', err);
        return NextResponse.json(
            { error: 'Falha ao emitir via WebSocket' },
            { status: 500 }
        );
    }
}