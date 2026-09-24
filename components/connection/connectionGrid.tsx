"use client"

import * as React from "react"
import { useState, useEffect } from "react"
import ConnectionCard from "./connectionCard"
import { useInstances } from "@/lib/context/useInstances"
import { QrCodeModal } from "./qrCodeModal"
import Loading from "../Loading"
import { supabase } from "@/lib/supabase"

type Acao = "excluir" | "desconectar" | "criar"

const SUPORTE = "Não precisa tentar de novo: fale com o suporte da Homio para liberar."

// Os route.ts repassam o corpo da Edge Function como string em `error`
// (ex.: '{"error":"evolution_delete_failed",...}'). Extrai o codigo de dentro.
async function lerCodigoDeErro(res: Response): Promise<string | null> {
  try {
    const body = await res.json()
    const bruto = body?.error
    if (typeof bruto !== "string") return null
    try { return JSON.parse(bruto)?.error ?? bruto } catch { return bruto }
  } catch { return null }
}

// Mensagem que o cliente entende, no lugar do erro cru. Os dois codigos nomeados
// sao instancia travada na Evolution (zumbi/orfa): tentar de novo nao resolve, a cura
// e o restart do container — por isso mandam pro suporte.
function mensagemAmigavel(acao: Acao, codigo: string | null): string {
  if (codigo === "evolution_delete_failed")
    return `Esta conexão está travada no servidor do WhatsApp e não pôde ser removida. ${SUPORTE}`
  if (codigo === "orphan_instance_not_purgeable")
    return `Há uma conexão antiga travada neste espaço e não conseguimos limpá-la para criar a nova. ${SUPORTE}`
  return `Não foi possível ${acao} a conexão. Tente novamente em alguns instantes; se continuar, fale com o suporte da Homio.`
}

