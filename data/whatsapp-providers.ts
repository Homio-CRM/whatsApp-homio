import type { WhatsAppProvider } from "../types"

export const whatsappProviders: WhatsAppProvider[] = [
  {
    id: "homio",
    name: "Homio",
    logo: "/homio-logo.svg",
    logoWidth: 28,
    logoHeight: 28,
    logoAlt: "Homio Logo",
    titleColor: "#5417b2",
    buttonColor: "#5417b2",
    backgroundColor: "#f9f6ff",
    borderColor: "#e0d8f3",
    title: "De graça, para sempre.",
    subtitle: "Envie e receba mensagens, o quanto quiser, de graça.",
    primaryActionHref: "/whatsapp-connect",
    secondaryActionHref: "#",
    features: [
      {
        icon: "check",
        text: "Não perca seu histórico de mensagens ao conectar.",
      },
      {
        icon: "x",
        text: "Não envia áudios (em breve).",
      },
      {
        icon: "x",
        text: "Risco de banimento quando usado para envios em massa.",
      },
    ],
  },
  {
    id: "meta",
    name: "Meta",
    logo: "/meta-logo.png",
    logoWidth: 24,
    logoHeight: 24,
    logoAlt: "Meta Logo",
    titleColor: "#128c7e",
    buttonColor: "#128c7e",
    backgroundColor: "#f5fcfb",
    borderColor: "#d8e8e6",
    title: "Verificado pela Meta.",
    subtitle: "Envie e receba mensagens pela API Oficial do WhatsApp.",
    primaryActionHref: "/whatsapp-meta-connect",
    secondaryActionHref: "#",
    features: [
      {
        icon: "x",
        text: "Perda do histórico de mensagens ao vincular o número.",
      },
      {
        icon: "x",
        text: "Limite de conversas iniciadas pela empresa.",
        isLink: true,
        linkUrl: "https://developers.facebook.com/docs/whatsapp/messaging-limits?locale=pt_BR",
      },
      {
        icon: "x",
        text: "Cobranças por conversa iniciada pela empresa.",
      },
    ],
  },
]
