import { offlineDb, newClientId, type OutboxItem } from "./db";

// Fila de sincronização dos lançamentos feitos sem internet.
//
// Quem grava (a tela de Relatórios) tenta o servidor primeiro; se não tem rede
// ou o servidor não responde, chama enqueue() e segue a vida. Esta fila envia
// os itens assim que houver conexão (evento online, volta pro app, a cada
// minuto e no botão "Sincronizar agora"), na ordem em que foram criados, um
// navio de cada vez. O item só sai da fila quando o servidor confirma.
//
// Falhas:
// - Sem rede / 5xx de borda (Railway empacado): o item volta pra "pendente" e
//   a próxima rodada tenta de novo. A fila inteira para nessa rodada.
// - 401: a sessão expirou no navio. A fila para e avisa pra logar de novo.
// - Outro 4xx (validação, relatório concluído pela gestão...): o item fica em
//   "erro" com a mensagem do servidor e SEGURA os itens seguintes do mesmo
//   navio (um "Concluir" depois de uma foto rejeitada também falharia). O
//   supervisor vê na faixa de sincronização e decide: tentar de novo ou
//   descartar.

export type SyncEvent =
  | { type: "change" } // a fila mudou (contagens)
  | { type: "running"; running: boolean }
  | { type: "synced"; item: OutboxItem; data: unknown }
  | { type: "failed"; item: OutboxItem; message: string; permanent: boolean }
  | { type: "auth" }; // 401 — precisa logar de novo pra enviar

type Listener = (e: SyncEvent) => void;
const listeners = new Set<Listener>();

export function subscribeSync(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(e: SyncEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      // ouvinte quebrado não derruba a fila
    }
  }
}

export function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

// fetch() rejeita com TypeError quando não há rede (ou o DNS/TLS falha). Com o
// service worker no meio, requisições não-GET passam direto e falham do mesmo
// jeito — é esse erro que manda o lançamento pra fila.
export function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof DOMException && err.name === "AbortError");
}

// Respostas de borda que não dizem nada sobre o lançamento em si: vale
// guardar e tentar depois.
export function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || status === 408 || status === 429;
}

// Sessão expirada: 401 direto ou o middleware de login redirecionando a
// chamada da API pra /login (em produção ele responde 307 sem sessão).
export function isAuthFailure(res: Response): boolean {
  if (res.status === 401) return true;
  if (!res.redirected) return false;
  try {
    return new URL(res.url).pathname.startsWith("/login");
  } catch {
    return false;
  }
}

export type EnqueueInput = Omit<OutboxItem, "id" | "created_at" | "status" | "attempts"> & { id?: string };

export async function enqueue(input: EnqueueInput): Promise<OutboxItem> {
  const db = offlineDb();
  const item: OutboxItem = {
    ...input,
    id: input.id || newClientId(),
    created_at: new Date().toISOString(),
    status: "pendente",
    attempts: 0,
  };
  await db.transaction("rw", db.outbox, async () => {
    // Um pendente "igual" (mesmo relatório, mesma legenda de bloco...) é
    // substituído: o último estado é o que vale, e a fila não acumula lixo.
    if (item.dedupe_key) {
      await db.outbox.where("dedupe_key").equals(item.dedupe_key).delete();
    }
    await db.outbox.put(item);
  });
  emit({ type: "change" });
  return item;
}

// Apaga pendentes com a mesma chave: um envio direto que deu certo torna o
// pendente antigo (feito offline) obsoleto — se subisse depois, voltaria o
// relatório pra versão velha.
export async function dropQueued(dedupeKey: string): Promise<void> {
  const n = await offlineDb().outbox.where("dedupe_key").equals(dedupeKey).delete();
  if (n > 0) emit({ type: "change" });
}

export async function removeFromOutbox(id: string): Promise<void> {
  await offlineDb().outbox.delete(id);
  emit({ type: "change" });
}

export async function getOutboxItem(id: string): Promise<OutboxItem | undefined> {
  return offlineDb().outbox.get(id);
}

export async function patchOutboxBody(id: string, patch: Record<string, unknown>): Promise<boolean> {
  const db = offlineDb();
  const item = await db.outbox.get(id);
  if (!item) return false;
  await db.outbox.update(id, { body: { ...(item.body || {}), ...patch } });
  return true;
}

