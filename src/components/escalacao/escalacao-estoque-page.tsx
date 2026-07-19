"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatDate } from "@/lib/utils";
import type { StockItem } from "@/types/database";

interface Ship {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  port: string | null;
  status: string;
  assigned_team: string | null;
}

// Item do kit de embarque (embark_kit_items) + o material do Estoque ligado.
interface KitItem {
  id: number;
  team: string;
  stock_item_id: number;
  quantity: number; // quanto a equipe leva
  stock_items: { id: number; name: string; quantity: number; location: string | null; unit: string | null } | null;
}

// Conferência de retorno de material (material_returns + itens).
interface ReturnItemRow {
  id: number;
  return_id: number;
  stock_item_id: number | null;
  item_name: string;
  went_qty: number;
  returned_qty: number;
  broken_qty: number;
  note: string | null;
}
interface MaterialReturn {
  id: number;
  ship_id: string;
  team: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  material_return_items: ReturnItemRow[];
}

// Rascunho por material na tela de Retorno (o que voltou / quebrou / obs).
interface ReturnDraft { returned: string; broken: string; note: string }

const TEAM_LABELS: Record<string, string> = {
  EQUIPE_1: "Equipe 1", EQUIPE_2: "Equipe 2", EQUIPE_3: "Equipe 3",
};

