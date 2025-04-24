"use client"

import { CheckCircle, Phone, Plus, Trash2, XCircle } from "lucide-react"
import { ActionButton } from "../action-button"
import type { ConnectionCardProps } from "../../types/connection"

export function ConnectionCard({ connection, onAction, onDelete }: ConnectionCardProps) {
  const { id, status, phoneNumber, userName, statusColor, statusLabel, actionLabel, actionPrimary } = connection

  const StatusIcon = {
    connected: CheckCircle,
    disconnected: XCircle,
    free: Plus,
  }[status]

  const handleAction = () => {
    if (onAction) {
      onAction(id)
    }
  }

  const handleDelete = () => {
    if (onDelete) {
      onDelete(id)
    }
  }

  return (
    <div className="rounded-xl overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md h-[200px] flex flex-col">
      <div className="h-2" style={{ backgroundColor: statusColor }}></div>

      <div
        className="p-5 bg-white border-x border-b rounded-b-xl flex-1 flex flex-col"
        style={{ borderColor: "#e0e0e0" }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <StatusIcon size={18} className="text-[#00a884]" style={{ color: statusColor }} />
            <span className="text-sm font-medium" style={{ color: statusColor }}>
              {statusLabel}
            </span>
          </div>

          {status !== "free" && (
            <button
              className="text-gray-400 hover:text-gray-600 transition-colors p-1.5 rounded-full hover:bg-gray-100"
              aria-label="Remover conexão"
              onClick={handleDelete}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>

        <div className="mb-4 flex-1">
          <div className="flex items-center gap-3">
            <div className="bg-opacity-10 p-2 rounded-full" style={{ backgroundColor: `${statusColor}15` }}>
              <Phone size={18} style={{ color: statusColor }} />
            </div>
            <div>
              <p className="text-lg font-bold text-[#191919]">{phoneNumber || "Instância Livre"}</p>
              <p className="text-sm text-[#5e5e5e]">{userName || "Conecte um novo número"}</p>
            </div>
          </div>
        </div>

        <ActionButton primary={actionPrimary} color={statusColor} size="sm" icon="arrow" onClick={handleAction}>
          {actionLabel}
        </ActionButton>
      </div>
    </div>
  )
}
