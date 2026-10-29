import Dexie, { type EntityTable } from "dexie";

// Banco local do celular (IndexedDB via Dexie) pros Relatórios de Bordo
// funcionarem sem internet, no meio do navio.
//
// - `outbox`: fila de saída. Cada lançamento feito sem rede vira um item aqui,
//   com UUID gerado no celular, data/hora e status "pendente". A sincronização
//   (src/lib/offline/sync.ts) envia na ordem e só apaga o item depois que o
//   servidor confirma.
// - `snapshots`: última cópia que o celular viu da lista de navios e de cada
//   relatório. Quando o GET falha por falta de rede, a tela abre a partir
//   daqui e aplica por cima o que ainda está na fila.
//
// Nada aqui depende da sessão: se o login expirar no navio, a fila continua
// guardada e segue depois que o supervisor logar de novo.

export type OutboxOp =
  | "report" // PUT /api/relatorios/[jobId] — cabeçalho + porões + atividades
  | "evaluations" // PUT /api/relatorios/[jobId]/avaliacoes
  | "section" // POST /api/relatorios/[jobId]/secoes — legenda do bloco
  | "section_delete" // DELETE /api/relatorios/[jobId]/secoes
  | "photo" // POST /api/relatorios/[jobId]/fotos — foto nova (client_id = id do item)
  | "photo_caption" // PATCH /api/relatorios/fotos/[id]
  | "photo_delete"; // DELETE /api/relatorios/fotos/[id]

export type OutboxStatus = "pendente" | "enviando" | "erro";

export interface OutboxItem {
  // UUID gerado no celular. Nas fotos ele viaja como client_id: o servidor
  // devolve a foto já existente se o mesmo id chegar duas vezes.
  id: string;
  created_at: string; // ISO
  job_id: string;
  kind: string; // EMBARQUE | COSTADO | RASPAGEM | PINTURA
  op: OutboxOp;
  method: "PUT" | "POST" | "PATCH" | "DELETE";
  url: string;
  body?: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  last_error?: string;
  // Chave de agrupamento pra substituir um pendente igual (ex.: dois "Salvar"
  // seguidos do mesmo relatório viram um item só; legenda do mesmo bloco idem).
  dedupe_key?: string;
  // Só nas fotos: rótulo/fase pra tela montar a foto local antes do envio.
  hold_label?: string | null;
  stage?: string;
}

export interface Snapshot {
  key: string; // "navios" | "report:<jobId>:<kind>"
  saved_at: string; // ISO
  data: unknown;
}

class OfflineDb extends Dexie {
  outbox!: EntityTable<OutboxItem, "id">;
  snapshots!: EntityTable<Snapshot, "key">;

  constructor() {
    super("cargo-stock-offline");
    this.version(1).stores({
      outbox: "id, created_at, job_id, [job_id+kind], status, dedupe_key",
      snapshots: "key",
    });
  }
}

let instance: OfflineDb | null = null;

// Instância preguiçosa: o módulo é importado por componentes que também
// renderizam no servidor (sem IndexedDB). Só abre no navegador.
export function offlineDb(): OfflineDb {
  if (!instance) instance = new OfflineDb();
  return instance;
}

export function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback (contexto não seguro): v4 a partir de getRandomValues.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function saveSnapshot(key: string, data: unknown): Promise<void> {
  try {
    await offlineDb().snapshots.put({ key, saved_at: new Date().toISOString(), data });
  } catch {
    // sem IndexedDB (modo privado antigo) a tela segue só online
  }
}

export async function readSnapshot<T>(key: string): Promise<{ data: T; saved_at: string } | null> {
  try {
    const row = await offlineDb().snapshots.get(key);
    return row ? { data: row.data as T, saved_at: row.saved_at } : null;
  } catch {
    return null;
  }
}
