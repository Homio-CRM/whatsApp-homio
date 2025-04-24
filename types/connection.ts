export type ConnectionStatus = "connected" | "disconnected" | "free"

export interface Connection {
  id: string
  status: ConnectionStatus
  phoneNumber?: string
  userName?: string
  statusColor: string
  statusLabel: string
  actionLabel: string
  actionPrimary: boolean
  lastActive?: string
  messageCount?: number
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
