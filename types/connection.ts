export type ConnectionStatus = "connected" | "disconnected" | "free"

export type Connection = {
  instanceName: string;
  name: string
  connectionStatus: 'open' | 'connecting' | 'close' | undefined
  number: string
  provider: string
  providerName: string
  /** instances.display_name — assina cada mensagem enviada com o nome do atendente */
  displayName?: boolean
  /** instances.signature_mode — texto da assinatura: primeiro nome, nome completo ou nome fixo */
  signatureMode?: SignatureMode
  /** instances.signature_name — o nome fixo do modo custom */
  signatureName?: string | null
}

export type SignatureMode = "first" | "full" | "custom"

/** O que a página de conexão manda pra salvar a assinatura de uma instância */
export type SignatureSettings = {
  displayName: boolean
  signatureMode?: SignatureMode
  signatureName?: string | null
}



export interface ConnectionCardProps {
  connection: Connection
  onAction?: (id: string) => void
  onDelete?: (id: string) => void
}

export interface PageHeaderProps {
  title: string
  subtitle: string
  logoSrc: string
  logoAlt: string
  titleColor: string
}

export interface HelpSectionProps {
  title: string
  description: string
  primaryActionLabel: string
  secondaryActionLabel: string
  primaryActionHref?: string
  secondaryActionHref?: string
  onPrimaryAction?: () => void
  onSecondaryAction?: () => void
  accentColor: string
}

export interface BackButtonProps {
  href: string
  color: string
  ariaLabel: string
}
