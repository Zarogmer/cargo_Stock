"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatDate, matchSearch, formatQty, unitSuffix } from "@/lib/utils";
import type { StockItem } from "@/types/database";

interface Ship {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  port: string | null;
  status: string;
  assigned_team: string | null;
  cargo_type: string | null; // produto/carga — sai no "Produto" do Check List
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
  // AVARIADO: voltou quebrado/estragado (a equipe trouxe) — não custa ao navio.
  broken_qty: number;
  // PERDIDO: não voltou — vira despesa do navio, dividida pela equipe.
  lost_qty: number;
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

// Rascunho por material na tela de Retorno (voltou / avariado / perdido / obs).
interface ReturnDraft { returned: string; broken: string; lost: string; note: string }

// Ajuste da lista POR NAVIO (embark_list_overrides): muda quanto vai de um item
// do kit/rancho só neste navio, ou adiciona um item extra do Estoque/Rancho.
interface ListOverride {
  id: number;
  ship_id: string;
  team: string;
  kind: "MATERIAL" | "RANCHO";
  stock_item_id: number;
  quantity: number;
}

// EQUIPE_4 = "Equipe Turbo" (mesma chave do Rancho; EQUIPE_3 segue como legado).
const TEAM_LABELS: Record<string, string> = {
  EQUIPE_1: "Equipe 1", EQUIPE_2: "Equipe 2", EQUIPE_3: "Equipe 3", EQUIPE_4: "Equipe Turbo",
};

// Setores do inventário que contam como "material" (tudo que não é Rancho).
// Sentinelas de stock_items.team — ver materiais-panel.tsx.
const MATERIAL_TEAMS = new Set(["GALPAO", "FERRAMENTA", "ELETRICA", "FLUIDOS", "MAQUINARIO"]);
const MATERIAL_TEAM_LABEL: Record<string, string> = {
  GALPAO: "Estoque", FERRAMENTA: "Ferramenta", ELETRICA: "Elétrica", FLUIDOS: "Fluídos", MAQUINARIO: "Maquinário",
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
  const [overrides, setOverrides] = useState<ListOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmbark, setConfirmEmbark] = useState(false);
  const [embarking, setEmbarking] = useState(false);

