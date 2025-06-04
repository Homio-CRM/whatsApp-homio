"use client"

import Image from "next/image"
import { useEffect, useState } from "react"
import type { WhatsAppProvider } from "@/types"
import { FeatureItem } from "./featureItem"
import { useInstances } from "@/lib/context/useInstances"
import { ActionButton } from "./actionButton"
import SuccessModal from "./connection/successModal"
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

interface WhatsAppCardProps {
  provider: WhatsAppProvider
  animationDelay?: number
}

export function WhatsAppCard({ provider, animationDelay = 0 }: WhatsAppCardProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [renderSuccessModal, setRenderSuccessModal] = useState(false)
    const { locationId } = useInstances()

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(true)
    }, animationDelay)

    return () => clearTimeout(timer)
  }, [animationDelay])

  const {
    logo,
    logoWidth,
    logoHeight,
    logoAlt,
    titleColor,
    buttonColor,
    backgroundColor,
    borderColor,
    name,
    title,
    subtitle,
    features,
    primaryActionHref,
    id,
  } = provider

  const requestWhatsappMeta = async () => {
    try {
      const res = await fetch(`/api/instances/request-whatsapp-meta?locationId=${locationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      })
      setRenderSuccessModal(true)
      if (!res.ok) {
        let msg = res.statusText
        try {
          const body = await res.json()
          if (body && typeof body === "object" && "error" in body) msg = (body as any).error
        } catch { }
        throw new Error(msg)
      }
    } catch (err) {
      console.error("Erro ao solicitar Whatsapp:", err)
    }
  }
  
  return (
    <div
      className="rounded-3xl overflow-hidden relative"
      style={{
        backgroundColor: backgroundColor,
        border: `1px solid ${borderColor}`,
        position: "relative",
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? "translateY(0)" : "translateY(30px)",
        transition: "opacity 0.6s ease-out, transform 0.6s ease-out",
      }}
    >
      <div className="p-6 relative z-10">
        <div className="flex items-center gap-3 mb-3">
          <div
            style={{
              width: logoWidth + "px",
              height: logoHeight + "px",
              opacity: isVisible ? 1 : 0,
              transform: isVisible ? "scale(1)" : "scale(0.8)",
              transition: "opacity 0.6s ease-out, transform 0.6s ease-out",
              transitionDelay: "0.1s",
            }}
          >
            <Image src={logo || "/placeholder.svg"} width={logoWidth} height={logoHeight} alt={logoAlt} />
          </div>
          <h2
            style={{
              color: titleColor,
              opacity: isVisible ? 1 : 0,
              transform: isVisible ? "translateX(0)" : "translateX(-10px)",
              transition: "opacity 0.6s ease-out, transform 0.6s ease-out",
              transitionDelay: "0.2s",
            }}
            className="text-xl"
          >
            <span className="font-bold">WhatsApp</span> <span className="font-semibold">{name}</span>
          </h2>
        </div>

        <div className="mb-5">
          <h3
            className="text-2xl font-bold text-[#191919] mb-0 tracking-tighter"
            style={{
              letterSpacing: "-0.02em",
              opacity: isVisible ? 1 : 0,
              transform: isVisible ? "translateY(0)" : "translateY(10px)",
              transition: "opacity 0.6s ease-out, transform 0.6s ease-out",
              transitionDelay: "0.3s",
            }}
          >
            {title}
          </h3>
          <p
            className="text-[#5e5e5e] font-semibold tracking-tighter"
            style={{
              letterSpacing: "-0.01em",
              opacity: isVisible ? 1 : 0,
              transform: isVisible ? "translateY(0)" : "translateY(10px)",
              transition: "opacity 0.6s ease-out, transform 0.6s ease-out",
              transitionDelay: "0.4s",
            }}
          >
            {subtitle}
          </p>
        </div>

        <div className="space-y-1 mb-6">
          {features.map((feature, index) => (
            <div
              key={index}
              style={{
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? "translateY(0)" : "translateY(10px)",
                transition: "opacity 0.6s ease-out, transform 0.6s ease-out",
                transitionDelay: `${0.5 + index * 0.1}s`,
              }}
            >
              <FeatureItem item={feature} color={titleColor} />
            </div>
          ))}
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          {id === "meta" ? 
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <ActionButton
                primary
                color={buttonColor}
                icon="arrow"
                animationDelay={animationDelay + 800}
              >
                Comece a usar
              </ActionButton>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Você tem certeza que quer usar o Whatsapp Meta?</AlertDialogTitle>
                <AlertDialogDescription>Isso pode ocasionar cobranças extras por conversa criada.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  className="px-4 py-2 rounded bg-meta  hover:bg-[#2a9b8e] text-white"
                  onClick={requestWhatsappMeta}>
                  Prosseguir
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          :
          <ActionButton
            primary
            color={buttonColor}
            href={primaryActionHref}
            onClick={() => {}}
            icon="arrow"
            animationDelay={animationDelay + 800}
          >
            Comece a usar
          </ActionButton>}
          <ActionButton
            color={buttonColor}
            href={"https://doc.clickup.com/9011321034/p/h/8chvp6a-571/7f3c09f78089b64/8chvp6a-691"}
            icon="info"
            animationDelay={animationDelay + 900}
            target="_blank"
          >
            Saiba mais
          </ActionButton>
          {renderSuccessModal ? <SuccessModal /> : ''}
        </div>
      </div>
    </div>
  )
}