export function EscalacaoEstoquePage() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const role = profile?.role || "RH";
  const canEmbarcar = hasPermission(role, "EMBARQUE", "embarcar");

  const [ships, setShips] = useState<Ship[]>([]);
  const [selectedShip, setSelectedShip] = useState<string>("");
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [kitItems, setKitItems] = useState<KitItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmbark, setConfirmEmbark] = useState(false);
  const [embarking, setEmbarking] = useState(false);

  // Aba Embarque (preparar/baixar) x Retorno (conferir o que voltou).
  const [tab, setTab] = useState<"embarque" | "retorno">("embarque");
  const [returns, setReturns] = useState<MaterialReturn[]>([]);
  // Rascunho da conferência de retorno, por stock_item_id do material.
  const [returnDraft, setReturnDraft] = useState<Record<number, ReturnDraft>>({});
  const [returnNotes, setReturnNotes] = useState("");
  const [savingReturn, setSavingReturn] = useState(false);
  const [sendingWhats, setSendingWhats] = useState(false);
  const [returnMsg, setReturnMsg] = useState<string | null>(null);

  // Envio da lista de embarque pro grupo do WhatsApp (aba Embarque).
  const [sendingEmbarkList, setSendingEmbarkList] = useState(false);
  const [embarkMsg, setEmbarkMsg] = useState<string | null>(null);
  // Listas recolhíveis da aba Embarque (Retorno tem as suas no RetornoSection).
  const [showMat, setShowMat] = useState(true);
  const [showRancho, setShowRancho] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [shipsRes, stockRes, kitRes, retRes] = await Promise.all([
        db.from("ships").select("*").in("status", ["AGENDADO", "EM_OPERACAO"]).order("arrival_date"),
        db.from("stock_items").select("*").order("name"),
        db.from("embark_kit_items").select("*, stock_items(id, name, quantity, location, unit)"),
        db.from("material_returns").select("*, material_return_items(id, return_id, stock_item_id, item_name, went_qty, returned_qty, broken_qty, note)").order("created_at", { ascending: false }),
      ]);
      setShips((shipsRes.data as Ship[]) || []);
      setStockItems(stockRes.data || []);
      setKitItems((kitRes.data as KitItem[]) || []);
      setReturns((retRes.data as MaterialReturn[]) || []);
    } catch (err) {
      console.error("Load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData, pathname]);

  useEffect(() => {
    if (ships.length > 0 && !selectedShip) {
      setSelectedShip(ships[0].id);
    }
  }, [ships, selectedShip]);

  const currentShip = ships.find((s) => s.id === selectedShip);
  // A equipe vem do cadastro do navio (aba Navios) — não se escolhe aqui.
  // Navio sem equipe (ex.: Costado) mostra aviso e não lista kit nenhum.
  const selectedTeam = (currentShip?.assigned_team && TEAM_LABELS[currentShip.assigned_team]
    ? currentShip.assigned_team
    : null) as "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3" | null;

  const teamItems = stockItems
    .filter((i) => (i as any).team === selectedTeam)
    .filter((i) => (i as any).default_quantity > 0);

  const totalDefault = teamItems.reduce((s, i) => s + ((i as any).default_quantity || 0), 0);
  const totalCurrent = teamItems.reduce((s, i) => s + Math.min(i.quantity, (i as any).default_quantity || 0), 0);
  const pct = totalDefault > 0 ? Math.round((totalCurrent / totalDefault) * 100) : 0;
  const allReady = totalCurrent >= totalDefault && totalDefault > 0;

  const itemsWithStatus = teamItems.map((item) => {
    const def = (item as any).default_quantity || 0;
    const current = item.quantity;
    const falta = Math.max(0, def - current);
    const ready = current >= def;
    return { ...item, default_quantity: def, falta, ready };
  });

  const readyCount = itemsWithStatus.filter((i) => i.ready).length;
  const missingCount = itemsWithStatus.filter((i) => !i.ready).length;

  // Materiais do kit de embarque desta equipe (deduzidos do Estoque/GALPAO).
  const teamKit = kitItems
    .filter((k) => k.team === selectedTeam)
    .map((k) => {
      const estName = k.stock_items?.name || `#${k.stock_item_id}`;
      const emEstoque = k.stock_items?.quantity ?? 0;
      const ready = emEstoque >= k.quantity;
      return { ...k, estName, emEstoque, need: k.quantity, ready, falta: Math.max(0, k.quantity - emEstoque), location: k.stock_items?.location || "—", unit: k.stock_items?.unit || null };
    })
    .sort((a, b) => a.estName.localeCompare(b.estName, "pt-BR"));
  const matReady = teamKit.filter((k) => k.ready).length;
  const matMissing = teamKit.length - matReady;

  // Comida do Rancho também entra na conferência de retorno — mesma mecânica
  // dos materiais (rascunho por stock_item_id; Rancho e materiais são todos
  // stock_items, então os ids não colidem). O que volta bom credita o Rancho.
  const ranchoReturnables = itemsWithStatus.map((i) => ({
    id: i.id,
    stock_item_id: i.id,
    estName: i.name,
    need: i.default_quantity,
    emEstoque: i.quantity,
    location: "Rancho",
    unit: i.unit || null,
  }));

  async function handleEmbarcar() {
    if (!currentShip || !selectedTeam) return;
    setEmbarking(true);
    const actor = profile?.full_name || "Sistema";

    for (const item of itemsWithStatus) {
      if (item.quantity <= 0) continue;
      const toConsume = Math.min(item.quantity, item.default_quantity);
      await db.from("stock_movements").insert({
        stock_item_id: item.id,
        movement_type: "BAIXA",
        quantity: toConsume,
        movement_date: new Date().toISOString().split("T")[0],
        notes: `Embarque: ${currentShip.name} (${selectedTeam})`,
        created_by: actor,
      } as any);
      await db.from("stock_items").update({
        quantity: item.quantity - toConsume,
        updated_by: actor,
      } as any).eq("id", item.id);
    }

    // Materiais (kit) -> baixa do Estoque de materiais (GALPAO).
    for (const k of teamKit) {
      if (k.need <= 0 || k.emEstoque <= 0) continue;
      const toConsume = Math.min(k.emEstoque, k.need);
      await db.from("stock_movements").insert({
        stock_item_id: k.stock_item_id,
        movement_type: "BAIXA",
        quantity: toConsume,
        movement_date: new Date().toISOString().split("T")[0],
        notes: `Embarque (materiais): ${currentShip.name} (${selectedTeam})`,
        created_by: actor,
      } as any);
      await db.from("stock_items").update({
        quantity: k.emEstoque - toConsume,
        updated_by: actor,
      } as any).eq("id", k.stock_item_id);
    }

    if (currentShip.status === "AGENDADO") {
      await db.from("ships").update({ status: "EM_OPERACAO" } as any).eq("id", selectedShip);
    }

    setEmbarking(false);
    setConfirmEmbark(false);
    loadData();
  }

  // Retornos já registrados deste navio (histórico, mais recente primeiro).
  const shipReturns = returns.filter((r) => r.ship_id === selectedShip);
  // Um retorno só por navio/equipe: confirmar de novo EDITA este (o mais
  // recente cobre navios legados que chegaram a ter mais de um).
  const existingReturn = shipReturns.find((r) => r.team === selectedTeam) || null;

  // Carrega o retorno salvo pro rascunho — a tela sempre mostra/edita o que
  // está confirmado. Sem retorno salvo, começa em branco.
  useEffect(() => {
    if (!existingReturn) { setReturnDraft({}); setReturnNotes(""); return; }
    const draft: Record<number, ReturnDraft> = {};
    for (const it of existingReturn.material_return_items || []) {
      if (it.stock_item_id == null) continue;
      draft[it.stock_item_id] = {
        returned: it.returned_qty > 0 ? String(it.returned_qty) : "",
        broken: it.broken_qty > 0 ? String(it.broken_qty) : "",
        note: it.note || "",
      };
    }
    setReturnDraft(draft);
    setReturnNotes(existingReturn.notes || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingReturn?.id, returns, selectedShip, selectedTeam]);

  function setDraft(stockItemId: number, patch: Partial<ReturnDraft>) {
    setReturnDraft((prev) => {
      const base: ReturnDraft = prev[stockItemId] ?? { returned: "", broken: "", note: "" };
      return { ...prev, [stockItemId]: { ...base, ...patch } };
    });
  }

  // Linhas do retorno preenchidas (algum voltou/quebrou/obs). Usadas pra salvar
  // e pra montar o aviso de quebrados. Materiais do kit + comida do Rancho.
  function buildReturnRows() {
    return [...teamKit, ...ranchoReturnables]
      .map((k) => {
        const d = returnDraft[k.stock_item_id] || { returned: "", broken: "", note: "" };
        const returned = Math.max(0, Math.floor(parseFloat(d.returned) || 0));
        const broken = Math.max(0, Math.floor(parseFloat(d.broken) || 0));
        const note = d.note.trim();
        return { k, returned, broken, note };
      })
      .filter((r) => r.returned > 0 || r.broken > 0 || r.note);
  }

  async function handleSaveReturn() {
    if (!currentShip || !selectedTeam) return;
    const rows = buildReturnRows();
    if (rows.length === 0 && !existingReturn) {
      setReturnMsg("Preencha quanto voltou ou quebrou em pelo menos um item.");
      return;
    }
    setSavingReturn(true);
    setReturnMsg(null);
    const actor = profile?.full_name || "Sistema";
    const today = new Date().toISOString().split("T")[0];
    try {
      // Quanto cada material já tinha creditado no retorno salvo — ao editar,
      // o Estoque é ajustado só pela DIFERENÇA (não credita duas vezes).
      const oldReturned = new Map<number, number>();
      for (const it of existingReturn?.material_return_items || []) {
        if (it.stock_item_id != null) oldReturned.set(it.stock_item_id, it.returned_qty);
      }

      let returnId: number;
      if (existingReturn) {
        // Edita o retorno único: atualiza cabeçalho e regrava os itens.
        const upRes: any = await db.from("material_returns")
          .update({ notes: returnNotes.trim() || null, created_by: actor })
          .eq("id", existingReturn.id);
        if (upRes?.error) throw new Error(upRes.error.message);
        const delRes: any = await db.from("material_return_items").delete().eq("return_id", existingReturn.id);
        if (delRes?.error) throw new Error(delRes.error.message);
        returnId = existingReturn.id;
      } else {
        const insRes: any = await db.from("material_returns").insert({
          ship_id: selectedShip,
          team: selectedTeam,
          notes: returnNotes.trim() || null,
          created_by: actor,
        });
        const created = insRes.data;
        returnId = Array.isArray(created) ? created[0]?.id : created?.id;
        if (!returnId) throw new Error("Falha ao criar o retorno.");
      }

      for (const r of rows) {
        await db.from("material_return_items").insert({
          return_id: returnId,
          stock_item_id: r.k.stock_item_id,
          item_name: r.k.estName,
          went_qty: r.k.need,
          returned_qty: r.returned,
          broken_qty: r.broken,
          note: r.note || null,
        });
        // O que voltou em bom estado credita o Estoque pela diferença contra o
        // salvo (ENTRADA se aumentou, BAIXA se diminuiu); quebrado não credita.
        const delta = r.returned - (oldReturned.get(r.k.stock_item_id) || 0);
        oldReturned.delete(r.k.stock_item_id);
        if (delta !== 0) {
          await db.from("stock_movements").insert({
            stock_item_id: r.k.stock_item_id,
            movement_type: delta > 0 ? "ENTRADA" : "BAIXA",
            quantity: Math.abs(delta),
            movement_date: today,
            notes: `Retorno${existingReturn ? " (ajuste)" : ""}: ${currentShip.name} (${selectedTeam})`,
            created_by: actor,
          } as any);
          await db.from("stock_items").update({
            quantity: Math.max(0, r.k.emEstoque + delta),
            updated_by: actor,
          } as any).eq("id", r.k.stock_item_id);
        }
      }

      // Itens que saíram da edição (zerados): estorna o crédito que tinham.
      for (const [stockItemId, qty] of oldReturned) {
        if (qty <= 0) continue;
        const current = stockItems.find((i) => i.id === stockItemId)?.quantity ?? 0;
        await db.from("stock_movements").insert({
          stock_item_id: stockItemId,
          movement_type: "BAIXA",
          quantity: qty,
          movement_date: today,
          notes: `Retorno (ajuste): ${currentShip.name} (${selectedTeam})`,
          created_by: actor,
        } as any);
        await db.from("stock_items").update({
          quantity: Math.max(0, current - qty),
          updated_by: actor,
        } as any).eq("id", stockItemId);
      }

      setReturnMsg(existingReturn
        ? "✅ Retorno atualizado. O Estoque foi ajustado pela diferença."
        : "✅ Retorno confirmado. O que voltou bom foi creditado no Estoque.");
      loadData();
    } catch (err) {
      setReturnMsg(`Erro ao salvar retorno: ${(err as Error).message}`);
    } finally {
      setSavingReturn(false);
    }
  }

  async function handleSendBroken() {
    if (!currentShip || !selectedTeam) return;
    const rows = buildReturnRows().filter((r) => r.broken > 0 || (r.note && r.returned === 0));
    let brokenItems = rows.map((r) => ({ name: r.k.estName, qty: r.broken, unit: r.k.unit ?? null, note: r.note || null }));
    let notesToSend = returnNotes.trim() || null;
    // Tabela zerada (ex.: acabou de salvar o retorno, que limpa o rascunho):
    // manda os quebrados do ÚLTIMO retorno salvo deste navio/equipe — é o fluxo
    // natural de "salvar e depois enviar".
    if (brokenItems.length === 0) {
      const last = shipReturns.find((r) => r.team === selectedTeam);
      const lastBroken = (last?.material_return_items || [])
        .filter((it) => it.broken_qty > 0 || (it.note && it.returned_qty === 0));
      if (lastBroken.length > 0) {
        // Unidade não fica gravada no retorno — busca no cadastro do material.
        brokenItems = lastBroken.map((it) => ({
          name: it.item_name,
          qty: it.broken_qty,
          unit: stockItems.find((s) => s.id === it.stock_item_id)?.unit || null,
          note: it.note,
        }));
        notesToSend = last!.notes;
      }
    }
    if (brokenItems.length === 0) {
      setReturnMsg("Nada de quebrado pra enviar — preencha a coluna Quebrou (ou uma observação), ou salve um retorno com quebrados.");
      return;
    }
    setSendingWhats(true);
    setReturnMsg(null);
    try {
      const res = await fetch("/api/retorno/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipName: currentShip.name,
          team: selectedTeam,
          brokenItems,
          notes: notesToSend,
          checkedBy: profile?.full_name || null,
        }),
      });
      const data = await res.json().catch(() => null);
      const groupsSent = Number(data?.sent || 0);
      const dmSent = Number(data?.dmSent || 0);
      if (groupsSent > 0 || dmSent > 0) {
        const parts: string[] = [];
        if (groupsSent > 0 && data.group) parts.push(`grupo ${data.group}`);
        if (dmSent > 0) parts.push(`${dmSent} pessoa${dmSent === 1 ? "" : "s"} do Administrativo`);
        setReturnMsg(`📨 Enviado pro WhatsApp (${parts.join(" + ")}). A mensagem fica no histórico da aba Conversas.`);
      } else if (data?.warning) {
        setReturnMsg(`⚠️ ${data.warning}`);
      } else if (data?.skipped) {
        setReturnMsg(`⚠️ ${data.skipped}`);
      } else {
        setReturnMsg("Não consegui enviar pro WhatsApp.");
      }
    } catch (err) {
      setReturnMsg(`Erro ao enviar: ${(err as Error).message}`);
    } finally {
      setSendingWhats(false);
    }
  }

  // Manda a lista de embarque (materiais + rancho, com as quantidades que a
  // equipe leva) pro grupo configurado em Mensagens › "Lista de embarque".
  async function handleSendEmbarkList() {
    if (!currentShip || !selectedTeam) return;
    setSendingEmbarkList(true);
    setEmbarkMsg(null);
    try {
      const res = await fetch("/api/embarque/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipName: currentShip.name,
          team: selectedTeam,
          // A unidade (un/kg/...) vai junto pra sair na mensagem do WhatsApp.
          materials: teamKit.map((k) => ({ name: k.estName, qty: k.need, unit: k.unit })),
          rancho: itemsWithStatus.map((i) => ({ name: i.name, qty: i.default_quantity, unit: i.unit || null })),
          sentBy: profile?.full_name || null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (data?.sent) {
        setEmbarkMsg(`📨 Lista enviada pro WhatsApp (${data.group}). Fica no histórico da aba Conversas.`);
      } else if (data?.warning) {
        setEmbarkMsg(`⚠️ ${data.warning}`);
      } else if (data?.skipped) {
        setEmbarkMsg(`⚠️ ${data.skipped}`);
      } else {
        setEmbarkMsg("Não consegui enviar a lista pro WhatsApp.");
      }
    } catch (err) {
      setEmbarkMsg(`Erro ao enviar: ${(err as Error).message}`);
    } finally {
      setSendingEmbarkList(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-2">
          <span className="text-4xl animate-bounce">📦</span>
          <span className="text-sm text-text-light animate-pulse">Carregando embarque...</span>
        </div>
      </div>
    );
  }

  if (ships.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-text">Embarque/Retorno 📦</h1>
        <div className="bg-card rounded-xl shadow-sm border border-border p-8 text-center text-text-light">
          <span className="text-4xl block mb-3">🚢</span>
          <p className="font-medium text-text mb-1">Nenhum navio agendado ou em operação</p>
          <p className="text-sm">Cadastre navios na aba <strong>Navios</strong> para preparar embarques.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-text">Embarque/Retorno 📦</h1>

      <ShipSelector
        ships={ships}
        selectedShip={selectedShip}
        onSelect={setSelectedShip}
      />

      {/* Abas: Embarque (preparar/baixar) x Retorno (conferir o que voltou) */}
      <div className="flex gap-1 border-b border-border">
        {([["embarque", "📦 Embarque"], ["retorno", "🛠️ Retorno"]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => { setTab(key); setReturnMsg(null); }}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === key ? "border-primary text-primary" : "border-transparent text-text-light hover:text-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* A equipe é a definida no cadastro do navio (aba Navios) — sem seletor. */}
      <div className="flex flex-wrap gap-2 items-center justify-between">
        {selectedTeam ? (
          <div className="flex gap-2 items-center">
            <span className="text-xs text-text-light font-semibold uppercase tracking-wider">Equipe:</span>
            <span
              className="text-sm font-semibold text-primary bg-primary/10 rounded-lg px-3 py-1.5"
              title="Equipe definida no cadastro do navio (aba Navios)"
            >
              {TEAM_LABELS[selectedTeam]}
            </span>
          </div>
        ) : (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            ⚠️ Este navio não tem equipe definida — edite o navio na aba <strong>Navios</strong> e escolha a equipe.
          </p>
        )}
        {tab === "embarque" && canEmbarcar && selectedTeam && (teamItems.length > 0 || teamKit.length > 0) && (
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="secondary" onClick={handleSendEmbarkList} disabled={sendingEmbarkList || embarking}>
              {sendingEmbarkList ? "Enviando..." : "📨 Enviar lista pro WhatsApp"}
            </Button>
            <Button size="sm" variant="warning" onClick={() => setConfirmEmbark(true)}>
              ⚓ Embarcar
            </Button>
          </div>
        )}
      </div>

      {tab === "embarque" && embarkMsg && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-sm text-blue-800">{embarkMsg}</div>
      )}

      {tab === "retorno" && selectedTeam && (
        <RetornoSection
          shipName={currentShip?.name || ""}
          team={selectedTeam}
          teamKit={teamKit}
          ranchoKit={ranchoReturnables}
          draft={returnDraft}
          setDraft={setDraft}
          notes={returnNotes}
          setNotes={setReturnNotes}
          onSave={handleSaveReturn}
          onSend={handleSendBroken}
          saving={savingReturn}
          sending={sendingWhats}
          canEdit={canEmbarcar}
          message={returnMsg}
          history={existingReturn ? [existingReturn] : []}
          editing={!!existingReturn}
        />
      )}

      {tab === "embarque" && selectedTeam && (<>
      {/* Materiais — baixados do Estoque (GALPAO) ao embarcar */}
      <section className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowMat((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-bold text-text uppercase tracking-wider hover:text-primary transition"
            title={showMat ? "Recolher a lista" : "Mostrar a lista"}
          >
            <span className={`inline-block transition-transform ${showMat ? "rotate-90" : ""}`}>▸</span>
            🧰 Materiais (do Estoque)
          </button>
          <span className="text-xs text-text-light">{matReady} ok · {matMissing} com falta · {teamKit.length} itens</span>
        </div>
        {showMat && (
        <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-border">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">Item</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Categoria</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Leva</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Em Estoque</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {teamKit.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-text-light">
                      <span className="text-3xl block mb-2">🧰</span>
                      Sem kit de materiais para esta equipe
                    </td>
                  </tr>
                ) : (
                  teamKit.map((k) => (
                    <tr key={k.id} className={`hover:bg-gray-50 ${!k.ready ? "bg-red-50/40" : ""}`}>
                      <td className="px-4 py-3 font-medium">{k.estName}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">{k.location}</span>
                      </td>
                      <td className="px-4 py-3 text-center text-text-light">{k.need}</td>
                      <td className={`px-4 py-3 text-center font-bold ${!k.ready ? "text-danger" : "text-success"}`}>{k.emEstoque}</td>
                      <td className="px-4 py-3 text-center">
                        {k.ready ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">✓ Ok</span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">Falta {k.falta}</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        )}
      </section>

      {/* Comida — baixada do Rancho (estoque por equipe) ao embarcar */}
      <section className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowRancho((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-bold text-text uppercase tracking-wider hover:text-primary transition"
            title={showRancho ? "Recolher a lista" : "Mostrar a lista"}
          >
            <span className={`inline-block transition-transform ${showRancho ? "rotate-90" : ""}`}>▸</span>
            🛒 Comida (Rancho)
          </button>
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${allReady ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>{pct}% pronto</span>
            <span className="text-xs text-text-light">{readyCount} prontos · {missingCount} com falta</span>
          </div>
        </div>
        {showRancho && (
        <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-border">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">Item</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Categoria</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Padrão</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Em Rancho</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {itemsWithStatus.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-text-light">
                      <span className="text-3xl block mb-2">🛒</span>
                      Nenhum item com quantidade padrão definida
                    </td>
                  </tr>
                ) : (
                  itemsWithStatus.map((item) => (
                    <tr key={item.id} className={`hover:bg-gray-50 ${!item.ready ? "bg-red-50/40" : ""}`}>
                      <td className="px-4 py-3 font-medium">{item.name}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                          {item.category === "CARNE" ? "Carne" : item.category === "FEIRA" ? "Feira" : "Suprimentos"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center text-text-light">{item.default_quantity}</td>
                      <td className={`px-4 py-3 text-center font-bold ${!item.ready ? "text-danger" : "text-success"}`}>
                        {item.quantity}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {item.ready ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">✓ Pronto</span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">Falta {item.falta}</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        )}
      </section>
      </>)}

      <ConfirmDialog
        open={confirmEmbark}
        onClose={() => setConfirmEmbark(false)}
        onConfirm={handleEmbarcar}
        title="Confirmar Embarque"
        message={`Embarcar ${selectedTeam ? TEAM_LABELS[selectedTeam] : "a equipe"} no navio "${currentShip?.name}"? Os materiais do kit serão baixados do Estoque e a comida do Rancho desta equipe.`}
        confirmLabel="⚓ Confirmar Embarque"
        variant="warning"
        loading={embarking}
      />
    </div>
  );
}

// ─── Retorno de material ────────────────────────────────────────────────────
// Conferência do que voltou do navio: por material do kit, quanto voltou bom e
// quanto quebrou. O bom credita o Estoque ao salvar; a lista de quebrados pode
// ir pro grupo do WhatsApp das solicitações.
interface ReturnKitRow { id: number; stock_item_id: number; estName: string; need: number; emEstoque: number; location: string }

function RetornoSection({
  shipName, team, teamKit, ranchoKit, draft, setDraft, notes, setNotes,
  onSave, onSend, saving, sending, canEdit, message, history, editing,
}: {
  shipName: string;
  team: string;
  teamKit: ReturnKitRow[];
  ranchoKit: ReturnKitRow[];
  draft: Record<number, ReturnDraft>;
  setDraft: (stockItemId: number, patch: Partial<ReturnDraft>) => void;
  notes: string;
  setNotes: (v: string) => void;
  onSave: () => void;
  onSend: () => void;
  saving: boolean;
  sending: boolean;
  canEdit: boolean;
  message: string | null;
  history: MaterialReturn[];
  editing: boolean;
}) {
  const numCls = "w-16 px-2 py-1 border border-border rounded text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary/40";
  // Listas recolhíveis: materiais e rancho.
  const [showMat, setShowMat] = useState(true);
  const [showRancho, setShowRancho] = useState(true);

  // Tabela de conferência (mesma mecânica pros materiais e pro rancho; muda só
  // o rótulo da perda: material "Quebrou", comida "Estragou").
  const renderKitTable = (
    kit: ReturnKitRow[],
    labels: { item: string; broken: string; obsPlaceholder: string; empty: string; emptyIcon: string },
  ) => (
    <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-border">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">{labels.item}</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase" title="Quanto a equipe leva (referência)">Foi</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Voltou</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">{labels.broken}</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">Obs.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {kit.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-text-light">
                  <span className="text-3xl block mb-2">{labels.emptyIcon}</span>
                  {labels.empty}
                </td>
              </tr>
            ) : (
              kit.map((k) => {
                const d = draft[k.stock_item_id] || { returned: "", broken: "", note: "" };
                return (
                  <tr key={k.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-medium">{k.estName}</td>
                    <td className="px-4 py-2.5 text-center text-text-light">{k.need}</td>
                    <td className="px-4 py-2.5 text-center">
                      <input type="number" min={0} step={1} value={d.returned} disabled={!canEdit}
                        onChange={(e) => setDraft(k.stock_item_id, { returned: e.target.value })}
                        className={numCls} placeholder="0" />
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <input type="number" min={0} step={1} value={d.broken} disabled={!canEdit}
                        onChange={(e) => setDraft(k.stock_item_id, { broken: e.target.value })}
                        className={`${numCls} ${(parseInt(d.broken) || 0) > 0 ? "border-red-300 text-red-700" : ""}`} placeholder="0" />
                    </td>
                    <td className="px-4 py-2.5">
                      <input type="text" value={d.note} disabled={!canEdit}
                        onChange={(e) => setDraft(k.stock_item_id, { note: e.target.value })}
                        placeholder={labels.obsPlaceholder}
                        className="w-full px-2 py-1 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-bold text-text uppercase tracking-wider">🛠️ Retorno de material — {TEAM_LABELS[team] || team}</h2>
          <span className="text-xs text-text-light">Bom volta pro estoque; quebrado é anotado e enviado.</span>
        </div>

        {editing && (
          <p className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
            ✏️ Este navio já tem um retorno confirmado — os campos mostram o que foi salvo.
            Ajuste o que precisar e confirme de novo: o Estoque é corrigido pela diferença.
          </p>
        )}

        {/* Materiais do kit (recolhível) */}
        <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => setShowMat((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-bold text-text uppercase tracking-wider hover:text-primary transition"
            title={showMat ? "Recolher a lista" : "Mostrar a lista"}
          >
            <span className={`inline-block transition-transform ${showMat ? "rotate-90" : ""}`}>▸</span>
            🧰 Materiais ({teamKit.length})
          </button>
        </div>
        {showMat && renderKitTable(teamKit, {
          item: "Material", broken: "Quebrou",
          obsPlaceholder: "Ex.: cabo partido, motor queimado...",
          empty: "Sem kit de materiais para esta equipe", emptyIcon: "🧰",
        })}

        {/* Comida do Rancho (recolhível) — o que volta bom credita o Rancho */}
        <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => setShowRancho((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-bold text-text uppercase tracking-wider hover:text-primary transition"
            title={showRancho ? "Recolher a lista" : "Mostrar a lista"}
          >
            <span className={`inline-block transition-transform ${showRancho ? "rotate-90" : ""}`}>▸</span>
            🛒 Comida (Rancho) ({ranchoKit.length})
          </button>
        </div>
        {showRancho && renderKitTable(ranchoKit, {
          item: "Item", broken: "Estragou",
          obsPlaceholder: "Ex.: estragou no calor, embalagem rasgada...",
          empty: "Nenhum item com quantidade padrão no Rancho desta equipe", emptyIcon: "🛒",
        })}

        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canEdit} rows={2}
          placeholder="Observações gerais do retorno (opcional)..."
          className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none" />

        {/* Feedback dos botões fica aqui embaixo, perto de onde se clica. */}
        {message && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-sm text-blue-800">{message}</div>
        )}

        {canEdit && (teamKit.length > 0 || ranchoKit.length > 0) && (
          <div className="flex flex-wrap gap-2 justify-end">
            <Button size="sm" variant="secondary" onClick={onSend} disabled={sending || saving}>
              {sending ? "Enviando..." : "📨 Enviar quebrados pro WhatsApp"}
            </Button>
            <Button size="sm" onClick={onSave} disabled={saving || sending}>
              {saving ? "Confirmando..." : "✅ Confirmar Retorno"}
            </Button>
          </div>
        )}
      </section>

      {/* Retorno confirmado deste navio/equipe (um só — editável acima) */}
      {history.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-text uppercase tracking-wider">📋 Retorno confirmado — {shipName}</h2>
          <div className="space-y-2">
            {history.map((r) => {
              const broken = (r.material_return_items || []).filter((it) => it.broken_qty > 0 || (it.note && it.returned_qty === 0));
              const returned = (r.material_return_items || []).filter((it) => it.returned_qty > 0);
              return (
                <div key={r.id} className="bg-card border border-border rounded-lg px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-medium">
                      {new Date(r.created_at).toLocaleDateString("pt-BR")} · {TEAM_LABELS[r.team] || r.team}
                    </span>
                    <span className="text-xs text-text-light">por {r.created_by}</span>
                  </div>
                  {returned.length > 0 && (
                    <p className="text-xs text-emerald-700 mt-1">
                      ✓ Voltou: {returned.map((it) => `${it.item_name} (${it.returned_qty})`).join(", ")}
                    </p>
                  )}
                  {broken.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {broken.map((it) => (
                        <li key={it.id} className="text-xs text-red-700">
                          🔧 {it.item_name}{it.broken_qty > 0 ? ` (${it.broken_qty})` : ""}{it.note ? ` — ${it.note}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {r.notes && <p className="text-xs text-text-light mt-1 italic">📝 {r.notes}</p>}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function ShipSelector({
  ships, selectedShip, onSelect,
}: {
  ships: Ship[];
  selectedShip: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const current = ships.find((s) => s.id === selectedShip);
  const filtered = ships.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.port || "").toLowerCase().includes(q);
  });

  function statusBadge(status: string) {
    return status === "AGENDADO"
      ? { cls: "bg-blue-100 text-blue-700", label: "Agendado", icon: "📅" }
      : status === "EM_OPERACAO"
        ? { cls: "bg-amber-100 text-amber-700", label: "Em Operação", icon: "⚓" }
        : { cls: "bg-gray-100 text-gray-700", label: status, icon: "🚢" };
  }

  return (
    <div ref={ref} className="relative">
      <label className="block text-xs font-semibold text-text-light uppercase tracking-wider mb-1.5">
        🚢 Navio
      </label>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full bg-card border border-border rounded-xl p-4 text-left hover:border-primary hover:shadow-md transition flex items-center gap-3 group"
      >
        {current ? (
          <>
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center text-2xl shrink-0">
              {statusBadge(current.status).icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-bold text-text text-base truncate">{current.name}</h3>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${statusBadge(current.status).cls}`}>
                  {statusBadge(current.status).label}
                </span>
              </div>
              <div className="flex flex-wrap gap-3 mt-1 text-xs text-text-light">
                {current.port && (
                  <span className="flex items-center gap-1">📍 {current.port}</span>
                )}
                {current.arrival_date && (
                  <span className="flex items-center gap-1">
                    🛬 <span className="text-text font-medium">{formatDate(current.arrival_date)}</span>
                  </span>
                )}
                {current.departure_date && (
                  <span className="flex items-center gap-1">
                    🛫 <span className="text-text font-medium">{formatDate(current.departure_date)}</span>
                  </span>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 text-text-light text-sm">Selecione um navio...</div>
        )}
        <svg className={`w-5 h-5 text-text-light transition shrink-0 ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-2 w-full bg-card border border-border rounded-xl shadow-xl overflow-hidden">
          <div className="p-2 border-b border-border bg-gray-50">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 Buscar navio ou porto..."
              autoFocus
              className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:ring-2 focus:ring-primary outline-none bg-white"
            />
          </div>
          <div className="max-h-80 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-text-light">
                Nenhum navio encontrado
              </div>
            ) : (
              filtered.map((s) => {
                const isCurrent = s.id === selectedShip;
                const sb = statusBadge(s.status);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => { onSelect(s.id); setOpen(false); setSearch(""); }}
                    className={`w-full text-left px-3 py-3 hover:bg-blue-50 transition flex items-center gap-3 border-b border-border last:border-0 ${
                      isCurrent ? "bg-primary/5" : ""
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl shrink-0 ${
                      isCurrent ? "bg-primary text-white" : "bg-gray-100"
                    }`}>
                      {sb.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm truncate">{s.name}</p>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase ${sb.cls}`}>
                          {sb.label}
                        </span>
                        {isCurrent && (
                          <span className="text-[10px] text-primary font-bold">✓ Selecionado</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 mt-0.5 text-[11px] text-text-light">
                        {s.port && <span>📍 {s.port}</span>}
                        {s.arrival_date && <span>🛬 {formatDate(s.arrival_date)}</span>}
                        {s.departure_date && <span>🛫 {formatDate(s.departure_date)}</span>}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <div className="px-3 py-2 bg-gray-50 border-t border-border text-[10px] text-text-light text-center">
            {ships.length} navio(s) disponível(eis) (Agendado / Em Operação)
          </div>
        </div>
      )}
    </div>
  );
}
