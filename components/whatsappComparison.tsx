"use client"

import { whatsappProviders } from "@/data/whatsapp-providers"
import { WhatsAppCard } from "@/components/whatsappCard"
import { useEffect, useState } from "react"

interface LocationPayload {
  locationId: string
  userId: string
  userName: string
  email: string
}

export default function WhatsAppComparison() {
  const [locationData, setLocationData] = useState<LocationPayload | null>(null)

  useEffect(() => {

    window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*")

    window.postMessage(
      {
        message: "REQUEST_USER_DATA_RESPONSE",
        payload: {
          locationId: "d8voPwkhJK7k7S5xjHcA",
          userId: "user456",
          userName: "João Silva",
          email: "joao@example.com",
        },
      },
      "*"
    )

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.message === "REQUEST_USER_DATA_RESPONSE") {
        setLocationData(event.data.payload)
      }
    }
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [])

  if (!locationData) {
    return <div>Buscando dados do usuário…</div>
  }

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
        className="max-w-5xl w-full mx-auto flex flex-col items-center lg:mt-36"
        style={{
          opacity: 1,
          transform: "translateY(0)",
          transition: "opacity 0.5s ease-out, transform 0.5s ease-out",
        }}
      >
        <div className="text-center mb-12">
          <h1 className="text-3xl md:text-4xl font-extrabold mb-2">
            WhatsApp integrado à Homio!
          </h1>
          <p className="text-[#5e5e5e] text-base">
            Transforme suas conversas em oportunidades.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 justify-center">
          {whatsappProviders.map((provider, index) => (
            <WhatsAppCard
              key={provider.id}
              provider={provider}
              animationDelay={index * 150}
            />
          ))}
        </div>
      </div>
    </div>

  )
}