export async function listOutbox(jobId?: string, kind?: string): Promise<OutboxItem[]> {
  const db = offlineDb();
  const items =
    jobId && kind
      ? await db.outbox.where("[job_id+kind]").equals([jobId, kind]).toArray()
      : jobId
        ? await db.outbox.where("job_id").equals(jobId).toArray()
        : await db.outbox.toArray();
  return items.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function outboxCounts(): Promise<{ pending: number; errors: number }> {
  try {
    const all = await offlineDb().outbox.toArray();
    let errors = 0;
    for (const i of all) if (i.status === "erro") errors++;
    return { pending: all.length - errors, errors };
  } catch {
    return { pending: 0, errors: 0 };
  }
}

// Volta os itens com erro pra "pendente" e dispara uma rodada.
export async function retryErrors(): Promise<void> {
  const db = offlineDb();
  await db.outbox.where("status").equals("erro").modify({ status: "pendente", last_error: undefined });
  emit({ type: "change" });
  await syncNow();
}

let running = false;
let needsAuth = false;

export function syncNeedsAuth(): boolean {
  return needsAuth;
}

// Uma rodada de envio. Devolve quantos itens subiram. Nunca roda em paralelo
// com ela mesma; sem rede nem tenta.
export async function syncNow(): Promise<{ sent: number; stopped: boolean }> {
  if (running || !isOnline()) return { sent: 0, stopped: true };
  running = true;
  emit({ type: "running", running: true });
  let sent = 0;
  let stopped = false;
  try {
    const db = offlineDb();
    const all = (await db.outbox.toArray()).sort((a, b) => a.created_at.localeCompare(b.created_at));

    // Por navio, na ordem de criação. Um erro permanente segura só o navio
    // dele; falta de rede / 401 / 5xx para a rodada inteira.
    const groups = new Map<string, OutboxItem[]>();
    for (const item of all) {
      const list = groups.get(item.job_id) || [];
      list.push(item);
      groups.set(item.job_id, list);
    }

    outer: for (const items of groups.values()) {
      for (const item of items) {
        if (item.status === "erro") break; // segura os seguintes deste navio

        await db.outbox.update(item.id, { status: "enviando" });
        let res: Response;
        try {
          res = await fetch(item.url, {
            method: item.method,
            headers: item.body ? { "Content-Type": "application/json" } : undefined,
            body: item.body ? JSON.stringify(item.body) : undefined,
          });
        } catch (err) {
          await db.outbox.update(item.id, {
            status: "pendente",
            attempts: item.attempts + 1,
            last_error: err instanceof Error ? err.message : "sem conexão",
          });
          stopped = true;
          break outer;
        }

        if (isAuthFailure(res)) {
          await db.outbox.update(item.id, { status: "pendente", last_error: "sessão expirada" });
          needsAuth = true;
          emit({ type: "auth" });
          stopped = true;
          break outer;
        }
        needsAuth = false;

        const json = (await res.json().catch(() => ({}))) as { data?: unknown; error?: string };

        // Exclusão de algo que já não existe = feito.
        const goneIsOk = (item.op === "photo_delete" || item.op === "section_delete") && res.status === 404;

        if (res.ok || goneIsOk) {
          await db.outbox.delete(item.id);
          sent++;
          emit({ type: "synced", item, data: json.data });
          continue;
        }

        if (isRetryableStatus(res.status)) {
          await db.outbox.update(item.id, {
            status: "pendente",
            attempts: item.attempts + 1,
            last_error: `servidor indisponível (${res.status})`,
          });
          stopped = true;
          break outer;
        }

        const message = json.error || `erro ${res.status}`;
        await db.outbox.update(item.id, { status: "erro", attempts: item.attempts + 1, last_error: message });
        emit({ type: "failed", item, message, permanent: true });
        break; // próximo navio
      }
    }
  } finally {
    running = false;
    emit({ type: "running", running: false });
    emit({ type: "change" });
  }
  return { sent, stopped };
}

// Gatilhos automáticos: voltou a rede, voltou pro app, e um relógio de 1 min.
export function startSyncScheduler(): () => void {
  if (typeof window === "undefined") return () => {};
  const run = () => {
    syncNow().catch(() => {});
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  window.addEventListener("online", run);
  window.addEventListener("focus", run);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(run, 60_000);
  run();
  return () => {
    window.removeEventListener("online", run);
    window.removeEventListener("focus", run);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
  };
}

// Descrição curta do item pra faixa de sincronização.
export function describeOutboxItem(item: OutboxItem): string {
  const KIND: Record<string, string> = {
    EMBARQUE: "Lavagem",
    COSTADO: "Costado",
    RASPAGEM: "Raspagem",
    PINTURA: "Pintura",
  };
  const kind = KIND[item.kind] || item.kind;
  const STAGE: Record<string, string> = { ANTES: "Antes", DURANTE: "Durante", DEPOIS: "Depois" };
  switch (item.op) {
    case "report":
      return `Relatório de ${kind}`;
    case "evaluations":
      return `Avaliações (${kind})`;
    case "section":
      return `Legenda do bloco “${String(item.body?.label || "")}”`;
    case "section_delete":
      return `Remoção do bloco “${item.hold_label || ""}”`;
    case "photo": {
      const stage = item.stage && STAGE[item.stage] ? ` · ${STAGE[item.stage]}` : "";
      return `Foto · ${item.hold_label || "Geral"}${stage}`;
    }
    case "photo_caption":
      return "Legenda de foto";
    case "photo_delete":
      return "Exclusão de foto";
    default:
      return item.op;
  }
}
