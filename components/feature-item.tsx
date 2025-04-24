import { Check, X } from "lucide-react"
import type { FeatureItem as FeatureItemType } from "../types"

interface FeatureItemProps {
  item: FeatureItemType
  color: string
}

export function FeatureItem({ item, color }: FeatureItemProps) {
  const { icon, text, isLink, linkUrl } = item

  const IconComponent = icon === "check" ? Check : X
  const iconColor = icon === "check" ? color : "#5e5e5e"

  const content =
    isLink && linkUrl ? (
      <a
        href={linkUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold hover:underline text-sm text-[#5e5e5e]"
      >
        {text}
      </a>
    ) : (
      <p className="text-[#5e5e5e] font-semibold text-sm">{text}</p>
    )

  return (
    <div className="flex items-start gap-3">
      <IconComponent className="mt-0.5 h-5 w-5 shrink-0" style={{ color: iconColor }} />
      {content}
    </div>
  )
}
