"use client"

import * as React from "react"
import { useState, useEffect } from "react"
import ConnectionCard from "./connectionCard"
import { useInstances } from "@/lib/context/useInstances"
import { QrCodeModal } from "./qrCodeModal"
import Loading from "../Loading"
import io from "socket.io-client";

export function ConnectionGrid({ onAction }: { onAction?: (instanceName: string) => void }) {
  const { instances, locationId, isLoading, error, refreshInstances } = useInstances()

  const [qrTarget, setQrTarget] = useState<string | null>(null)
  const [createdTarget, setCreatedTarget] = useState<string | null>(null)
  const [isCollectionLoading, setIsCollectionLoading] = useState(false)
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  useEffect(() => {
    if (!qrTarget && !createdTarget) return;
    fetch('/api/socket');
    const socket = io({ path: '/api/socket_io' });
    socket.on('connection-update', checkInstance);
    return () => {
      socket.off('connection-update', checkInstance);
      socket.close();
    };
  }, [qrTarget, createdTarget]);

  const refreshInformations = async() => {
    await refreshInstances()
    await sleep(1000)
    await refreshInstances()
    await sleep(6000)
    await refreshInstances()
  }

  const handleDelete = async (instanceName: string) => {
    if (!instanceName) return
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instanceName)}`, { method: "DELETE" })
      if (!res.ok) {
        let msg = res.statusText
        try {
          const body = await res.json()
          if (body && typeof body === "object" && "error" in body) msg = (body as any).error
        } catch { }
        throw new Error(msg)
      }
      await refreshInformations()
    } catch (err) {
      console.error("Erro ao deletar instância:", err)
    }
  }

  const handleLogout = async (instanceName: string) => {
    if (!instanceName) return
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instanceName)}/logout`, { method: "DELETE" })
      if (!res.ok) {
        let msg = res.statusText
        try {
          const body = await res.json()
          if (body && typeof body === "object" && "error" in body) msg = (body as any).error
        } catch { }
        throw new Error(msg)
      }
      await refreshInformations()
    } catch (err) {
      console.error("Erro ao desconectar instância:", err)
    }
  }

  const handleCreate = async () => {
    if (!locationId || instances.length >= 4) return
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
        let msg = res.statusText
        try {
          const body = await res.json()
          if (body && typeof body === "object" && "error" in body) msg = (body as any).error
        } catch { }
        throw new Error(msg)
      }
      await refreshInformations()
      setCreatedTarget(instanceName)
    } catch (err) {
      console.error("Erro ao criar instância:", err)
    } finally {
      setIsCollectionLoading(false)
    }
  }

  const handleConnect = (instanceName: string) => {
    setQrTarget(instanceName)
    onAction?.(instanceName)
  }

  const checkInstance = async <T extends string>(data: T) => {
    if(qrTarget === data || createdTarget === data) {
      setCreatedTarget(null)
      setQrTarget(null)
      await refreshInformations()
    }
  } 

  if (isLoading) return <div className="flex justify-center items-center py-12"><Loading /></div>
  if (error) return <div className="text-red-500">Erro: {error}</div>

  const displayConnections = Array.from({ length: 4 }, (_, i) =>
    instances[i] ?? { instanceName: "", name: "", connectionStatus: undefined, number: null }
  )

  return (
    <>
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
            />
          )
        })}
      </div>
      <QrCodeModal open={!!qrTarget} instanceName={qrTarget ?? ""} onClose={() => setQrTarget(null)} />
      <QrCodeModal open={!!createdTarget} instanceName={createdTarget ?? ""} onClose={() => setCreatedTarget(null)} />
    </>
  )
}

