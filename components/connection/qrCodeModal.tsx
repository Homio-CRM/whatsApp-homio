"use client"

import * as React from "react"
import { useState, useEffect, useRef } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import QRCode from "react-qr-code"
import Loading from "../Loading"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

interface QrCodeModalProps {
    open: boolean
    instanceName: string
    locationId: string
    onClose: () => void
}

export function QrCodeModal({ open, instanceName, locationId, onClose }: QrCodeModalProps) {
    const [qrValue, setQrValue] = useState<string>("")
    const [loading, setLoading] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)
    const [connected, setConnected] = useState<boolean>(false)
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

    // Fetch QR code when modal opens
    useEffect(() => {
        if (!open || !instanceName) return
        setLoading(true)
        setError(null)
        setConnected(false)

        fetch(`${SUPABASE_URL}/functions/v1/evolution-connect-instance`, {
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
                const code = data?.data?.qrCode || data?.code || data?.qrcode || ''
                setQrValue(code)
            })
            .catch(err => {
                console.error("Erro ao obter QR code:", err)
                setError("Falha ao carregar QR Code")
            })
            .finally(() => setLoading(false))
    }, [open, instanceName])

    // Poll every 3s to detect when instance connects and auto-close modal
    useEffect(() => {
        if (!open || !instanceName || !locationId) return

        const checkStatus = async () => {
            try {
                const res = await fetch(`/api/instances?locationId=${encodeURIComponent(locationId)}`)
                if (!res.ok) return
                const data = await res.json()
                const instances: any[] = data?.instances ?? []
                const target = instances.find(i => i.instanceName === instanceName)
                if (target?.connectionStatus === 'open') {
                    setConnected(true)
                    clearInterval(pollRef.current!)
                    // Small delay so the user sees the "Conectado!" state before modal closes
                    setTimeout(() => onClose(), 1500)
                }
            } catch (e) {
                // silent — polling failures are non-fatal
            }
        }

        pollRef.current = setInterval(checkStatus, 3000)
        return () => { if (pollRef.current) clearInterval(pollRef.current) }
    }, [open, instanceName, locationId])

    // Cleanup on close
    useEffect(() => {
        if (!open && pollRef.current) {
            clearInterval(pollRef.current)
            setConnected(false)
            setQrValue("")
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
