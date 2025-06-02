"use client"

import { CheckCircle, XCircle, Plus, Phone, Trash2 } from "lucide-react"
import { ActionButton } from "../actionButton"
import { formatPhoneNumber } from "@/lib/formatPhoneNumber"
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction
} from "@/components/ui/alert-dialog"
import { Connection } from "@/types/connection"
import Loading from "../Loading"

export interface ConnectionCardProps {
  connection: Connection
  onAction?: (instanceName: string) => void
  onDelete?: (instanceName: string) => void
}

export default function ConnectionCard({ connection, onAction, onDelete }: ConnectionCardProps) {
  const { instanceName, connectionStatus: status, ownerJid, name: userName } = connection
  const config =
    status === "open"
      ? { statusColor: "#00a884", statusLabel: "Conectado", actionLabel: "Desconectar", actionPrimary: false }
      : status === "connecting" || status === "close"
        ? { statusColor: "#F2A008", statusLabel: "Conectando", actionLabel: "Conectar", actionPrimary: false }
        : { statusColor: "#0F3D8C", statusLabel: "Livre", actionLabel: "Criar", actionPrimary: true }
  const { statusColor, statusLabel, actionLabel, actionPrimary } = config
  const StatusIcon = status === "open" ? CheckCircle : status === "connecting" || status === "close" ? XCircle : Plus
  const handleAction = () => onAction?.(instanceName)
  const handleDelete = () => onDelete?.(instanceName)

  return (
    <div className="rounded-xl overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md h-[200px] flex flex-col">
      <div className="h-2" style={{ backgroundColor: statusColor }} />
      <div className="p-5 bg-white border-x border-b rounded-b-xl flex-1 flex flex-col" style={{ borderColor: "#e0e0e0" }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <StatusIcon size={18} style={{ color: statusColor }} />
            <span className="text-sm font-medium" style={{ color: statusColor }}>{statusLabel}</span>
          </div>
          {(status === "open" || status === "connecting" || status === "close") && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button className="text-gray-400 hover:text-gray-600 transition-colors p-1.5 rounded-full hover:bg-gray-100" aria-label="Remover conexão">
                  <Trash2 size={16} />
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Excluir instância?</AlertDialogTitle>
                  <AlertDialogDescription>Ao confirmar, todos os dados associados a esta instância serão perdidos.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction
                    className="px-4 py-2 rounded bg-red-600  hover:bg-red-500 text-white"
                    onClick={handleDelete}>
                    Excluir
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        <div className="mb-4 flex-1">
          <div className="flex items-center gap-3">
            <div className="bg-opacity-10 p-2 rounded-full" style={{ backgroundColor: `${statusColor}15` }}>
              <Phone size={18} style={{ color: statusColor }} />
            </div>
            <div>
              <p className="text-lg font-bold text-[#191919]">{
                instanceName == '' || instanceName === undefined ? "Instância Livre"
                  : !ownerJid
                    ? "Desconectada"
                    : formatPhoneNumber(ownerJid.split("@")[0])}

              </p>
              <p className="text-sm text-[#5e5e5e]">{userName ? userName : ""}</p>
            </div>
          </div>
        </div>
        <ActionButton primary={actionPrimary} color={statusColor} size="sm" icon="arrow" onClick={handleAction}>{actionLabel}</ActionButton>
      </div >
    </div >
  )
}
