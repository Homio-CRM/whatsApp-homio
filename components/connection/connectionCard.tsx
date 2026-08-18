"use client"

import { useEffect, useId, useState } from "react"
import { CheckCircle, XCircle, Plus, Phone, Trash2 } from "lucide-react"
import { ActionButton } from "../actionButton"
import { Switch } from "@/components/ui/switch"
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

export interface ConnectionCardProps {
  connection: Connection
  onAction?: (instanceName: string) => void
  onDelete?: (instanceName: string) => void
  onToggleDisplayName?: (instanceName: string, displayName: boolean) => Promise<void>
}

export default function ConnectionCard({ connection, onAction, onDelete, onToggleDisplayName }: ConnectionCardProps) {
  const { instanceName, connectionStatus: status, number, name: userName, providerName, displayName } = connection
  const config =
    status === "open"
      ? { statusColor: "#00a884", statusLabel: "Conectado", actionLabel: "Desconectar", actionPrimary: false }
      : status === "connecting" || status === "close" || status === '' || status === null
      ? { statusColor: "#F2A008", statusLabel: "Desconectada", actionLabel: "Conectar", actionPrimary: false }
      : status === "refused" 
      ? { statusColor: "#F0111A", statusLabel: "Erro", actionLabel: "Conectar novamente", actionPrimary: false }
      : { statusColor: "#0F3D8C", statusLabel: "Livre", actionLabel: "Criar", actionPrimary: true }
  const { statusColor, statusLabel, actionLabel, actionPrimary } = config
  const StatusIcon = status === "open" ? CheckCircle : status === "connecting" || status === "close" || status === "refused" ? XCircle : Plus
  const handleAction = () => onAction?.(instanceName)
  const handleDelete = () => onDelete?.(instanceName)

  // Assinatura do atendente (instances.display_name). Estado local pro switch responder
  // na hora; o valor do servidor volta pelo refresh e reconcilia no useEffect.
  const signatureId = useId()
  const [signature, setSignature] = useState(displayName === true)
  const [savingSignature, setSavingSignature] = useState(false)

  useEffect(() => {
    setSignature(displayName === true)
  }, [displayName])

  const handleSignatureChange = async (next: boolean) => {
    if (!onToggleDisplayName || savingSignature) return
    setSignature(next)
    setSavingSignature(true)
    try {
      await onToggleDisplayName(instanceName, next)
    } catch (err) {
      console.error("Erro ao salvar assinatura do atendente:", err)
      setSignature(!next)
    } finally {
      setSavingSignature(false)
    }
  }

  return (
    <div className="rounded-xl overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md h-full min-h-[224px] flex flex-col">
      <div className="h-2" style={{ backgroundColor: statusColor }} />
      <div className="p-5 bg-white border-x border-b rounded-b-xl flex-1 flex flex-col" style={{ borderColor: "#e0e0e0" }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <StatusIcon size={18} style={{ color: statusColor }} />
            <span className="text-sm font-medium" style={{ color: statusColor }}>{statusLabel}</span>
            <span className="text-sm font-medium text-[#5e5e5e]">{ providerName ? "- " + providerName : ""}</span>
          </div>
          {(status) && (
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
                instanceName === '' || instanceName === undefined ? "Instância Livre"
                  : !number
                    ? "Sem número"
                    : formatPhoneNumber(number)}

              </p>
              <p className="text-sm text-[#5e5e5e]">{userName ? userName : ""}</p>
            </div>
          </div>
        </div>
        {instanceName && onToggleDisplayName && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5" style={{ borderColor: "#e0e0e0", backgroundColor: "#fafafa" }}>
            <div className="min-w-0">
              <label htmlFor={signatureId} className="block text-sm font-medium text-[#191919] cursor-pointer">
                Assinar mensagens com o nome
              </label>
              <p className="text-xs leading-snug text-[#5e5e5e]">
                Nome e sobrenome de quem atendeu numa linha acima da mensagem
              </p>
            </div>
            <Switch
              id={signatureId}
              checked={signature}
              disabled={savingSignature}
              onCheckedChange={handleSignatureChange}
              aria-label="Assinar mensagens com o nome"
              className="mt-0.5 data-[state=checked]:bg-[#0F3D8C]"
            />
          </div>
        )}
        <ActionButton primary={actionPrimary} color={statusColor} size="sm" icon="arrow" onClick={handleAction}>{actionLabel}</ActionButton>
      </div >
    </div >
  )
}
