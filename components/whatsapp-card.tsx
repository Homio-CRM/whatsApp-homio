"use client"

import Image from "next/image"
import { useEffect, useState } from "react"
import type { WhatsAppProvider } from "../types"
import { FeatureItem } from "./feature-item"
import { ActionButton } from "./action-button"

interface WhatsAppCardProps {
  provider: WhatsAppProvider
  animationDelay?: number
}

export function WhatsAppCard({ provider, animationDelay = 0 }: WhatsAppCardProps) {
  const [isVisible, setIsVisible] = useState(false)

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
    secondaryActionHref,
    id,
  } = provider

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
          <ActionButton
            primary
            color={buttonColor}
            href={primaryActionHref}
            icon="arrow"
            animationDelay={animationDelay + 800}
          >
            Comece a usar
          </ActionButton>
          {secondaryActionHref && (
            <ActionButton
              color={buttonColor}
              href={secondaryActionHref}
              icon="info"
              animationDelay={animationDelay + 900}
            >
              Saiba mais
            </ActionButton>
          )}
        </div>
      </div>
    </div>
  )
}
