"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { isOnline, outboxCounts, startSyncScheduler, subscribeSync, syncNow } from "./sync";

// Estado da sincronização offline pra interface (faixa no topo + tela de
// Relatórios): online/offline, quantos lançamentos esperam envio, se há erro e
// se a sessão expirou. Vive no layout do dashboard, então a fila continua
// sendo enviada em qualquer aba do sistema.

interface SyncState {
  online: boolean;
  pending: number;
  errors: number;
  syncing: boolean;
  needsLogin: boolean;
  lastSyncAt: Date | null;
  syncNow: () => Promise<void>;
}

const SyncContext = createContext<SyncState>({
  online: true,
  pending: 0,
  errors: 0,
  syncing: false,
  needsLogin: false,
  lastSyncAt: null,
  syncNow: async () => {},
});

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [errors, setErrors] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);

  const refreshCounts = useCallback(async () => {
    const c = await outboxCounts();
    setPending(c.pending);
    setErrors(c.errors);
  }, []);

  useEffect(() => {
    setOnline(isOnline());
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);

    const unsubscribe = subscribeSync((e) => {
      if (e.type === "change") refreshCounts();
      else if (e.type === "running") {
        setSyncing(e.running);
        if (!e.running) setLastSyncAt(new Date());
      } else if (e.type === "synced") setNeedsLogin(false);
      else if (e.type === "auth") setNeedsLogin(true);
    });
    refreshCounts();
    const stop = startSyncScheduler();
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      unsubscribe();
      stop();
    };
  }, [refreshCounts]);

  const manualSync = useCallback(async () => {
    await syncNow();
    await refreshCounts();
  }, [refreshCounts]);

  return (
    <SyncContext.Provider value={{ online, pending, errors, syncing, needsLogin, lastSyncAt, syncNow: manualSync }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  return useContext(SyncContext);
}
