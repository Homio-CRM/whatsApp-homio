"use client"

import { createContext, ReactNode, useEffect, useState } from "react"
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
                payload: "U2FsdGVkX1/UnLd4ZElkDIUSslk9XTEECQVfr+2it+63ANtKhFsGLGi9Pts2pUdLVT8RTncDhJk2AaW8TTavLw+kFfETFMX//IOAUbqg6UNk25ulyR17RImQXmm16PXbpBAlIJGvV52FOOTdR8d1BTwEEOo0AE5KxcfLHCWwYEo4DpMX0hRA+n6HBeThXWO9dydtobVyZqDEClmOV2Q92hM9XqnIpJ8TWE03LuwjQsJPpyrB/119jVCX1ghqtBVXO5ErsfspZK40++tiPBTghC8+KOOYk9Nk8ofSmNGqyN4=",
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


    if (!data?.locationId) {
        return <div>Buscando dados do usuário…</div>
    }

    const value: InstancesContextValue = {
        locationId: data?.locationId,
        instances: data?.instances ?? [],
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
