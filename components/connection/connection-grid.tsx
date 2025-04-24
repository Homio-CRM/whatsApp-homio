import { ConnectionCard } from "./connection-card"
import type { Connection } from "../../types/connection"

interface ConnectionGridProps {
  connections: Connection[]
  onAction?: (id: string) => void
  onDelete?: (id: string) => void
}

export function ConnectionGrid({ connections, onAction, onDelete }: ConnectionGridProps) {
  return (
    <div className="grid md:grid-cols-3 gap-6 mb-12">
      {connections.map((connection) => (
        <ConnectionCard key={connection.id} connection={connection} onAction={onAction} onDelete={onDelete} />
      ))}
    </div>
  )
}
