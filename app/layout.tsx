
import type React from "react"
import "./globals.css"
import type { Metadata } from "next"
import { Open_Sans } from "next/font/google"
import { InstancesProvider } from "@/lib/context/instancesContext"

const openSans = Open_Sans({
  subsets: ["latin"],
  display: "swap",
  weight: ["300", "400", "500", "600", "700", "800"],
})

export const metadata: Metadata = {
  title: "WhatsApp Integration",
  description: "WhatsApp integrado à Homio",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="pt-BR">
      <body className={openSans.className}>
        <InstancesProvider>
          {children}
        </InstancesProvider>
      </body>
    </html >
  )
}
