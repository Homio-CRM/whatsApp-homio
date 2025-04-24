"use client"

import { whatsappProviders } from "./data/whatsapp-providers"
import { WhatsAppCard } from "./components/whatsapp-card"
import { useEffect, useState } from "react"

export default function WhatsAppComparison() {
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    setIsLoaded(true)
  }, [])

  return (
    <div className="w-full min-h-screen py-12 px-4 relative">
      <div
        className="fixed inset-0 pointer-events-none z-[-1]"
        style={{
          backgroundImage: `url('/whatsapp-pattern-new.png')`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          width: "100%",
          height: "100%",
        }}
      />

      <div
        className="max-w-5xl w-full mx-auto"
        style={{
          opacity: isLoaded ? 1 : 0,
          transform: isLoaded ? "translateY(0)" : "translateY(20px)",
          transition: "opacity 0.5s ease-out, transform 0.5s ease-out",
        }}
      >
        <div className="text-center mb-12">
          <h1 className="text-3xl md:text-4xl font-extrabold mb-2">WhatsApp integrado à Homio!</h1>
          <p className="text-[#5e5e5e] text-base">Transforme suas conversas em oportunidades.</p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 justify-center">
          {whatsappProviders.map((provider, index) => (
            <WhatsAppCard key={provider.id} provider={provider} animationDelay={index * 150} />
          ))}
        </div>
      </div>
    </div>
  )
}