export function ConnectionGrid({ onAction }: { onAction?: (instanceName: string) => void }) {
  const { instances, locationId, isLoading, error, refreshInstances } = useInstances()

  const [qrTarget, setQrTarget] = useState<string | null>(null)
  const [createdTarget, setCreatedTarget] = useState<string | null>(null)
  const [isCollectionLoading, setIsCollectionLoading] = useState(false)
  const [erroAcao, setErroAcao] = useState<string | null>(null)
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  // Subscribe to Supabase Realtime for instance status changes
  useEffect(() => {
    if (!locationId) return

    const channel = supabase
      .channel('instances-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'instances',
          filter: `location_id=eq.${locationId}`,
        },
        async (payload) => {
          console.log('[realtime] Instance changed:', payload)
          // When any instance changes (status update, etc.), refresh
          await refreshInstances()

          // If a target instance connected, close the modal
          const changed = payload.new as any
          if (changed?.status === 'open') {
            if (qrTarget === changed.evolution_name || createdTarget === changed.evolution_name) {
              setQrTarget(null)
              setCreatedTarget(null)
            }
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [locationId, qrTarget, createdTarget])

  const refreshInformations = async () => {
    await refreshInstances()
    await sleep(1000)
    await refreshInstances()
    await sleep(6000)
    await refreshInstances()
  }

  // O delete leva de 20 a 40 s quando a Evolution resiste (3 tentativas com restart).
  // Sem indicador nem mensagem, o cliente clicava de novo (~15 vezes em 2026-09-23).
  const handleDelete = async (instanceName: string) => {
    if (!instanceName || isCollectionLoading) return
    setErroAcao(null)
    setIsCollectionLoading(true)
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instanceName)}`, { method: "DELETE" })
      if (!res.ok) {
        const codigo = await lerCodigoDeErro(res)
        console.error("Erro ao deletar instância:", res.status, codigo)
        setErroAcao(mensagemAmigavel("excluir", codigo))
        return
      }
      await refreshInformations()
    } catch (err) {
      console.error("Erro ao deletar instância:", err)
      setErroAcao(mensagemAmigavel("excluir", null))
    } finally {
      setIsCollectionLoading(false)
    }
  }

  const handleLogout = async (instanceName: string) => {
    if (!instanceName || isCollectionLoading) return
    setErroAcao(null)
    setIsCollectionLoading(true)
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instanceName)}/logout`, { method: "DELETE" })
      if (!res.ok) {
        const codigo = await lerCodigoDeErro(res)
        console.error("Erro ao desconectar instância:", res.status, codigo)
        setErroAcao(mensagemAmigavel("desconectar", codigo))
        return
      }
      await refreshInformations()
    } catch (err) {
      console.error("Erro ao desconectar instância:", err)
      setErroAcao(mensagemAmigavel("desconectar", null))
    } finally {
      setIsCollectionLoading(false)
    }
  }

  const handleCreate = async () => {
    if (!locationId || instances.length >= 4 || isCollectionLoading) return
    setErroAcao(null)
    setIsCollectionLoading(true)
    const pos = instances.find(item => item.instanceName.includes("-1")) ? instances.find(item => item.instanceName.includes("-2")) ? instances.find(item => item.instanceName.includes("-3")) ? 4 : 3 : 2 : 1
    const provider = instances.find(item => item.provider === process.env.NEXT_PUBLIC_PROVIDER1) ? instances.find(item => item.provider === process.env.NEXT_PUBLIC_PROVIDER2) ? instances.find(item => item.provider === process.env.NEXT_PUBLIC_PROVIDER3) ? process.env.NEXT_PUBLIC_PROVIDER4 : process.env.NEXT_PUBLIC_PROVIDER3 : process.env.NEXT_PUBLIC_PROVIDER2 : process.env.NEXT_PUBLIC_PROVIDER1
    const instanceName = `${locationId}-${pos}`
    try {
      const res = await fetch(`/api/instances`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceName, location: { id: locationId, name: locationId, provider: provider } })
      })
      if (!res.ok) {
        const codigo = await lerCodigoDeErro(res)
        console.error("Erro ao criar instância:", res.status, codigo)
        setErroAcao(mensagemAmigavel("criar", codigo))
        return
      }
      await refreshInformations()
      setCreatedTarget(instanceName)
    } catch (err) {
      console.error("Erro ao criar instância:", err)
      setErroAcao(mensagemAmigavel("criar", null))
    } finally {
      setIsCollectionLoading(false)
    }
  }

  const handleToggleDisplayName = async (instanceName: string, displayName: boolean) => {
    if (!instanceName || !locationId) return
    const res = await fetch(`/api/instances/${encodeURIComponent(instanceName)}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId, displayName })
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const body = await res.json()
        if (body && typeof body === "object" && "error" in body) msg = (body as any).error
      } catch { }
      throw new Error(msg)
    }
    await refreshInstances()
  }

  const handleConnect = (instanceName: string) => {
    setQrTarget(instanceName)
    onAction?.(instanceName)
  }

  if (isLoading) return <div className="flex justify-center items-center py-12"><Loading /></div>
  if (error) return <div className="text-red-500">Erro: {error}</div>

  const displayConnections = Array.from({ length: 4 }, (_, i) =>
    instances[i] ?? { instanceName: "", name: "", connectionStatus: undefined, number: null, displayName: false }
  )

  return (
    <>
      {erroAcao && (
        <div role="alert" className="mb-6 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span>{erroAcao}</span>
          <button onClick={() => setErroAcao(null)} className="shrink-0 text-red-600 hover:text-red-800" aria-label="Fechar aviso">✕</button>
        </div>
      )}
      {isCollectionLoading && <div className="flex justify-center items-center py-6"><Loading /></div>}
      <div className="grid md:grid-cols-2 gap-6 mb-12">
        {displayConnections.map((connection, idx) => {
          const { instanceName, connectionStatus } = connection
          let actionHandler: () => void
          if (!instanceName) {
            actionHandler = handleCreate
          } else if (connectionStatus === "open") {
            actionHandler = () => handleLogout(instanceName)
          } else {
            actionHandler = () => handleConnect(instanceName)
          }
          return (
            <ConnectionCard
              key={idx}
              connection={connection}
              onAction={actionHandler}
              onDelete={handleDelete}
              onToggleDisplayName={handleToggleDisplayName}
            />
          )
        })}
      </div>
      <QrCodeModal open={!!qrTarget} instanceName={qrTarget ?? ""} locationId={locationId} onClose={() => setQrTarget(null)} onConnected={refreshInstances} />
      <QrCodeModal open={!!createdTarget} instanceName={createdTarget ?? ""} locationId={locationId} onClose={() => setCreatedTarget(null)} onConnected={refreshInstances} />
    </>
  )
}
