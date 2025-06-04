"use client"

import { createContext, ReactNode, useEffect, useState } from "react"
import useSWR from "swr"
import type { Connection } from "@/types/connection"

export type InstancesContextValue = {
    locationId: string,
    instances: Connection[]
    isLoading: boolean
    error?: string
}

export const InstancesContext = createContext<InstancesContextValue>({
    locationId: '',
    instances: [],
    isLoading: true,
})

export function InstancesProvider({ children }: { children: ReactNode }) {
    const [token, setToken] = useState<string | null>(null)

    useEffect(() => {

        window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*")

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

    const { data, error } = useSWR(
        token !== null
            ? `/api/instances?token=${encodeURIComponent(token)}`
            : null,
        fetcher,
        { keepPreviousData: true }
    )


    if (!data?.locationId) {
        return <div>Buscando dados do usuário…</div>
    }

    const value: InstancesContextValue = {
        locationId: data?.locationId,
        instances: data?.instances ?? [],
        isLoading: !data && !error,
        error: error?.message,
    }

    return (
        <InstancesContext.Provider value={value}>
            {children}
        </InstancesContext.Provider>
    )
}