  // Edição do "Leva"/"Padrão" por navio: rascunho do input por stock_item_id
  // (grava no blur) e modal de "Adicionar item" (materiais ou rancho).
  const [qtyDraft, setQtyDraft] = useState<Record<number, string>>({});
  const [addKind, setAddKind] = useState<"MATERIAL" | "RANCHO" | null>(null);

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
  // Download da lista (Check List) em PDF/Excel — compartilhado pelas duas abas.
  const [downloading, setDownloading] = useState<"pdf" | "xlsx" | null>(null);
  // Listas recolhíveis da aba Embarque (Retorno tem as suas no RetornoSection).
  const [showMat, setShowMat] = useState(true);
  const [showRancho, setShowRancho] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [shipsRes, stockRes, kitRes, retRes, ovrRes] = await Promise.all([
        db.from("ships").select("*").in("status", ["AGENDADO", "EM_OPERACAO"]).order("arrival_date"),
        db.from("stock_items").select("*").order("name"),
        db.from("embark_kit_items").select("*, stock_items(id, name, quantity, location, unit)"),
        db.from("material_returns").select("*, material_return_items(id, return_id, stock_item_id, item_name, went_qty, returned_qty, broken_qty, lost_qty, note)").order("created_at", { ascending: false }),
        db.from("embark_list_overrides").select("*"),
      ]);
      setShips((shipsRes.data as Ship[]) || []);
      setStockItems(stockRes.data || []);
      setKitItems((kitRes.data as KitItem[]) || []);
      setReturns((retRes.data as MaterialReturn[]) || []);
      setOverrides((ovrRes.data as ListOverride[]) || []);
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
    : null) as "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3" | "EQUIPE_4" | null;

  // Ajustes deste navio (e desta equipe — trocando a equipe do navio, os
  // ajustes antigos ficam dormentes). Chave: stock_item_id.
  const overrideByItem = new Map(
    overrides
      .filter((o) => o.ship_id === selectedShip && o.team === selectedTeam)
      .map((o) => [o.stock_item_id, o]),
  );

  // Comida do Rancho da equipe: padrão do cadastro, com ajuste por navio e
  // itens extras adicionados na tela (padrão 0 + ajuste > 0). Ajuste igual ao
  // padrão nem chega a existir (saveOverride remove), então `overridden` de
  // fato significa "diferente do padrão".
  const itemsWithStatus = stockItems
    .filter((i) => (i as any).team === selectedTeam)
    .map((item) => {
      const ovr = overrideByItem.get(item.id);
      const baseDef = (item as any).default_quantity || 0;
      const def = ovr ? ovr.quantity : baseDef;
      const current = item.quantity;
      return {
        ...item,
        default_quantity: def,
        base_default: baseDef,
        overridden: !!ovr && baseDef > 0,
        added: !!ovr && baseDef <= 0,
        falta: Math.max(0, def - current),
        ready: current >= def,
      };
    })
    .filter((i) => i.default_quantity > 0 || i.overridden || i.added);

  const totalDefault = itemsWithStatus.reduce((s, i) => s + i.default_quantity, 0);
  const totalCurrent = itemsWithStatus.reduce((s, i) => s + Math.min(i.quantity, i.default_quantity), 0);
  const pct = totalDefault > 0 ? Math.round((totalCurrent / totalDefault) * 100) : 0;
  const allReady = totalCurrent >= totalDefault && totalDefault > 0;

  const readyCount = itemsWithStatus.filter((i) => i.ready).length;
  const missingCount = itemsWithStatus.filter((i) => !i.ready).length;
  // Nomes do que está faltando no Rancho — entram no aviso que trava o Embarcar.
  const ranchoMissingNames = itemsWithStatus.filter((i) => !i.ready).map((i) => i.name);

  // Materiais do kit de embarque desta equipe (deduzidos do Estoque/GALPAO),
  // com o "Leva" ajustado por navio + itens extras puxados do Estoque.
  const kitStockIds = new Set(kitItems.filter((k) => k.team === selectedTeam).map((k) => k.stock_item_id));
  const kitRows = kitItems
    .filter((k) => k.team === selectedTeam)
    .map((k) => {
      const ovr = overrideByItem.get(k.stock_item_id);
      const estName = k.stock_items?.name || `#${k.stock_item_id}`;
      const emEstoque = k.stock_items?.quantity ?? 0;
      const need = ovr ? ovr.quantity : k.quantity;
      return {
        id: k.id,
        stock_item_id: k.stock_item_id,
        estName,
        emEstoque,
        need,
        baseNeed: k.quantity,
        overridden: !!ovr,
        added: false,
        ready: emEstoque >= need,
        falta: Math.max(0, need - emEstoque),
        location: k.stock_items?.location || "—",
        unit: k.stock_items?.unit || null,
      };
    });
  // Extras: ajustes MATERIAL de itens fora do kit — o item vem do Estoque.
  const extraRows = [...overrideByItem.values()]
    .filter((o) => o.kind === "MATERIAL" && !kitStockIds.has(o.stock_item_id))
    .map((o) => {
      const si = stockItems.find((s) => s.id === o.stock_item_id);
      if (!si) return null;
      return {
        id: -o.id, // id negativo: não colide com id de kit (React key)
        stock_item_id: o.stock_item_id,
        estName: si.name,
        emEstoque: si.quantity,
        need: o.quantity,
        baseNeed: 0,
        overridden: false,
        added: true,
        ready: si.quantity >= o.quantity,
        falta: Math.max(0, o.quantity - si.quantity),
        location: si.location || MATERIAL_TEAM_LABEL[(si as any).team] || "—",
        unit: si.unit || null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const teamKit = [...kitRows, ...extraRows].sort((a, b) => a.estName.localeCompare(b.estName, "pt-BR"));
  const matReady = teamKit.filter((k) => k.ready).length;
  const matMissing = teamKit.length - matReady;

  // ── Trava do Embarcar ────────────────────────────────────────────────────
  // Faltou qualquer coisa (material ou rancho), não embarca. Antes o Embarcar
  // baixava só o que tinha e seguia em frente — a equipe ia pro navio sem o
  // item e o Estoque ficava dizendo que estava tudo certo. Embarque é controle:
  // ou a lista está completa, ou se ajusta o "Leva" deste navio / repõe o
  // Estoque antes. Bloqueia na tela E no handleEmbarcar (defesa dupla).
  const missingNames = [
    ...teamKit.filter((k) => !k.ready).map((k) => k.estName),
    ...ranchoMissingNames,
  ];
  const hasMissing = missingNames.length > 0;
  const missingSummary = missingNames.slice(0, 6).join(", ")
    + (missingNames.length > 6 ? ` e mais ${missingNames.length - 6}` : "");

  // Candidatos do modal "Adicionar item": tudo que está no Estoque (materiais)
  // ou no Rancho da equipe e ainda não aparece na lista deste navio.
  const listedIds = new Set([...teamKit.map((k) => k.stock_item_id), ...itemsWithStatus.map((i) => i.id)]);
  const addCandidates = addKind === "MATERIAL"
    ? stockItems.filter((i) => MATERIAL_TEAMS.has(String((i as any).team)) && !listedIds.has(i.id))
    : addKind === "RANCHO"
      ? stockItems.filter((i) => (i as any).team === selectedTeam && !listedIds.has(i.id))
      : [];

  // Comida do Rancho também entra na conferência de retorno — mesma mecânica
  // dos materiais (rascunho por stock_item_id; Rancho e materiais são todos
  // stock_items, então os ids não colidem). O que volta bom credita o Rancho.
  //
  // Aqui o Rancho vem COMPLETO (todo alimento cadastrado na equipe), não só o
  // que a lista deste navio mandou levar: na volta a conferência precisa poder
  // registrar qualquer item — inclusive o que foi parar a bordo sem estar na
  // lista. "Foi" mostra o que a lista mandou (0 quando não estava nela).
  const ranchoNeedById = new Map(itemsWithStatus.map((i) => [i.id, i.default_quantity]));
  const ranchoReturnables = stockItems
    .filter((i) => (i as any).team === selectedTeam)
    .map((i) => ({
      id: i.id,
      stock_item_id: i.id,
      estName: i.name,
      need: ranchoNeedById.get(i.id) ?? 0,
      emEstoque: i.quantity,
      location: "Rancho",
      unit: i.unit || null,
    }))
    .sort((a, b) => a.estName.localeCompare(b.estName, "pt-BR"));

  // Dados comuns da lista (navio + itens) usados no envio pro WhatsApp e na
  // geração do Check List em PDF/Excel. Item com leva 0 (zerado só neste
  // navio) fica fora do documento/mensagem.
  function buildListPayload() {
    return {
      shipName: currentShip?.name || "",
      team: selectedTeam,
      teamLabel: selectedTeam ? TEAM_LABELS[selectedTeam] : null,
      port: currentShip?.port || null,
      cargoType: currentShip?.cargo_type || null,
      dateIso: new Date().toISOString().split("T")[0],
      // A unidade (un/kg/...) vai junto pra sair na mensagem e no documento.
      materials: teamKit.filter((k) => k.need > 0).map((k) => ({ name: k.estName, qty: k.need, unit: k.unit })),
      rancho: itemsWithStatus.filter((i) => i.default_quantity > 0).map((i) => ({ name: i.name, qty: i.default_quantity, unit: i.unit || null })),
    };
  }

  // ── Ajuste da lista por navio ─────────────────────────────────────────────
  // Grava o "leva" de um item SÓ neste navio (embark_list_overrides). Igual ao
  // padrão → remove o ajuste (volta ao kit oficial); item extra zerado some da
  // lista. Atualiza o estado local direto, sem recarregar a tela toda.
  async function saveOverride(kind: "MATERIAL" | "RANCHO", stockItemId: number, qty: number, baseQty: number) {
    if (!currentShip || !selectedTeam) return;
    // O único ajuste possível pro par navio+item (unique no banco) — pode ser
    // de outra equipe (navio trocou de equipe): aí é atualizado e "adotado".
    const existing = overrides.find((o) => o.ship_id === selectedShip && o.stock_item_id === stockItemId);
    try {
      if (qty === baseQty) {
        if (!existing) return;
        const res = await db.from("embark_list_overrides").delete().eq("id", existing.id);
        if (res.error) throw new Error(res.error.message);
        setOverrides((prev) => prev.filter((o) => o.id !== existing.id));
      } else if (existing) {
        if (existing.quantity === qty && existing.team === selectedTeam && existing.kind === kind) return;
        const res = await db.from("embark_list_overrides").update({ quantity: qty, team: selectedTeam, kind }).eq("id", existing.id);
        if (res.error) throw new Error(res.error.message);
        setOverrides((prev) => prev.map((o) => (o.id === existing.id ? { ...o, quantity: qty, team: selectedTeam, kind } : o)));
      } else {
        const res: any = await db.from("embark_list_overrides").insert({
          ship_id: selectedShip,
          team: selectedTeam,
          kind,
          stock_item_id: stockItemId,
          quantity: qty,
        });
        if (res.error) throw new Error(res.error.message);
        const created = Array.isArray(res.data) ? res.data[0] : res.data;
        if (created?.id) setOverrides((prev) => [...prev, created as ListOverride]);
        else loadData();
      }
    } catch (err) {
      setEmbarkMsg(`Erro ao salvar o ajuste da lista: ${(err as Error).message}`);
    }
  }

  // Blur do input "Leva"/"Padrão": aplica o rascunho digitado. Valor inválido
  // ou vazio só descarta o rascunho (o input volta pro valor atual).
  function commitQty(kind: "MATERIAL" | "RANCHO", stockItemId: number, baseQty: number) {
    const raw = qtyDraft[stockItemId];
    if (raw == null) return;
    setQtyDraft((d) => {
      const nd = { ...d };
      delete nd[stockItemId];
      return nd;
    });
    const parsed = parseFloat(raw.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed < 0) return;
    void saveOverride(kind, stockItemId, parsed, baseQty);
  }

  // Baixa a lista no layout do Check List: Embarque = preenchida (navio, porto,
  // equipe, produto, data); Retorno = só a lista, cabeçalho em branco.
  async function handleDownloadChecklist(mode: "embarque" | "retorno", format: "pdf" | "xlsx") {
    if (!currentShip || !selectedTeam) return;
    const setMsg = mode === "embarque" ? setEmbarkMsg : setReturnMsg;
    setDownloading(format);
    setMsg(null);
    try {
      const res = await fetch(`/api/embarque/checklist?format=${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...buildListPayload(), mode }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      // Nome do arquivo vem do Content-Disposition (filename*=UTF-8''...).
      const cd = res.headers.get("Content-Disposition") || "";
      const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const plain = /filename="([^"]+)"/i.exec(cd);
      const fallback = `Lista de Materiais - ${currentShip.name}.${format}`;
      const filename = star ? decodeURIComponent(star[1]) : plain?.[1] || fallback;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMsg(`Erro ao gerar o ${format === "pdf" ? "PDF" : "Excel"}: ${(err as Error).message}`);
    } finally {
      setDownloading(null);
    }
  }

  async function handleEmbarcar() {
    if (!currentShip || !selectedTeam) return;
    // Trava de controle: com item faltando, não baixa nada. Vale mesmo se o
    // botão for burlado (estado antigo, clique duplo) — a baixa parcial é o
    // que deixava o Estoque mentindo.
    if (hasMissing) {
      setConfirmEmbark(false);
      setEmbarkMsg(
        `🚫 Não dá pra embarcar: ${missingNames.length} item(ns) sem quantidade no Estoque — ${missingSummary}. ` +
          `Reponha o Estoque ou ajuste o "Leva" deste navio antes de embarcar.`,
      );
      return;
    }
    setEmbarking(true);
    const actor = profile?.full_name || "Sistema";

    for (const item of itemsWithStatus) {
      if (item.quantity <= 0) continue;
      const toConsume = Math.min(item.quantity, item.default_quantity);
      if (toConsume <= 0) continue; // leva zerada só neste navio
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

    // Aviso automático no grupo do WhatsApp (com a lista preenchida em PDF).
    // Best-effort: o embarque já aconteceu — falha aqui só vira aviso na tela.
    setEmbarkMsg("⚓ Embarque confirmado! Enviando aviso pro WhatsApp...");
    try {
      const res = await fetch("/api/embarque/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildListPayload(),
          sentBy: actor,
          event: "embarque",
          attachPdf: true,
        }),
      });
      const data = await res.json().catch(() => null);
      const groupsSent = Number(data?.sent || 0);
      const dmSent = Number(data?.dmSent || 0);
      if (groupsSent > 0 || dmSent > 0) {
        const parts: string[] = [];
        if (groupsSent > 0 && data.group) parts.push(`grupo ${data.group}`);
        if (dmSent > 0) parts.push(`${dmSent} pessoa${dmSent === 1 ? "" : "s"} do Administrativo`);
        const pdfNote = data?.pdf === "sent" ? " com a lista em PDF" : data?.pdf === "failed" ? " (PDF não gerado — foi só o texto)" : "";
        setEmbarkMsg(`⚓ Embarque confirmado! 📨 Aviso enviado pro WhatsApp (${parts.join(" + ")})${pdfNote}.`);
      } else if (data?.skipped || data?.warning) {
        setEmbarkMsg(`⚓ Embarque confirmado! ⚠️ ${data.skipped || data.warning}`);
      } else {
        setEmbarkMsg("⚓ Embarque confirmado! Não consegui avisar no WhatsApp.");
      }
    } catch (err) {
      setEmbarkMsg(`⚓ Embarque confirmado! Erro ao avisar no WhatsApp: ${(err as Error).message}`);
    }
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
        lost: (it.lost_qty || 0) > 0 ? String(it.lost_qty) : "",
        note: it.note || "",
      };
    }
    setReturnDraft(draft);
    setReturnNotes(existingReturn.notes || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingReturn?.id, returns, selectedShip, selectedTeam]);

  function setDraft(stockItemId: number, patch: Partial<ReturnDraft>) {
    setReturnDraft((prev) => {
      const base: ReturnDraft = prev[stockItemId] ?? { returned: "", broken: "", lost: "", note: "" };
      return { ...prev, [stockItemId]: { ...base, ...patch } };
    });
  }

  // Linhas do retorno preenchidas (voltou/avariado/perdido/obs). Usadas pra
  // salvar e pros avisos. Materiais do kit + comida do Rancho.
  function buildReturnRows() {
    return [...teamKit, ...ranchoReturnables]
      .map((k) => {
        const d = returnDraft[k.stock_item_id] || { returned: "", broken: "", lost: "", note: "" };
        const returned = Math.max(0, Math.floor(parseFloat(d.returned) || 0));
        const broken = Math.max(0, Math.floor(parseFloat(d.broken) || 0));
        const lost = Math.max(0, Math.floor(parseFloat(d.lost) || 0));
        const note = d.note.trim();
        return { k, returned, broken, lost, note };
      })
      .filter((r) => r.returned > 0 || r.broken > 0 || r.lost > 0 || r.note);
  }

  // Ocorrências do retorno (avariado + perdido) pro aviso no WhatsApp. A API
  // recebe tudo em `brokenItems`; a etiqueta na observação separa os dois —
  // avariado a equipe trouxe de volta, perdido virou custo do navio.
  function buildIncidentItems(rows: ReturnType<typeof buildReturnRows>) {
    const out: Array<{ name: string; qty: number; unit: string | null; note: string | null }> = [];
    for (const r of rows) {
      const unit = r.k.unit ?? null;
      if (r.broken > 0) {
        out.push({ name: r.k.estName, qty: r.broken, unit, note: r.note ? `avariado — ${r.note}` : "avariado" });
      }
      if (r.lost > 0) {
        out.push({ name: r.k.estName, qty: r.lost, unit, note: r.note ? `PERDIDO — ${r.note}` : "PERDIDO" });
      }
      // Observação solta (sem avaria/perda e sem nada de volta) segue valendo
      // como ocorrência — é o jeito de registrar um caso sem quantidade.
      if (r.broken === 0 && r.lost === 0 && r.returned === 0 && r.note) {
        out.push({ name: r.k.estName, qty: 0, unit, note: r.note });
      }
    }
    return out;
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
      // Quanto cada material já tinha creditado/quebrado no retorno salvo — ao
      // editar, o Estoque é ajustado só pela DIFERENÇA (não conta duas vezes).
      const oldReturned = new Map<number, number>();
      const oldBroken = new Map<number, number>();
      const oldLost = new Map<number, number>();
      for (const it of existingReturn?.material_return_items || []) {
        if (it.stock_item_id == null) continue;
        oldReturned.set(it.stock_item_id, it.returned_qty);
        oldBroken.set(it.stock_item_id, it.broken_qty);
        oldLost.set(it.stock_item_id, it.lost_qty || 0);
      }

      // Itens cuja baixa de embarque deste navio/equipe JÁ aconteceu: a quebra
      // deles já está fora do Estoque (o Embarcar baixa tudo; o Retorno credita
      // só o que voltou bom), então vira apenas um movimento informativo
      // (AJUSTE) no histórico. Item sem baixa de embarque (navio que não passou
      // pelo "Embarcar") tem a quebra BAIXADA do Estoque aqui.
      const embarkTag = `${currentShip.name} (${selectedTeam})`;
      const allIds = [...new Set([
        ...buildReturnRows().map((r) => r.k.stock_item_id),
        ...oldReturned.keys(),
      ])];
      const embarkedIds = new Set<number>();
      if (allIds.length > 0) {
        const movRes: any = await db.from("stock_movements").select("stock_item_id, notes").in("stock_item_id", allIds);
        for (const m of (movRes.data as Array<{ stock_item_id: number; notes: string | null }>) || []) {
          if ((m.notes || "").startsWith("Embarque") && (m.notes || "").includes(embarkTag)) {
            embarkedIds.add(m.stock_item_id);
          }
        }
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
          lost_qty: r.lost,
          note: r.note || null,
        });
        const itemId = r.k.stock_item_id;
        const returnedDelta = r.returned - (oldReturned.get(itemId) || 0);
        const brokenDelta = r.broken - (oldBroken.get(itemId) || 0);
        const lostDelta = r.lost - (oldLost.get(itemId) || 0);
        oldReturned.delete(itemId);
        oldBroken.delete(itemId);
        oldLost.delete(itemId);
        const embarked = embarkedIds.has(itemId);

        // O que voltou em bom estado credita o Estoque pela diferença contra o
        // salvo (ENTRADA se aumentou, BAIXA se diminuiu).
        if (returnedDelta !== 0) {
          await db.from("stock_movements").insert({
            stock_item_id: itemId,
            movement_type: returnedDelta > 0 ? "ENTRADA" : "BAIXA",
            quantity: Math.abs(returnedDelta),
            movement_date: today,
            notes: `Retorno${existingReturn ? " (ajuste)" : ""}: ${currentShip.name} (${selectedTeam}) — voltou em bom estado`,
            created_by: actor,
          } as any);
        }

        // Avariado e Perdido saem do Estoque do mesmo jeito — nenhum dos dois
        // volta pra prateleira (o avariado voltou fisicamente, mas quebrado).
        // Com baixa de embarque, a saída já aconteceu lá: fica só o registro
        // (AJUSTE) pro histórico contar a história; sem embarque, baixa aqui.
        // O que separa os dois é o dinheiro: só o PERDIDO vira despesa do
        // navio (ver /api/retorno/despesa).
        const registerLoss = async (delta: number, label: string) => {
          if (delta === 0) return;
          if (embarked) {
            if (delta > 0) {
              await db.from("stock_movements").insert({
                stock_item_id: itemId,
                movement_type: "AJUSTE",
                quantity: delta,
                movement_date: today,
                notes: `${label}: ${currentShip.name} (${selectedTeam}) — a baixa já foi no embarque`,
                created_by: actor,
              } as any);
            }
          } else {
            await db.from("stock_movements").insert({
              stock_item_id: itemId,
              movement_type: delta > 0 ? "BAIXA" : "ENTRADA",
              quantity: Math.abs(delta),
              movement_date: today,
              notes: `${label}${existingReturn ? " (ajuste)" : ""}: ${currentShip.name} (${selectedTeam})`,
              created_by: actor,
            } as any);
          }
        };
        await registerLoss(brokenDelta, "Avaria");
        await registerLoss(lostDelta, "Perda");

        // Efeito líquido no estoque: crédito do que voltou bom − o que avariou
        // e o que sumiu (quando o embarque ainda não tinha descontado).
        const stockDelta = returnedDelta - (embarked ? 0 : brokenDelta + lostDelta);
        if (stockDelta !== 0) {
          await db.from("stock_items").update({
            quantity: Math.max(0, r.k.emEstoque + stockDelta),
            updated_by: actor,
          } as any).eq("id", itemId);
        }
      }

      // Itens que saíram da edição (zerados): estorna o crédito do "voltou" e a
      // baixa de avaria/perda (esta só quando tinha sido baixada aqui, sem embarque).
      const leftoverIds = new Set([...oldReturned.keys(), ...oldBroken.keys(), ...oldLost.keys()]);
      for (const stockItemId of leftoverIds) {
        const retQty = oldReturned.get(stockItemId) || 0;
        const brokeQty = embarkedIds.has(stockItemId)
          ? 0
          : (oldBroken.get(stockItemId) || 0) + (oldLost.get(stockItemId) || 0);
        const delta = brokeQty - retQty; // devolve avaria/perda, tira o crédito
        if (delta === 0) continue;
        const current = stockItems.find((i) => i.id === stockItemId)?.quantity ?? 0;
        await db.from("stock_movements").insert({
          stock_item_id: stockItemId,
          movement_type: delta > 0 ? "ENTRADA" : "BAIXA",
          quantity: Math.abs(delta),
          movement_date: today,
          notes: `Retorno (ajuste): ${currentShip.name} (${selectedTeam}) — item removido da conferência`,
          created_by: actor,
        } as any);
        await db.from("stock_items").update({
          quantity: Math.max(0, current + delta),
          updated_by: actor,
        } as any).eq("id", stockItemId);
      }

      const baseMsg = existingReturn
        ? "✅ Retorno atualizado. O Estoque foi ajustado pela diferença."
        : "✅ Retorno confirmado. O que voltou bom foi creditado no Estoque.";

      // Aviso automático no WhatsApp com o resumo do retorno (voltou + quebrou).
      // Best-effort: o retorno já está salvo — falha aqui só vira nota na tela.
      let autoNote = "";
      try {
        const res = await fetch("/api/retorno/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shipName: currentShip.name,
            team: selectedTeam,
            event: "resumo",
            returnedItems: rows
              .filter((r) => r.returned > 0)
              .map((r) => ({ name: r.k.estName, qty: r.returned, unit: r.k.unit ?? null })),
            brokenItems: buildIncidentItems(rows),
            notes: returnNotes.trim() || null,
            checkedBy: profile?.full_name || null,
          }),
        });
        const data = await res.json().catch(() => null);
        if (Number(data?.sent || 0) > 0 || Number(data?.dmSent || 0) > 0) {
          autoNote = " 📨 Resumo enviado no WhatsApp.";
        } else if (data?.skipped || data?.warning) {
          autoNote = ` ⚠️ ${data.skipped || data.warning}`;
        }
      } catch {
        autoNote = " ⚠️ Não consegui enviar o resumo no WhatsApp.";
      }

      // O prejuízo dos quebrados vira despesa "Material danificado" no
      // Pagamento de Navios. Calculado no servidor (unit_value é coluna
      // sensível que o /api/db esconde de quem não é gestão). Best-effort:
      // o retorno já está salvo; falha aqui só vira nota na tela.
      try {
        const res = await fetch("/api/retorno/despesa", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ship_id: selectedShip, team: selectedTeam }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && Number(data?.amount) > 0) {
          const brl = Number(data.amount).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
          const perHead = Number(data?.perPerson) > 0
            ? ` (${Number(data.perPerson).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} por pessoa da equipe)`
            : "";
          autoNote += ` 🪙 Despesa "Material perdido" de ${brl} lançada no navio${perHead}.`;
        } else if (res.ok && data?.removed) {
          autoNote += " 🪙 Despesa de material perdido do navio foi zerada.";
        } else if (!res.ok) {
          autoNote += " ⚠️ Não consegui lançar a despesa de material perdido no navio.";
        }
      } catch {
        autoNote += " ⚠️ Não consegui lançar a despesa de material perdido no navio.";
      }

      setReturnMsg(baseMsg + autoNote);
      loadData();
    } catch (err) {
      setReturnMsg(`Erro ao salvar retorno: ${(err as Error).message}`);
    } finally {
      setSavingReturn(false);
    }
  }

  async function handleSendBroken() {
    if (!currentShip || !selectedTeam) return;
    let brokenItems = buildIncidentItems(buildReturnRows());
    let notesToSend = returnNotes.trim() || null;
    // Tabela zerada (ex.: acabou de salvar o retorno, que limpa o rascunho):
    // manda as ocorrências do ÚLTIMO retorno salvo deste navio/equipe — é o
    // fluxo natural de "salvar e depois enviar".
    if (brokenItems.length === 0) {
      const last = shipReturns.find((r) => r.team === selectedTeam);
      const lastRows = (last?.material_return_items || [])
        .filter((it) => it.broken_qty > 0 || (it.lost_qty || 0) > 0 || (it.note && it.returned_qty === 0));
      if (lastRows.length > 0) {
        // Unidade não fica gravada no retorno — busca no cadastro do material.
        const unitOf = (id: number | null) => stockItems.find((s) => s.id === id)?.unit || null;
        brokenItems = lastRows.flatMap((it) => {
          const out: Array<{ name: string; qty: number; unit: string | null; note: string | null }> = [];
          if (it.broken_qty > 0) {
            out.push({ name: it.item_name, qty: it.broken_qty, unit: unitOf(it.stock_item_id), note: it.note ? `avariado — ${it.note}` : "avariado" });
          }
          if ((it.lost_qty || 0) > 0) {
            out.push({ name: it.item_name, qty: it.lost_qty, unit: unitOf(it.stock_item_id), note: it.note ? `PERDIDO — ${it.note}` : "PERDIDO" });
          }
          if (it.broken_qty === 0 && (it.lost_qty || 0) === 0 && it.note) {
            out.push({ name: it.item_name, qty: 0, unit: unitOf(it.stock_item_id), note: it.note });
          }
          return out;
        });
        notesToSend = last!.notes;
      }
    }
    if (brokenItems.length === 0) {
      setReturnMsg("Nada de avariado ou perdido pra enviar — preencha as colunas Avariado/Perdido (ou uma observação), ou salve um retorno com ocorrências.");
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
  // equipe leva) pro grupo configurado em Mensagens › "Lista de embarque" —
  // texto + a lista preenchida em PDF (layout do Check List) anexada.
  async function handleSendEmbarkList() {
    if (!currentShip || !selectedTeam) return;
    setSendingEmbarkList(true);
    setEmbarkMsg(null);
    try {
      const res = await fetch("/api/embarque/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildListPayload(),
          sentBy: profile?.full_name || null,
          attachPdf: true,
        }),
      });
      const data = await res.json().catch(() => null);
      const groupsSent = Number(data?.sent || 0);
      const dmSent = Number(data?.dmSent || 0);
      if (groupsSent > 0 || dmSent > 0) {
        const parts: string[] = [];
        if (groupsSent > 0 && data.group) parts.push(`grupo ${data.group}`);
        if (dmSent > 0) parts.push(`${dmSent} pessoa${dmSent === 1 ? "" : "s"} do Administrativo`);
        const pdfNote = data?.pdf === "sent" ? " com PDF" : data?.pdf === "failed" ? " (PDF não gerado — foi só o texto)" : "";
        setEmbarkMsg(`📨 Lista enviada pro WhatsApp (${parts.join(" + ")})${pdfNote}. Fica no histórico da aba Conversas.`);
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
        {tab === "embarque" && canEmbarcar && selectedTeam && (itemsWithStatus.length > 0 || teamKit.length > 0) && (
          <div className="flex gap-2 flex-wrap">
            {/* Check List preenchido (navio/porto/equipe/produto/data + quantidades) */}
            <Button size="sm" variant="secondary" onClick={() => handleDownloadChecklist("embarque", "pdf")} disabled={downloading !== null || embarking} title="Baixar a lista preenchida em PDF (layout do Check List)">
              {downloading === "pdf" ? "Gerando..." : "📄 PDF"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => handleDownloadChecklist("embarque", "xlsx")} disabled={downloading !== null || embarking} title="Baixar a lista preenchida em Excel pra editar">
              {downloading === "xlsx" ? "Gerando..." : "📊 Excel"}
            </Button>
            <Button size="sm" variant="secondary" onClick={handleSendEmbarkList} disabled={sendingEmbarkList || embarking} title="Manda a lista no grupo do WhatsApp com o PDF anexado">
              {sendingEmbarkList ? "Enviando..." : "📨 Enviar lista pro WhatsApp"}
            </Button>
            {/* Com item faltando o Embarcar fica travado: embarque é controle,
                não dá pra "tirar do estoque" o que não tem. */}
            <Button
              size="sm"
              variant="warning"
              onClick={() => setConfirmEmbark(true)}
              disabled={hasMissing}
              title={
                hasMissing
                  ? `Faltam ${missingNames.length} item(ns) no Estoque: ${missingSummary}`
                  : "Baixa o kit e o rancho do Estoque e avisa o grupo no WhatsApp"
              }
            >
              ⚓ Embarcar
            </Button>
          </div>
        )}
      </div>

      {tab === "embarque" && embarkMsg && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-sm text-blue-800">{embarkMsg}</div>
      )}

      {/* Aviso fixo enquanto faltar item: explica por que o Embarcar está
          travado e o que fazer, sem obrigar a caçar as linhas vermelhas. */}
      {tab === "embarque" && canEmbarcar && selectedTeam && hasMissing && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
          <p className="font-semibold">🚫 Embarque bloqueado — {missingNames.length} item(ns) sem quantidade no Estoque</p>
          <p className="mt-1 text-xs">{missingSummary}</p>
          <p className="mt-1.5 text-xs text-red-700">
            Reponha o Estoque ou ajuste o <strong>Leva</strong> deste navio (pode zerar o que não vai) para liberar o embarque.
          </p>
        </div>
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
          onDownload={(format) => handleDownloadChecklist("retorno", format)}
          downloading={downloading}
          saving={savingReturn}
          sending={sendingWhats}
          canEdit={canEmbarcar}
          message={returnMsg}
          history={existingReturn ? [existingReturn] : []}
          editing={!!existingReturn}
        />
      )}

      {tab === "embarque" && selectedTeam && (<>
      {/* Materiais — baixados do Estoque (GALPAO) ao embarcar. O "Leva" é
          editável POR NAVIO (não mexe no kit oficial da equipe) e dá pra puxar
          itens extras do Estoque em caso de falta. */}
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
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-text-light">{matReady} ok · {matMissing} com falta · {teamKit.length} itens</span>
            {canEmbarcar && (
              <Button size="sm" variant="secondary" onClick={() => setAddKind("MATERIAL")} title="Adicionar um item do Estoque só na lista deste navio">
                ➕ Adicionar item
              </Button>
            )}
          </div>
        </div>
        {showMat && (
        <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-border">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">Item</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Categoria</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase" title="Quanto vai neste navio — editável, sem mexer no kit padrão da equipe">Leva</th>
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
                      {canEmbarcar && <span className="block text-xs mt-1">Use o ➕ Adicionar item pra montar a lista deste navio.</span>}
                    </td>
                  </tr>
                ) : (
                  teamKit.map((k) => (
                    <tr key={k.id} className={`hover:bg-gray-50 ${!k.ready ? "bg-red-50/40" : ""}`}>
                      <td className="px-4 py-3 font-medium">
                        {k.estName}
                        {k.added && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold uppercase" title="Item extra — só na lista deste navio">extra</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">{k.location}</span>
                      </td>
                      <td className="px-4 py-3 text-center text-text-light">
                        {canEmbarcar ? (
                          <span className="inline-flex items-center gap-1">
                            <input
                              type="number" min={0} step="any"
                              value={qtyDraft[k.stock_item_id] ?? String(k.need)}
                              onChange={(e) => setQtyDraft((d) => ({ ...d, [k.stock_item_id]: e.target.value }))}
                              onBlur={() => commitQty("MATERIAL", k.stock_item_id, k.baseNeed)}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              title={k.added ? "Item extra deste navio" : `Padrão do kit: ${k.baseNeed} — o ajuste vale só pra este navio`}
                              className={`w-16 px-2 py-1 border rounded text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 ${k.overridden ? "border-amber-400 bg-amber-50 font-semibold text-amber-800" : "border-border"}`}
                            />
                            {k.overridden && (
                              <button
                                type="button"
                                onClick={() => saveOverride("MATERIAL", k.stock_item_id, k.baseNeed, k.baseNeed)}
                                className="text-xs text-text-light hover:text-primary transition"
                                title={`Voltar ao padrão do kit (${k.baseNeed})`}
                              >↺</button>
                            )}
                            {k.added && (
                              <button
                                type="button"
                                onClick={() => saveOverride("MATERIAL", k.stock_item_id, 0, 0)}
                                className="text-xs text-text-light hover:text-danger transition"
                                title="Tirar este item extra da lista do navio"
                              >✕</button>
                            )}
                          </span>
                        ) : (
                          k.need
                        )}
                      </td>
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

      {/* Comida — baixada do Rancho (estoque por equipe) ao embarcar. O
          "Padrão" também é editável POR NAVIO, e dá pra puxar itens do Rancho
          da equipe que não têm quantidade padrão. */}
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
            {canEmbarcar && (
              <Button size="sm" variant="secondary" onClick={() => setAddKind("RANCHO")} title="Adicionar um item do Rancho da equipe só na lista deste navio">
                ➕ Adicionar item
              </Button>
            )}
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
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase" title="Quanto vai neste navio — editável, sem mexer no padrão do Rancho">Padrão</th>
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
                      {canEmbarcar && <span className="block text-xs mt-1">Use o ➕ Adicionar item pra montar a lista deste navio.</span>}
                    </td>
                  </tr>
                ) : (
                  itemsWithStatus.map((item) => (
                    <tr key={item.id} className={`hover:bg-gray-50 ${!item.ready ? "bg-red-50/40" : ""}`}>
                      <td className="px-4 py-3 font-medium">
                        {item.name}
                        {item.added && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold uppercase" title="Item extra — só na lista deste navio">extra</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                          {item.category === "CARNE" ? "Carne" : item.category === "FEIRA" ? "Feira" : "Suprimentos"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center text-text-light">
                        {canEmbarcar ? (
                          <span className="inline-flex items-center gap-1">
                            <input
                              type="number" min={0} step="any"
                              value={qtyDraft[item.id] ?? String(item.default_quantity)}
                              onChange={(e) => setQtyDraft((d) => ({ ...d, [item.id]: e.target.value }))}
                              onBlur={() => commitQty("RANCHO", item.id, item.base_default)}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              title={item.added ? "Item extra deste navio" : `Padrão do Rancho: ${item.base_default} — o ajuste vale só pra este navio`}
                              className={`w-16 px-2 py-1 border rounded text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 ${item.overridden ? "border-amber-400 bg-amber-50 font-semibold text-amber-800" : "border-border"}`}
                            />
                            {item.overridden && (
                              <button
                                type="button"
                                onClick={() => saveOverride("RANCHO", item.id, item.base_default, item.base_default)}
                                className="text-xs text-text-light hover:text-primary transition"
                                title={`Voltar ao padrão do Rancho (${item.base_default})`}
                              >↺</button>
                            )}
                            {item.added && (
                              <button
                                type="button"
                                onClick={() => saveOverride("RANCHO", item.id, 0, 0)}
                                className="text-xs text-text-light hover:text-danger transition"
                                title="Tirar este item extra da lista do navio"
                              >✕</button>
                            )}
                          </span>
                        ) : (
                          item.default_quantity
                        )}
                      </td>
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

      {/* Modal "Adicionar item": itens do Estoque (materiais) ou do Rancho da
          equipe que ainda não estão na lista deste navio. */}
      {addKind && selectedTeam && (
        <AddItemModal
          kind={addKind}
          candidates={addCandidates}
          shipName={currentShip?.name || ""}
          onAdd={(stockItemId, qty) => saveOverride(addKind, stockItemId, qty, 0)}
          onClose={() => setAddKind(null)}
        />
      )}

      <ConfirmDialog
        open={confirmEmbark}
        onClose={() => setConfirmEmbark(false)}
        onConfirm={handleEmbarcar}
        title="Confirmar Embarque"
        message={`Embarcar ${selectedTeam ? TEAM_LABELS[selectedTeam] : "a equipe"} no navio "${currentShip?.name}"? Os materiais do kit serão baixados do Estoque e a comida do Rancho desta equipe. O aviso de embarque (com a lista em PDF) vai automático pro grupo do WhatsApp.`}
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
  onSave, onSend, onDownload, downloading, saving, sending, canEdit, message, history, editing,
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
  onDownload: (format: "pdf" | "xlsx") => void;
  downloading: "pdf" | "xlsx" | null;
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
  // o rótulo do avariado: material "Avariado", comida "Estragou").
  //
  // Três destinos possíveis pro que foi: VOLTOU (bom, credita o estoque),
  // AVARIADO (voltou quebrado — a equipe trouxe, não custa ao navio) e PERDIDO
  // (não voltou — vira despesa do navio, dividida pela equipe).
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
              <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase" title="Voltou em bom estado — credita o estoque de volta">Voltou</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase" title="Voltou, mas quebrado/estragado — a equipe trouxe de volta; não custa nada ao navio">{labels.broken}</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase" title="Não voltou — vira despesa do navio, dividida pela equipe no Pagamento de Navios">Perdido</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">Obs.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {kit.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-text-light">
                  <span className="text-3xl block mb-2">{labels.emptyIcon}</span>
                  {labels.empty}
                </td>
              </tr>
            ) : (
              kit.map((k) => {
                const d = draft[k.stock_item_id] || { returned: "", broken: "", lost: "", note: "" };
                return (
                  <tr key={k.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-medium">{k.estName}</td>
                    <td className="px-4 py-2.5 text-center text-text-light">{k.need}</td>
                    <td className="px-4 py-2.5 text-center">
                      <input type="number" min={0} step={1} value={d.returned} disabled={!canEdit}
                        onChange={(e) => {
                          const v = e.target.value;
                          const ret = parseInt(v);
                          // O que não voltou nem foi marcado como avariado cai
                          // em PERDIDO (Foi − Voltou − Avariado) — é o que custa
                          // ao navio. Dá pra corrigir na mão depois.
                          const bro = parseInt(d.broken) || 0;
                          const lost = v === "" || isNaN(ret) ? "" : String(Math.max(0, k.need - ret - bro));
                          setDraft(k.stock_item_id, { returned: v, lost });
                        }}
                        className={numCls} placeholder="0" />
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <input type="number" min={0} step={1} value={d.broken} disabled={!canEdit}
                        onChange={(e) => {
                          const v = e.target.value;
                          const bro = parseInt(v) || 0;
                          const ret = parseInt(d.returned);
                          // Marcar avariado tira do perdido (o item apareceu).
                          const lost = d.returned === "" || isNaN(ret) ? d.lost : String(Math.max(0, k.need - ret - bro));
                          setDraft(k.stock_item_id, { broken: v, lost });
                        }}
                        className={`${numCls} ${(parseInt(d.broken) || 0) > 0 ? "border-amber-300 text-amber-700" : ""}`} placeholder="0" />
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <input type="number" min={0} step={1} value={d.lost} disabled={!canEdit}
                        onChange={(e) => setDraft(k.stock_item_id, { lost: e.target.value })}
                        className={`${numCls} ${(parseInt(d.lost) || 0) > 0 ? "border-red-300 text-red-700 font-semibold" : ""}`} placeholder="0" />
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
          <span className="text-xs text-text-light">
            Bom volta pro estoque · <span className="text-amber-700">avariado</span> a equipe trouxe (não custa) ·{" "}
            <span className="text-red-700">perdido</span> vira custo do navio, dividido pela equipe.
          </span>
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
          item: "Material", broken: "Avariado",
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
          empty: "Nenhum alimento cadastrado no Rancho desta equipe", emptyIcon: "🛒",
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
            {/* Lista em branco (layout do Check List) pra conferência à mão */}
            <Button size="sm" variant="secondary" onClick={() => onDownload("pdf")} disabled={downloading !== null || saving} title="Baixar a lista de conferência em PDF (cabeçalho em branco)">
              {downloading === "pdf" ? "Gerando..." : "📄 Lista PDF"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onDownload("xlsx")} disabled={downloading !== null || saving} title="Baixar a lista de conferência em Excel pra editar">
              {downloading === "xlsx" ? "Gerando..." : "📊 Lista Excel"}
            </Button>
            <Button size="sm" variant="secondary" onClick={onSend} disabled={sending || saving}>
              {sending ? "Enviando..." : "📨 Enviar ocorrências pro WhatsApp"}
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
              const items = r.material_return_items || [];
              const broken = items.filter((it) => it.broken_qty > 0);
              const lost = items.filter((it) => (it.lost_qty || 0) > 0);
              // Observação solta (nada voltou, nada avariou/sumiu) entra junto
              // dos avariados pra não sumir do resumo.
              const noteOnly = items.filter(
                (it) => it.broken_qty === 0 && (it.lost_qty || 0) === 0 && it.returned_qty === 0 && it.note,
              );
              const returned = items.filter((it) => it.returned_qty > 0);
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
                  {(broken.length > 0 || noteOnly.length > 0) && (
                    <ul className="mt-1 space-y-0.5">
                      {broken.map((it) => (
                        <li key={`b${it.id}`} className="text-xs text-amber-700">
                          🔧 Avariado: {it.item_name} ({it.broken_qty}){it.note ? ` — ${it.note}` : ""}
                        </li>
                      ))}
                      {noteOnly.map((it) => (
                        <li key={`n${it.id}`} className="text-xs text-text-light">
                          📝 {it.item_name} — {it.note}
                        </li>
                      ))}
                    </ul>
                  )}
                  {lost.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {lost.map((it) => (
                        <li key={`l${it.id}`} className="text-xs text-red-700 font-medium">
                          ❌ Perdido: {it.item_name} ({it.lost_qty}){it.note ? ` — ${it.note}` : ""}
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

// ─── Adicionar item na lista do navio ───────────────────────────────────────
// Busca em cima dos itens do Estoque (materiais) ou do Rancho da equipe que
// ainda NÃO estão na lista, com quantidade por item. Adicionar vira um ajuste
// (item extra) só deste navio — o kit oficial e o padrão do Rancho não mudam.
// O modal fica aberto depois de adicionar, pra incluir vários de uma vez (o
// item some da busca porque entrou na lista).
function AddItemModal({
  kind, candidates, shipName, onAdd, onClose,
}: {
  kind: "MATERIAL" | "RANCHO";
  candidates: StockItem[];
  shipName: string;
  onAdd: (stockItemId: number, qty: number) => Promise<void>;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  // Quantidade digitada por item (padrão 1) e trava anti-duplo-clique.
  const [qtyByItem, setQtyByItem] = useState<Record<number, string>>({});
  const [addingId, setAddingId] = useState<number | null>(null);
  const [addedCount, setAddedCount] = useState(0);

  const filtered = candidates.filter((c) => matchSearch(c.name, search));

  function badgeOf(c: StockItem): string {
    if (kind === "RANCHO") {
      return c.category === "CARNE" ? "Carne" : c.category === "FEIRA" ? "Feira" : "Suprimentos";
    }
    return c.location || MATERIAL_TEAM_LABEL[String((c as any).team)] || "—";
  }

  async function handleAdd(c: StockItem) {
    const raw = qtyByItem[c.id] ?? "1";
    const qty = parseFloat(raw.replace(",", "."));
    if (!Number.isFinite(qty) || qty <= 0) return;
    setAddingId(c.id);
    try {
      await onAdd(c.id, qty);
      setAddedCount((n) => n + 1);
    } finally {
      setAddingId(null);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={kind === "MATERIAL" ? "➕ Adicionar material do Estoque" : "➕ Adicionar item do Rancho"}
      maxWidth="max-w-2xl"
    >
      <div className="space-y-3">
        <p className="text-xs text-text-light">
          O item entra como <strong>extra</strong> só na lista do navio <strong>{shipName}</strong> — o
          {kind === "MATERIAL" ? " kit padrão da equipe" : " padrão do Rancho"} não muda.
        </p>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={kind === "MATERIAL" ? "🔍 Buscar item do Estoque..." : "🔍 Buscar item do Rancho da equipe..."}
          autoFocus
          className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:ring-2 focus:ring-primary outline-none"
        />
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="max-h-80 overflow-y-auto divide-y divide-border">
            {filtered.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-text-light">
                {candidates.length === 0
                  ? "Tudo que existe aqui já está na lista deste navio."
                  : "Nenhum item encontrado com essa busca."}
              </div>
            ) : (
              filtered.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <p className="text-[11px] text-text-light">
                      <span className="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium mr-1.5">{badgeOf(c)}</span>
                      {kind === "MATERIAL" ? "em estoque" : "no rancho"}: {formatQty(c.quantity)} {unitSuffix(c.unit)}
                    </p>
                  </div>
                  <input
                    type="number" min={0} step="any"
                    value={qtyByItem[c.id] ?? "1"}
                    onChange={(e) => setQtyByItem((d) => ({ ...d, [c.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAdd(c); }}
                    title="Quantidade que vai neste navio"
                    className="w-16 px-2 py-1 border border-border rounded text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <Button size="sm" onClick={() => handleAdd(c)} disabled={addingId !== null}>
                    {addingId === c.id ? "..." : "Adicionar"}
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-text-light">
            {addedCount > 0 ? `✅ ${addedCount} item(ns) adicionado(s) à lista.` : ""}
          </span>
          <Button variant="secondary" onClick={onClose}>Fechar</Button>
        </div>
      </div>
    </Modal>
  );
}
