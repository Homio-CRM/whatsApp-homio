"use client"

import { useEffect, useId, useState } from "react"
import { CheckCircle, XCircle, Plus, Phone, Trash2 } from "lucide-react"
import { ActionButton } from "../actionButton"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Input } from "@/components/ui/input"
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
import { Connection, SignatureMode, SignatureSettings } from "@/types/connection"

export interface ConnectionCardProps {
  connection: Connection
  onAction?: (instanceName: string) => void
  onDelete?: (instanceName: string) => void
  onChangeSignature?: (instanceName: string, settings: SignatureSettings) => Promise<void>
}

// "off" é display_name = false; os outros são o signature_mode com display_name = true
type SignatureChoice = "off" | SignatureMode

const SIGNATURE_OPTIONS: { value: SignatureChoice; label: string }[] = [
  { value: "off", label: "Não assinar" },
  { value: "first", label: "Primeiro nome" },
  { value: "full", label: "Nome completo" },
  { value: "custom", label: "Personalizado" },
]

export default function ConnectionCard({ connection, onAction, onDelete, onChangeSignature }: ConnectionCardProps) {
  const { instanceName, connectionStatus: status, number, name: userName, providerName, displayName, signatureMode, signatureName } = connection
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

  // Assinatura do atendente (instances.display_name + signature_mode/signature_name). Estado local
  // pra responder na hora; o valor do servidor volta pelo refresh e reconcilia nos useEffect.
  const signatureId = useId()
  const savedSignature: SignatureChoice = displayName === true ? (signatureMode ?? "full") : "off"
  const [signature, setSignature] = useState<SignatureChoice>(savedSignature)
  const [customName, setCustomName] = useState(signatureName ?? "")
  const [savingSignature, setSavingSignature] = useState(false)
  const [signatureError, setSignatureError] = useState(false)

  useEffect(() => {
    setSignature(savedSignature)
  }, [savedSignature])

  useEffect(() => {
    setCustomName(signatureName ?? "")
  }, [signatureName])

  const saveSignature = async (next: SignatureChoice, name: string) => {
    if (!onChangeSignature || savingSignature) return
    const previous = signature
    setSignature(next)
    setSavingSignature(true)
    setSignatureError(false)
    try {
      await onChangeSignature(instanceName, next === "off"
        ? { displayName: false }
        : next === "custom"
          ? { displayName: true, signatureMode: "custom", signatureName: name }
          : { displayName: true, signatureMode: next })
    } catch (err) {
      console.error("Erro ao salvar assinatura do atendente:", err)
      setSignature(previous)
      setSignatureError(true)
    } finally {
      setSavingSignature(false)
    }
  }

  // Personalizado só salva com nome: sem nome, marca a opção e espera o campo
  const handleSignatureChange = (value: string) => {
    const next = value as SignatureChoice
    if (next === "custom" && !customName.trim()) {
      setSignature("custom")
      setSignatureError(false)
      return
    }
    saveSignature(next, customName.trim())
  }

  const commitCustomName = () => {
    const name = customName.trim()
    if (!name || (savedSignature === "custom" && name === (signatureName ?? ""))) return
    saveSignature("custom", name)
  }

  const signatureHint =
    signature === "off" ? <>As mensagens saem sem nome</>
      : signature === "first" ? <>Sai <b className="text-[#191919]">Maria:</b> numa linha acima da mensagem</>
      : signature === "full" ? <>Sai <b className="text-[#191919]">Maria Souza:</b> numa linha acima da mensagem</>
      : customName.trim() ? <>Sai <b className="text-[#191919]">{customName.trim()}:</b> em todas as mensagens deste número</>
      : <>Escreva o nome e aperte Enter</>

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
        {instanceName && onChangeSignature && (
          <div className="mb-4 rounded-lg border px-3 py-2.5" style={{ borderColor: "#e0e0e0", backgroundColor: "#fafafa" }}>
            <p id={signatureId} className="text-sm font-medium text-[#191919]">Assinatura das mensagens</p>
            <RadioGroup
              aria-labelledby={signatureId}
              value={signature}
              onValueChange={handleSignatureChange}
              disabled={savingSignature}
              className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5"
            >
              {SIGNATURE_OPTIONS.map(({ value, label }) => (
                <label key={value} className="flex items-center gap-2 text-sm text-[#191919] cursor-pointer">
                  <RadioGroupItem value={value} className="border-[#0F3D8C] text-[#0F3D8C]" />
                  {label}
                </label>
              ))}
            </RadioGroup>
            {signature === "custom" && (
              <Input
                value={customName}
                // * _ ~ ` quebrariam o negrito da assinatura no WhatsApp; a EF também tira
                onChange={(e) => setCustomName(e.target.value.replace(/[*_~`]/g, ""))}
                onBlur={commitCustomName}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur() }}
                maxLength={40}
                placeholder="Ex.: Equipe Comercial"
                aria-label="Nome da assinatura"
                disabled={savingSignature}
                className="mt-2 h-8 bg-white text-sm"
              />
            )}
            <p className={`mt-1.5 text-xs leading-snug ${signatureError ? "text-red-600" : "text-[#5e5e5e]"}`}>
              {signatureError ? "Não foi possível salvar. Tente de novo." : signatureHint}
            </p>
          </div>
        )}
        <ActionButton primary={actionPrimary} color={statusColor} size="sm" icon="arrow" onClick={handleAction}>{actionLabel}</ActionButton>
      </div >
    </div >
  )
}
