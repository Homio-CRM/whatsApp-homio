export type ConnectionStatus = "connected" | "disconnected" | "free"

export type Connection = {
  instanceName: string;
  name: string
  connectionStatus: 'open' | 'connecting' | undefined
  ownerJid: string
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
