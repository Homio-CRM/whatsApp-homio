import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// This route is kept for backward compatibility with the Evolution webhook orchestrator.
// When a connection update happens, the orchestrator can call this endpoint,
// and we simply return OK. The frontend now uses Supabase Realtime instead of Socket.io.
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url)
    const instance = searchParams.get("instance")
    if (!instance) {
        return NextResponse.json({ error: "instance is required" }, { status: 400 })
    }
    try {
        // No-op: Supabase Realtime handles live updates now.
        // The orchestrator updates the instances table directly,
        // and the frontend subscribes to postgres_changes.
        console.log(`[connection-update] Received for instance: ${instance} (handled by Supabase Realtime)`)
        return NextResponse.json({ ok: true });
    } catch (err) {
        console.error('Erro ao processar connection-update:', err);
        return NextResponse.json(
            { error: 'Falha ao processar atualização' },
            { status: 500 }
        );
    }
}
