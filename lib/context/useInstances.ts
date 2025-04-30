"use client"

import { useContext } from "react"
import { InstancesContext } from "./instancesContext"

export function useInstances() {
    const ctx = useContext(InstancesContext)
    if (!ctx) throw new Error("useInstances must be used within InstancesProvider")
    return ctx
}
