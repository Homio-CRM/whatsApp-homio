"use client"

import * as React from "react"
import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import QRCode from "react-qr-code"
import Loading from "../Loading"


interface QrCodeModalProps {
    open: boolean
    instanceName: string
    onClose: () => void
}

export function QrCodeModal({ open, instanceName, onClose }: QrCodeModalProps) {
    const [qrValue, setQrValue] = useState<string>("")
    const [loading, setLoading] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!open || !instanceName) return
        setLoading(true)
        setError(null)
        fetch(
            `https://api.homio.com.br/webhook/get-instance-qrcode?instanceName=${encodeURIComponent(instanceName)}`
        )
            .then(res => {
                if (!res.ok) return res.text().then(txt => { throw new Error(txt || res.statusText) })
                return res.json()
            })
            .then(data => {
                setQrValue(data.code)
            })
            .catch(err => {
                console.error("Erro ao obter QR code:", err)
                setError("Falha ao carregar QR Code")
            })
            .finally(() => {
                setLoading(false)
            })
    }, [open, instanceName])

    return (
        <Dialog open={open} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>Conectar Instância</DialogTitle>
                    <DialogDescription>
                        Escaneie o QR code abaixo com o WhatsApp para conectar a sua istância.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex justify-center py-6">
                    {loading ? (
                        <div><Loading /></div>
                    ) : error ? (
                        <div className="text-red-500">{error}</div>
                    ) : (
                        <QRCode value={qrValue} size={200} />
                    )}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>Cancelar</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
