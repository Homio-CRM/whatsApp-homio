"use client"

import { createContext, ReactNode, useEffect, useState, useMemo } from "react"
import useSWR from "swr"
import type { Connection } from "@/types/connection"

export type InstancesContextValue = {
    locationId: string,
    instances: Connection[]
    isLoading: boolean
    error?: string
    refreshInstances: () => Promise<any>
}

export const InstancesContext = createContext<InstancesContextValue>({
    locationId: '',
    instances: [],
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

    const fetcher = async (url: string): Promise<{ instances: Connection[], locationId: string }> => {
        if(!url) return {instances: [], locationId: ''}
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

    const priorityOrder = [
        process.env.NEXT_PUBLIC_PROVIDER1!,
        process.env.NEXT_PUBLIC_PROVIDER2!,
        process.env.NEXT_PUBLIC_PROVIDER3!,
        process.env.NEXT_PUBLIC_PROVIDER4!,
    ]

    const sortedInstances = useMemo(() => {
    if (!data?.instances) return []
    return [...data.instances].sort((a, b) => {
        const idxA = priorityOrder.indexOf(a.provider)
        const idxB = priorityOrder.indexOf(b.provider)
        return (idxA === -1 ? Infinity : idxA) - (idxB === -1 ? Infinity : idxB)
    })
    }, [data?.instances])

    if (!data?.locationId) {
        return <div>Buscando dados do usuário…</div>
    }

    const value: InstancesContextValue = {
        locationId: data?.locationId,
        instances: sortedInstances ?? [],
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
