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

export function InstancesProvider({ children }: { children: ReactNode }) {
    const [token, setToken] = useState<string | null>(null)

    useEffect(() => {

        window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*")

        window.postMessage(
            {
                message: "REQUEST_USER_DATA_RESPONSE",
                payload: "U2FsdGVkX1+lebtBQv/4SaoChdei4W5QOPms3uQNdMW03O2/3i2qM8+YYnDhpqpd+hfHnSnWKLDhszh0XLN+enG7zEUfke/Q7sSwyYsqRhkEQ+fxV8uNQyu6Kq4QIRJaYZAMyvTzhPBJzjmtageUWE692u+6hRYnnqaZMMfjm/m2K1VVRiX9tQ8+bmWXYswZuHnTedo+2nwez8RaUbVdFULmhDA47OcB5/tpZUy68gpoqpDSLff562qGHJxgAjPsbAgBJYKGcWFr4oRnEzaAN7Lysvz8QlANDwUYK81V1+Y=",
            },
            "*"
        )

        const handleMessage = (event: MessageEvent) => {
            if (event.data?.message === "REQUEST_USER_DATA_RESPONSE") {
                setToken(event.data.payload)
            }
        }
        window.addEventListener("message", handleMessage)
        return () => window.removeEventListener("message", handleMessage)
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
