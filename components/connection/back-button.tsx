import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import type { BackButtonProps } from "../../types/connection"

export function BackButton({ href, color, ariaLabel }: BackButtonProps) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center mb-8 p-3 rounded-full transition-all duration-200 hover:bg-white/80 hover:shadow-sm bg-white/60 shadow-sm"
      style={{ color }}
      aria-label={ariaLabel}
    >
      <ArrowLeft className="h-6 w-6" />
    </Link>
  )
}
