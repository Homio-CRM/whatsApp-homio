export const FORA_H = 2; // instancia fora ha mais que isso vira incidente
export const LEMBRETE_H = 24;
export const FECHA_SEM_ERRO_D = 7; // sem_instancia sem erro novo nesse tempo fecha sozinho, sem aviso
export const JANELA_SEM_INSTANCIA_H = 24;

export type Fora = {
  instance_name: string; location_id: string; status: string; desde: string; perfil: string | null;
  numero: string | null; erros: number; ultimo_erro_em: string | null; restricao: boolean;
};
export type SemInstancia = { location_id: string; erros: number; primeiro: string; ultimo: string; instancias: number };

/** Uma linha do aviso. `nome` e o da subconta na GHL (ou o location_id, se a GHL nao respondeu). */
export type Item = {
  location_id: string; nome: string; perfil?: string | null; numero?: string | null; status?: string;
  desde: string; erros: number; restricao?: boolean; instancias?: number; primeiro?: string; ultimo?: string;
  como?: "voltou" | "removida";
};

export const brt = (iso: string) => new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
}).format(new Date(iso)).replace(",", "");

const n = (q: number, um: string, varios: string) => `${q} ${q === 1 ? um : varios}`;
const quem = (i: Item) => `*${i.nome}*${i.perfil?.trim() ? ` — ${i.perfil.trim()}` : ""}${i.numero ? ` · ${i.numero}` : ""}`;

/** Slot criado e nunca pareado nao e queda, a nao ser que alguem esteja mandando por ele. */
export function deveAbrirFora(f: Fora, agoraMs: number): boolean {
  if (agoraMs - Date.parse(f.desde) < FORA_H * 3600_000) return false;
  return !!f.numero || f.erros > 0;
}

export function montarAviso(p: {
  novosFora: Item[]; novosSem: Item[]; lembretesFora: Item[]; lembretesSem: Item[]; voltaram: Item[]; agora: string;
}): string {
  const blocos: string[] = [];

  if (p.novosFora.length) {
    const linhas = p.novosFora.map((i) =>
      `• ${quem(i)}\n  fora desde ${brt(i.desde)} (${i.status})` +
      (i.erros ? ` · ${n(i.erros, "envio do GHL falhou", "envios do GHL falharam")}` : "") +
      (i.restricao ? "\n  ⚠️ caiu com 401: ler o aviso de restrição antes de pedir QR" : "")
    );
    blocos.push(
      `📵 *WhatsApp Homio fora há mais de ${FORA_H} h*\n${linhas.join("\n")}\n` +
        "O que fazer: o cliente escaneia o QR de novo na página de conexão (passa pelo CS). " +
        "Mensagem que falhou não é reenviada sozinha, e o que chegou nesse tempo não entrou na GHL.",
    );
  }

  if (p.novosSem.length) {
    const linhas = p.novosSem.map((i) =>
      `• *${i.nome}* — ${n(i.erros, "mensagem falhou", "mensagens falharam")} ` +
      (i.primeiro && i.ultimo && i.primeiro !== i.ultimo ? `(${brt(i.primeiro)} a ${brt(i.ultimo)})` : `(${brt(i.ultimo ?? i.desde)})`) +
      "\n  " + (i.instancias
        ? "A subconta tem instância, mas o envio saiu por um provedor sem número conectado (número removido ou trocado?)."
        : "A subconta não tem WhatsApp Homio: a equipe manda pelo canal \"Whats Homio\", que aparece em toda subconta porque o app está na agência.")
    );
    blocos.push(
      `🚫 *Envio pelo Whats Homio sem instância*\n${linhas.join("\n")}\n` +
        "O que fazer: mostrar à equipe do cliente o canal certo, ou conectar um número. Mensagem que falhou não é reenviada sozinha.",
    );
  }

  if (p.lembretesFora.length) {
    blocos.push("⏳ *Seguem fora:*\n" + p.lembretesFora.map((i) =>
      `• ${quem(i)}, desde ${brt(i.desde)}` + (i.erros ? ` · ${n(i.erros, "falha", "falhas")}` : "") +
      (i.restricao ? " · 401" : "")
    ).join("\n"));
  }

  if (p.lembretesSem.length) {
    blocos.push("⏳ *Seguem mandando sem instância:*\n" + p.lembretesSem.map((i) =>
      `• *${i.nome}* — ${n(i.erros, "falha", "falhas")} desde ${brt(i.desde)}, a última às ${brt(i.ultimo ?? i.desde)}`
    ).join("\n"));
  }

  for (const i of p.voltaram) {
    blocos.push(
      i.como === "removida"
        ? `🗑️ *Instância removida:* ${quem(i)} (estava fora desde ${brt(i.desde)})`
        : `✅ *Voltou:* ${quem(i)}\nFora de ${brt(i.desde)} até antes de ${brt(p.agora)}` +
          (i.erros ? ` · ${n(i.erros, "envio falhou", "envios falharam")} nesse tempo` : "") + ".",
    );
  }

  return blocos.join("\n\n");
}
