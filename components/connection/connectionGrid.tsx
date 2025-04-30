"use client"

import ConnectionCard from "./connectionCard"
import { useInstances } from "@/lib/context/useInstances"
import type { Connection } from "@/types/connection"

interface ConnectionGridProps {
  onAction?: (id: string) => void
  onDelete?: (id: string) => void
}

export function ConnectionGrid({ onAction, onDelete }: ConnectionGridProps) {
  const { instances, isLoading, error } = useInstances()
  if (isLoading) return <div>Carregando instâncias…</div>
  if (error) return <div className="text-red-500">Erro: {error}</div>

  return (
    <div className="grid md:grid-cols-3 gap-6 mb-12">
      {instances.map((connection: Connection, index: number) => (
        <ConnectionCard
          key={connection.name ?? index}
          connection={connection}
          onAction={onAction}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
