"use client"

import { ActionButton } from "../action-button"
import type { HelpSectionProps } from "../../types/connection"

export function HelpSection({
  title,
  description,
  primaryActionLabel,
  secondaryActionLabel,
  primaryActionHref,
  secondaryActionHref,
  onPrimaryAction,
  onSecondaryAction,
  accentColor,
}: HelpSectionProps) {
  return (
    <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-100 mb-8">
      <h2 className="text-xl font-bold text-[#191919] mb-3">{title}</h2>
      <p className="text-[#5e5e5e] mb-6">{description}</p>
      <div className="flex flex-col sm:flex-row gap-4">
        <ActionButton color={accentColor} primary={false} href={secondaryActionHref} onClick={onSecondaryAction}>
          {secondaryActionLabel}
        </ActionButton>
        <ActionButton color={accentColor} primary={true} href={primaryActionHref} onClick={onPrimaryAction}>
          {primaryActionLabel}
        </ActionButton>
      </div>
    </div>
  )
}
