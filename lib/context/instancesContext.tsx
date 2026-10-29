"use client"

import { createContext, ReactNode, useEffect, useState, useMemo } from "react"
import useSWR from "swr"
import type { Connection } from "@/types/connection"

export type InstancesContextValue = {
    locationId: string,
    instances: Connection[]
    /** teto de slots da subconta (location_settings.max_instances na EF; 4 quando nao ha linha) */
    maxInstances: number
    isLoading: boolean
    error?: string
    refreshInstances: () => Promise<any>
}

const DEFAULT_MAX_INSTANCES = 4

export const InstancesContext = createContext<InstancesContextValue>({
    locationId: '',
    instances: [],
    maxInstances: DEFAULT_MAX_INSTANCES,
    isLoading: true,
    refreshInstances: async () => {},
})

// Sem resposta do GHL nesse prazo, a pagina foi aberta fora da Homio (link direto)
const SEM_RESPOSTA_MS = 10_000

export function InstancesProvider({ children }: { children: ReactNode }) {
    const [token, setToken] = useState<string | null>(null)
    const [semResposta, setSemResposta] = useState(false)

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (event.data?.message === "REQUEST_USER_DATA_RESPONSE") {
                setToken(event.data.payload)
            }
        }
        // Escuta antes de pedir. Ate 2026-10-28 a pagina tambem postava para si mesma um token fixo da
        // Internal Testing: aberta fora do iframe, mostrava (e deixava excluir) as conexoes daquela
        // subconta a qualquer visitante, e dentro do iframe podia piscar a subconta errada.
        window.addEventListener("message", handleMessage)
        window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*")
        const timer = setTimeout(() => setSemResposta(true), SEM_RESPOSTA_MS)
        return () => {
            window.removeEventListener("message", handleMessage)
            clearTimeout(timer)
        }
    }, [])

    const fetcher = async (url: string): Promise<{ instances: Connection[], locationId: string, maxInstances?: number }> => {
        if(!url) return {instances: [], locationId: '', maxInstances: DEFAULT_MAX_INSTANCES}
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
    }

    const { data, error, mutate } = useSWR(
        token !== null
            ? `/api/instances?token=${encodeURIComponent(token)}`
            : null,
        fetcher,
        // Sem polling: o status chega pelo canal de Broadcast (connectionGrid). Cada recarga passa pelo n8n do SSO.
        { keepPreviousData: true }
    )

    // Ordem dos cards = sufixo da instancia (<locationId>-<n>). Antes era a ordem das env
    // NEXT_PUBLIC_PROVIDER1..4, que nao conhece o 5o provider e nao escala com N slots.
    const sortedInstances = useMemo(() => {
        if (!data?.instances) return []
        const suffix = (c: Connection) => {
            const m = c.instanceName?.match(/-(\d+)$/)
            return m ? parseInt(m[1], 10) : Infinity
        }
        return [...data.instances].sort((a, b) => suffix(a) - suffix(b))
    }, [data?.instances])

    if (!data?.locationId) {
        // Antes um erro deixava a tela presa em "Buscando dados do usuário…" para sempre
        if (error) {
            return (
                <div role="alert" className="m-6 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                    <span>Não foi possível carregar suas conexões agora. Se continuar, fale com o suporte da Homio.</span>
                    <button onClick={() => mutate()} className="shrink-0 font-medium text-red-700 hover:text-red-900">Tentar de novo</button>
                </div>
            )
        }
        if (token === null && semResposta) {
            return <div className="m-6 text-sm text-gray-700">Abra esta página pelo menu do Whats Homio, dentro da Homio.</div>
        }
        return <div>Buscando dados do usuário…</div>
    }

    const value: InstancesContextValue = {
        locationId: data?.locationId,
        instances: sortedInstances ?? [],
        maxInstances: data?.maxInstances ?? DEFAULT_MAX_INSTANCES,
        isLoading: !data && !error,
        error: error?.message,
        refreshInstances: () => mutate(),
    }

    return (
        <InstancesContext.Provider value={value}>
            {children}
        </InstancesContext.Provider>
    )
}
