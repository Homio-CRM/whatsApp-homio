"use client"

import { createContext, ReactNode, useEffect, useState } from "react"
import useSWR from "swr"
import type { Connection } from "@/types/connection"

export type InstancesContextValue = {
    instances: Connection[]
    isLoading: boolean
    error?: string
}

export const InstancesContext = createContext<InstancesContextValue>({
    instances: [],
    isLoading: true,
})

export function InstancesProvider({ children }: { children: ReactNode }) {

    const [locationId, setLocationId] = useState<string | null>(null)

    useEffect(() => {

        window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*")

        window.postMessage(
            {
                message: "REQUEST_USER_DATA_RESPONSE",
                payload: {
                    locationId: "d8voPwkhJK7k7S5xjHcA",
                    userId: "user456",
                    userName: "João Silva",
                    email: "joao@example.com",
                },
            },
            "*"
        )

        const handleMessage = (event: MessageEvent) => {
            if (event.data?.message === "REQUEST_USER_DATA_RESPONSE") {
                setLocationId(event.data.payload.locationId)
            }
        }
        window.addEventListener("message", handleMessage)
        return () => window.removeEventListener("message", handleMessage)
    }, [])

    const fetcher = async (url: string): Promise<{ instances: Connection[] }> => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
    }

    const { data, error } = useSWR(
        locationId
            ? `/api/instances?locationId=${locationId}`
            : null,
        fetcher,
        { keepPreviousData: true }
    )


    if (!locationId) {
        return <div>Buscando dados do usuário…</div>
    }

    const value: InstancesContextValue = {
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
