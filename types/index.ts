export interface FeatureItem {
  icon: "check" | "x"
  text: string
  isLink?: boolean
  linkUrl?: string
}

export interface WhatsAppProvider {
  id: string
  name: string
  logo: string
  logoWidth: number
  logoHeight: number
  logoAlt: string
  titleColor: string
  buttonColor: string
  backgroundColor: string
  borderColor: string
  title: string
  subtitle: string
  features: FeatureItem[]
  primaryActionHref?: string
  secondaryActionHref?: string
}
