import type { Connection } from "../types/connection"

export const connections: Connection[] = [
  {
    id: "conn-1",
    status: "connected",
    phoneNumber: "+55 99 99999-9999",
    userName: "Pietro Pazini",
    statusColor: "#00a884",
    statusLabel: "Conectado",
    actionLabel: "Desconectar",
    actionPrimary: false,
    lastActive: "5 min",
    messageCount: 128,
  },
  {
    id: "conn-2",
    status: "disconnected",
    phoneNumber: "+55 99 99999-9999",
    userName: "Pietro Pazini",
    statusColor: "#f5a623",
    statusLabel: "Desconectado",
    actionLabel: "Reconectar",
    actionPrimary: true,
    lastActive: "2 dias",
  },
  {
    id: "conn-3",
    status: "free",
    statusColor: "#0052cc",
    statusLabel: "Livre",
    actionLabel: "Criar",
    actionPrimary: true,
  },
]
