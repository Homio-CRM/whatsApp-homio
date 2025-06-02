"use client"

import { ActionButton } from "../actionButton"
import type { HelpSectionProps } from "@/types/connection"
import { useInstances } from "@/lib/context/useInstances"

export function HelpSection({
  title,
  description,
  primaryActionLabel,
  secondaryActionLabel,
  accentColor,
}: HelpSectionProps) {
  const { locationId } = useInstances()
  return (
    <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-100 mb-8">
      <h2 className="text-xl font-bold text-[#191919] mb-3">{title}</h2>
      <p className="text-[#5e5e5e] mb-6">{description}</p>
      <div className="flex flex-col sm:flex-row gap-4">
        <ActionButton color={accentColor} primary={false} href={"https://doc.clickup.com/9011321034/p/h/8chvp6a-571/7f3c09f78089b64/8chvp6a-691"} target="_blank">
          {secondaryActionLabel}
        </ActionButton>
        <ActionButton color={accentColor} primary={true} href={`https://app.homio.com.br/v2/location/${locationId}/custom-menu-link/1b5faec1-4ef1-4df4-9e5c-223e3b02214a`}>
          {primaryActionLabel}
        </ActionButton>
      </div>
    </div>
  )
}
