"use client"

import { useState } from "react"
import { connections as initialConnections } from "../../data/connections"
import { BackButton } from "../../components/connection/back-button"
import { PageHeader } from "../../components/connection/page-header"
import { ConnectionGrid } from "../../components/connection/connection-grid"
import { HelpSection } from "../../components/connection/help-section"
import { BackgroundPattern } from "../../components/connection/background-pattern"
import type { Connection } from "../../types/connection"

export default function WhatsAppConnectPage() {
  const [connections, setConnections] = useState<Connection[]>(initialConnections)

  const handleConnectionAction = (id: string) => {
    console.log(`Action triggered for connection: ${id}`)
  }

  const handleConnectionDelete = (id: string) => {
    console.log(`Delete triggered for connection: ${id}`)
    setConnections(connections.filter((conn) => conn.id !== id))
  }

  const PAGE_CONFIG = {
    backButton: {
      href: "/",
      color: "#5417b2",
      ariaLabel: "Voltar para comparação",
    },
    header: {
      title: "WhatsApp Homio",
      subtitle: "Envie e receba mensagens, de graça, para sempre.",
      logoSrc: "/homio-logo.svg",
      logoAlt: "Homio Logo",
      titleColor: "#5417b2",
    },
    helpSection: {
      title: "Precisa de ajuda?",
      description:
        "Se você está tendo problemas para conectar seu WhatsApp ou tem dúvidas sobre como usar o serviço, nossa equipe de suporte está pronta para ajudar.",
      primaryActionLabel: "Contatar suporte",
      secondaryActionLabel: "Ver documentação",
      accentColor: "#5417b2",
    },
    backgroundImage: "/whatsapp-pattern-new.png",
  }

  return (
    <div className="w-full min-h-screen py-12 px-4 relative">
      <BackgroundPattern imagePath={PAGE_CONFIG.backgroundImage} />

      <div className="max-w-4xl w-full mx-auto">
        <BackButton {...PAGE_CONFIG.backButton} />

        <PageHeader {...PAGE_CONFIG.header} />

        <ConnectionGrid connections={connections} onAction={handleConnectionAction} onDelete={handleConnectionDelete} />

        <HelpSection {...PAGE_CONFIG.helpSection} />
      </div>
    </div>
  )
}
