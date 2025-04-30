"use client"

import type React from "react"
import { useRouter } from "next/navigation"
import { useState, useEffect } from "react"
import { ArrowRight, Info, Loader2 } from "lucide-react"

interface ActionButtonProps {
  primary?: boolean
  color: string
  children: React.ReactNode
  onClick?: () => void
  href?: string
  disabled?: boolean
  icon?: "arrow" | "info" | null
  size?: "sm" | "md" | "lg"
  fullWidth?: boolean
  className?: string
  animationDelay?: number
}

export function ActionButton({
  primary = false,
  color,
  children,
  onClick,
  href,
  disabled = false,
  icon = null,
  size = "md",
  fullWidth = true,
  className = "",
  animationDelay = 0,
}: ActionButtonProps) {
  const router = useRouter()
  const [isPressed, setIsPressed] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(true)
    }, animationDelay)

    return () => clearTimeout(timer)
  }, [animationDelay])

  const handleClick = () => {
    if (disabled || isLoading) return

    setIsLoading(true)

    setTimeout(() => {
      if (href && href !== "#") {
        router.push(href)
      } else if (onClick) {
        onClick()
      }
      setIsLoading(false)
    }, 300)
  }

  const IconComponent = icon === "arrow" ? ArrowRight : icon === "info" ? Info : null

  const sizeClasses = {
    sm: "py-2 px-4 text-sm",
    md: "py-3 px-6 text-base",
    lg: "py-4 px-8 text-lg",
  }[size]

  const widthClass = fullWidth ? "w-full" : "w-auto"

  const baseStyles = {
    borderRadius: "0.75rem",
    fontWeight: "600",
    transition: "all 0.3s cubic-bezier(0.22, 1, 0.36, 1)",
    position: "relative",
    overflow: "hidden",
    transform: isVisible ? "translateY(0) scale(1)" : "translateY(10px) scale(0.95)",
    opacity: isVisible ? 1 : 0,
  } as React.CSSProperties

  const primaryStyles = {
    backgroundColor: disabled ? `${color}80` : color,
    color: "white",
    transform: isPressed
      ? "translateY(2px) scale(0.97)"
      : isHovered
        ? "translateY(-2px) scale(1.01)"
        : isVisible
          ? "translateY(0) scale(1)"
          : "translateY(10px) scale(0.95)",
    boxShadow: isPressed
      ? "none"
      : isHovered
        ? `0 8px 25px ${color}40, 0 0 0 2px ${color}30`
        : isFocused
          ? `0 0 0 3px ${color}40`
          : "none",
  }

  const secondaryStyles = {
    backgroundColor: isHovered ? `${color}15` : "white",
    color: disabled ? `${color}80` : color,
    border: `1.5px solid ${disabled ? `${color}40` : isHovered ? color : `${color}60`}`,
    transform: isPressed
      ? "translateY(2px) scale(0.97)"
      : isHovered
        ? "translateY(-2px) scale(1.01)"
        : isVisible
          ? "translateY(0) scale(1)"
          : "translateY(10px) scale(0.95)",
    boxShadow: isPressed
      ? "none"
      : isHovered
        ? `0 6px 16px rgba(0, 0, 0, 0.1)`
        : isFocused
          ? `0 0 0 3px ${color}30`
          : "none",
  }

  const buttonStyles = {
    ...baseStyles,
    ...(primary ? primaryStyles : secondaryStyles),
    cursor: disabled ? "not-allowed" : isLoading ? "progress" : "pointer",
  }

  return (
    <button
      onClick={handleClick}
      disabled={disabled || isLoading}
      className={`${sizeClasses} ${widthClass} flex items-center justify-center gap-2 font-semibold ${className}`}
      style={buttonStyles}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      onMouseLeave={() => {
        setIsPressed(false)
        setIsHovered(false)
      }}
      onMouseEnter={() => setIsHovered(true)}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      aria-disabled={disabled || isLoading}
      role="button"
    >
      <span
        className="absolute inset-0 bg-white opacity-0 transition-opacity duration-300"
        style={{
          opacity: isPressed ? 0.2 : 0,
          transform: isPressed ? "scale(1)" : "scale(0)",
          transition: "opacity 0.3s ease, transform 0.5s ease",
        }}
      />

      <span className="relative flex items-center justify-center gap-2">
        {isLoading ? (
          <>
            <Loader2 className="animate-spin" size={size === "sm" ? 16 : size === "md" ? 18 : 20} />
            <span className="opacity-90">Carregando...</span>
          </>
        ) : (
          <>
            {children}
            {IconComponent && (
              <IconComponent
                size={size === "sm" ? 16 : size === "md" ? 18 : 20}
                className={
                  isHovered
                    ? "transform translate-x-1 transition-transform duration-300"
                    : "transition-transform duration-300"
                }
              />
            )}
          </>
        )}
      </span>
    </button>
  )
}
