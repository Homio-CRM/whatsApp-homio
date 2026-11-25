export const ESPERA_MIN = 10;

export type Candidato = {
  event_id: number; instance_name: string; location_id: string | null; number_connected: string | null;
  name_connected: string | null; closed_at: string; reopened_at: string | null; prev_401_24h: number;
  api_sends: number; api_dest: number; device_sends: number; device_sources: Record<string, number>;
  inbound: number; cold_dest: number;
};

const brt = (iso: string) => new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
}).format(new Date(iso));

export function montarAviso(c: Candidato): string {
  const quem = c.name_connected?.trim() || "(sem nome de perfil)";
  const numero = c.number_connected ? ` · ${c.number_connected}` : "";
  const linhas = [
    "⚠️ *WhatsApp Homio — possível restrição*",
    `*${quem}*${numero}`,
    `Instância ${c.instance_name}`,
    "",
  ];
  if (c.reopened_at) {
    linhas.push(`Caiu com 401 em ${brt(c.closed_at)} (BRT) e voltou em ${brt(c.reopened_at)}.`);
  } else {
    linhas.push(`Caiu com 401 em ${brt(c.closed_at)} (BRT) e não voltou em ${ESPERA_MIN} min.`);
  }
  if (c.prev_401_24h > 0) linhas.push(`É o ${c.prev_401_24h + 1}º 401 desta instância em 24 h.`);

  const origens = Object.entries(c.device_sources ?? {})
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  linhas.push(
    "",
    "Nas 24 h antes da queda:",
    `• API (GHL/automação): ${c.api_sends} envios para ${c.api_dest} contatos`,
    `• Celular/Web do cliente: ${c.device_sends} envios${origens ? ` (${origens})` : ""}`,
    `• Recebidas: ${c.inbound}`,
    `• Contatos que receberam e não escreveram: ${c.cold_dest}`,
    "",
    "Não fazer logout nem gerar QR agora: esperar a contagem e perguntar ao cliente o que foi disparado.",
    "Runbook no wiki: debug_restricao_temporaria_whatsapp",
  );
  return linhas.join("\n");
}

export function deveAvisar(c: Candidato): boolean {
  return !c.reopened_at || c.prev_401_24h > 0;
}
