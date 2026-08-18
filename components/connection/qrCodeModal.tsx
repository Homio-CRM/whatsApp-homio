"use client"

import * as React from "react"
import { useState, useEffect, useRef, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import QRCode from "react-qr-code"
import Loading from "../Loading"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const POLL_INTERVAL_MS = 3000
const POLL_DURATION_MS = 120000 // 2 minutes

interface QrCodeModalProps {
    open: boolean
    instanceName: string
    locationId?: string
    onClose: () => void
    onConnected?: () => void
}

export function QrCodeModal({ open, instanceName, locationId, onClose, onConnected }: QrCodeModalProps) {
    const [qrValue, setQrValue] = useState<string>("")
    const [loading, setLoading] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)
    const [connected, setConnected] = useState<boolean>(false)
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const pollStartRef = useRef<number>(0)

    // Fetch QR code when modal opens
    useEffect(() => {
        if (!open || !instanceName) return
        setLoading(true)
        setError(null)
        setConnected(false)
        setQrValue("")

        fetch(`${SUPABASE_URL}/functions/v1/evolution-connect-instance-v2`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ instanceName }),
        })
            .then(res => {
                if (!res.ok) return res.text().then(txt => { throw new Error(txt || res.statusText) })
                return res.json()
            })
            .then(data => {
                // Prefer raw QR code text (for react-qr-code), fallback to base64
                const code = data?.data?.qrCode || data?.code || ''
                if (code) {
                    setQrValue(code)
                } else {
                    setError("QR Code vazio - a instância pode já estar conectada")
                }
            })
            .catch(err => {
                console.error("Erro ao obter QR code:", err)
                setError("Falha ao carregar QR Code")
            })
            .finally(() => setLoading(false))
    }, [open, instanceName])

    // Poll for connection status for 2 minutes
    useEffect(() => {
        if (!open || !instanceName || !locationId || connected) return

        pollStartRef.current = Date.now()

        const checkStatus = async () => {
            // Stop polling after 2 minutes
            if (Date.now() - pollStartRef.current > POLL_DURATION_MS) {
                if (pollRef.current) clearInterval(pollRef.current)
                return
            }

            try {
                const res = await fetch(
                    `${SUPABASE_URL}/functions/v1/evolution-get-instances?locationId=${encodeURIComponent(locationId)}&checkEvolution=true&instanceName=${encodeURIComponent(instanceName)}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                        },
                    }
                )
                if (!res.ok) return
                const data = await res.json()
                const instances: any[] = data?.instances ?? []
                const target = instances.find((i: any) => i.instanceName === instanceName)
                if (target?.connectionStatus === 'open') {
                    setConnected(true)
                    if (pollRef.current) clearInterval(pollRef.current)
                    // Small delay so user sees "Conectado!" before modal closes
                    setTimeout(() => {
                        onConnected?.()
                        onClose()
                    }, 1500)
                }
            } catch (_e) {
                // silent - polling failures are non-fatal
            }
        }

        pollRef.current = setInterval(checkStatus, POLL_INTERVAL_MS)
        // Also check immediately
        checkStatus()

        return () => {
            if (pollRef.current) clearInterval(pollRef.current)
        }
    }, [open, instanceName, locationId, connected])

    // Cleanup on close
    useEffect(() => {
        if (!open) {
            if (pollRef.current) clearInterval(pollRef.current)
            setConnected(false)
            setQrValue("")
            setError(null)
        }
    }, [open])

    return (
        <Dialog open={open} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>Conectar Instância</DialogTitle>
                    <DialogDescription>
                        Escaneie o QR code abaixo com o WhatsApp para conectar a sua instância.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col items-center justify-center py-6 gap-4">
                    {connected ? (
                        <div className="flex flex-col items-center gap-2 text-green-600">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <span className="font-semibold text-lg">Conectado!</span>
                        </div>
                    ) : loading ? (
                        <Loading />
                    ) : error ? (
                        <div className="text-red-500">{error}</div>
                    ) : qrValue ? (
                        <QRCode value={qrValue} size={200} />
                    ) : null}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>Cancelar</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
