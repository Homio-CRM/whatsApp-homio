import Image from "next/image"
import type { PageHeaderProps } from "../../types/connection"

export function PageHeader({ title, subtitle, logoSrc, logoAlt, titleColor }: PageHeaderProps) {
  const titleParts = title.split(" ")
  const firstWord = titleParts[0]
  const restOfTitle = titleParts.slice(1).join(" ")

  return (
    <div className="text-center mb-14">
      <div className="flex items-center justify-center gap-4 mb-1">
        <div className="w-14 h-14">
          <Image src={logoSrc || "/placeholder.svg"} width={56} height={56} alt={logoAlt} />
        </div>
        <h1 className="text-3xl md:text-4xl" style={{ color: titleColor }}>
          <span className="font-bold">{firstWord}</span> <span className="font-semibold">{restOfTitle}</span>
        </h1>
      </div>
      <p className="text-[#1E1E1E] text-xl font-semibold">{subtitle}</p>
    </div>
  )
}
