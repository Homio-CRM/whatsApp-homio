import { Connection } from "@/types/connection"

export type FetchInstancesSuccess = { instances: Connection[] }
export type FetchInstancesError = { error: string }
export type FetchInstancesResult = FetchInstancesSuccess | FetchInstancesError

export default async function fetchInstances(
    locationId: string
): Promise<FetchInstancesResult> {
    try {
        const res = await fetch(
            `/instances?locationId=${locationId}`,
        )
        if (!res.ok) {
            return { error: `HTTP ${res.status}: ${res.statusText}` }
        }

        const text = await res.text()
        if (!text) {
            return { instances: [] }
        }

        const json = JSON.parse(text) as FetchInstancesSuccess
        return json
    } catch (err) {
        return {
            error: err instanceof Error
                ? err.message
                : "Erro desconhecido ao buscar instâncias",
        }
    }
}
