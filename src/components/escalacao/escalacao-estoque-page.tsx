"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission, canViewStockValue, type Module } from "@/lib/rbac";
import { releaseShipAllocationsNow } from "@/lib/release-finished-ships";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatDate, matchSearch, formatQty, unitSuffix, parseDecimalBR, normalize, formatCurrency } from "@/lib/utils";
import { STOCK_UNITS } from "@/lib/stock-units";
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
  services?: string[] | null; // ["COSTADO"] = navio de Costado (sem kit/Retorno)
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
  // INSUMO: consumido de propósito (graxa, química...). Sai do estoque, mas não
  // custa nada ao navio — é consumo normal, não perda.
  consumed_qty: number;
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

// Rascunho por material na tela de Retorno (voltou / avariado / perdido / insumo / obs).
interface ReturnDraft { returned: string; broken: string; lost: string; consumed: string; note: string }

// Ajuste da lista POR NAVIO (embark_list_overrides): muda quanto vai de um item
// do kit/rancho só neste navio, ou adiciona um item extra do Estoque/Rancho.
interface ListOverride {
  id: number;
  ship_id: string;
  team: string;
  kind: "MATERIAL" | "RANCHO";
  stock_item_id: number;
  quantity: number;
  note?: string | null;
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

// Setores onde a aba "✨ Novo item" do modal de adicionar pode CADASTRAR um
// material (mesmos rótulos e módulos de permissão do Almoxarifado — ver
// SETOR_MODULE em geral-panel.tsx). Rancho fica de fora: comida se cadastra lá.
const CREATE_SETORES: { key: string; label: string; module: Module }[] = [
  { key: "GALPAO", label: "Utensílios", module: "ESTOQUE" },
  { key: "FLUIDOS", label: "Fluídos", module: "ESTOQUE" },
  { key: "MAQUINARIO", label: "Maquinário", module: "MAQUINARIO" },
  { key: "FERRAMENTA", label: "Ferramenta", module: "FERRAMENTAS" },
  { key: "ELETRICA", label: "Elétrica", module: "ELETRICA" },
];

// Ordem oficial da lista de embarque (formulário de papel do Josué), pra criar
// familiaridade com o maquinista: a lista na tela (Embarque e Retorno) segue
// ESTA sequência, não a ordem alfabética. Nome = stock_items.name exato. Item
// que não estiver aqui vai pro fim, em ordem alfabética.
const EMBARK_ORDER = [
  // coluna esquerda do formulário
  "MAQUINA HIDROJATO", "ENGATE PISTOLA", "CANETA", "VARÃO GROSSO", "VARAO FINO",
  "EMEN/VARÃO", "EMEN/MEIO", "BICO QUIMICA", "FILTRO", "GRAXA", "TAMBOR",
  "QUADRO ENERG.", "BOBINA DE CABO", "BOTOEIRA", "CINTA DE IÇAMENTO",
  "MANGUEIRA BOMBA", "MANGUEIRA JARDIM", "MANGUEIRA GROSSA", "MANGUEIRA MEDIA",
  "MANGUEIRA FINA", "MANG/QUÍMI.", "BOMBA/QUÍMI.", "VARAO FINO ESFREGÃO",
  "ESPUMA", "ESCADA", "CORDA BOMBEIRO", "REDE", "BEG", "LONA 6X6", "FOGAO",
  "GÁS", "COLLER", "CAXOT/FERRAM.", "CAXOT/COMID.", "ERASPADEIRA CUMPRIDA",
  // coluna direita
  "VASELINA PASTA", "PA BORRACHA", "COLA AZUL", "CARGO LIGHT", "RADIO TANSMISSOR",
  "BALSA", "QUIMICA KIMIKLAP", "QUIMICA REMOCON", "ARCO SERRA", "COTOVELO BOMBA",
  "COTOVELO BYPASS", "PNEU DE ROLAMENTO", "BICO AGRESSIVO", "NIPLE",
  "BRAÇADEIRA PRETA 4,8", "REGISTRO AGUA", "CONC/MAN/JÁ", "BYPASS", "LUVA PVC",
  "LUVA PIGMENTADA BRANCA", "SILVER TAPE", "FITA VERMELHA", "FITA HELLERMAN/LACRE",
  "COLA CASCOLAC", "CAPA QUIMICA", "DESINGRIPANTE", "LIMPA CONTATO", "MULTIMETRO",
  "MASCARA DE PROTEÇÃO", "MASCARA DE PROT SIMPLES", "CINTO DE SEGURANÇA",
  "ESPATOLA MAO", "MARRETA",
  // página 2 (conectores e extras)
  "CONEC/ MACHO CAIXA", "CONEC/ FEMEA BOBINA", "CONEC/ FÊMEA DUPLA", "OLEO MOTOR",
  "CAXETA", "CONEC/ MACHO MÁQUINA", "CORREÇÃO RETA", "CORREÇÃO GATILHO",
  "FITA ISOLANTE", "FITA VEDA ROSCA",
];
const EMBARK_ORDER_INDEX = new Map(EMBARK_ORDER.map((n, i) => [n, i]));
const embarkSeq = (name: string) =>
  EMBARK_ORDER_INDEX.get(name) ?? Number.MAX_SAFE_INTEGER;

export function EscalacaoEstoquePage() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const role = profile?.role || "RH";
  const canEmbarcar = hasPermission(role, "EMBARQUE", "embarcar");
  const canSeeValue = canViewStockValue(role);
  // Setores em que este papel pode criar item novo (alimenta a aba "Novo item"
  // do modal de adicionar material — vazio esconde a aba).
  const createSetores = CREATE_SETORES.filter((s) => hasPermission(role, s.module, "create"));

  const [ships, setShips] = useState<Ship[]>([]);
  const [selectedShip, setSelectedShip] = useState<string>("");
  // Mostrar navios finalizados (Concluído/Cancelado) no seletor — igual à aba
  // Escalação. Por padrão só os ativos (Agendado / Em Operação) + os Concluídos
  // que ainda não têm Retorno registrado (fechados direto na aba Navios).
  const [showFinished, setShowFinished] = useState(false);
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [kitItems, setKitItems] = useState<KitItem[]>([]);
  const [overrides, setOverrides] = useState<ListOverride[]>([]);
  // Material separado por equipe (material_team_allocations). O "em estoque" de um
  // material pra equipe do navio = o que está alocado PRA ela (não o total do galpão).
  const [allocs, setAllocs] = useState<{ id: number; stock_item_id: number; team: string; quantity: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmbark, setConfirmEmbark] = useState(false);
  const [embarking, setEmbarking] = useState(false);

  // Edição do "Leva"/"Padrão" por navio: rascunho do input por stock_item_id
  // (grava no blur) e modal de "Adicionar item" (materiais ou rancho).
  const [qtyDraft, setQtyDraft] = useState<Record<number, string>>({});
  // Rascunho da observação por item (Obs. da aba Embarque), por stock_item_id.
  const [noteDraft, setNoteDraft] = useState<Record<number, string>>({});
  const [addKind, setAddKind] = useState<"MATERIAL" | "RANCHO" | null>(null);
  // Renomear o produto do Estoque direto da lista (muda o nome no Estoque todo).
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  // Aba Embarque (preparar/baixar) x Retorno (conferir o que voltou).
  const [tab, setTab] = useState<"embarque" | "retorno">("embarque");
  const [returns, setReturns] = useState<MaterialReturn[]>([]);
  // Rascunho da conferência de retorno, por stock_item_id do material.
  const [returnDraft, setReturnDraft] = useState<Record<number, ReturnDraft>>({});
  const [returnNotes, setReturnNotes] = useState("");
  const [savingReturn, setSavingReturn] = useState(false);
  const [sendingWhats, setSendingWhats] = useState(false);
  const [returnMsg, setReturnMsg] = useState<string | null>(null);
  // Ao confirmar o retorno, pergunta a data de saída do navio pra fechar ele.
  const [confirmReturnOpen, setConfirmReturnOpen] = useState(false);
  const [closeDateDraft, setCloseDateDraft] = useState("");

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
      const [shipsRes, stockRes, kitRes, retRes, ovrRes, allocRes] = await Promise.all([
        db.from("ships").select("*").in("status", ["AGENDADO", "EM_OPERACAO", "CONCLUIDO", "CANCELADO"]).order("arrival_date"),
        db.from("stock_items").select("*").order("name"),
        db.from("embark_kit_items").select("*, stock_items(id, name, quantity, location, unit)"),
        db.from("material_returns").select("*, material_return_items(id, return_id, stock_item_id, item_name, went_qty, returned_qty, broken_qty, lost_qty, consumed_qty, note)").order("created_at", { ascending: false }),
        db.from("embark_list_overrides").select("*"),
        db.from("material_team_allocations").select("*"),
      ]);
      setShips((shipsRes.data as Ship[]) || []);
      setStockItems(stockRes.data || []);
      setKitItems((kitRes.data as KitItem[]) || []);
      setReturns((retRes.data as MaterialReturn[]) || []);
      setOverrides((ovrRes.data as ListOverride[]) || []);
      setAllocs((allocRes.data as { id: number; stock_item_id: number; team: string; quantity: number }[]) || []);
    } catch (err) {
      console.error("Load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData, pathname]);

  // Navio "ativo" = ainda em andamento (Agendado / Em Operação). Finalizados
  // (Concluído / Cancelado) só aparecem com o toggle "mostrar finalizados".
  const isActiveShip = (s: Ship) => s.status === "AGENDADO" || s.status === "EM_OPERACAO";
  // Navio fechado direto na aba Navios (Concluído SEM Retorno registrado)
  // continua na lista padrão: o Retorno pode ser feito depois do fechamento,
  // e é ele que tira o navio daqui. Costado e navio sem equipe ficam de fora —
  // não têm kit de material, logo nunca teriam Retorno pra registrar.
  const shipHasReturn = (shipId: string) => returns.some((r) => r.ship_id === shipId);
  const isCostadoShip = (s: Ship) => (s.services || []).includes("COSTADO");
  const isPendingShip = (s: Ship) => isActiveShip(s)
    || (s.status === "CONCLUIDO" && !!s.assigned_team && !isCostadoShip(s) && !shipHasReturn(s.id));
  const visibleShips = showFinished ? ships : ships.filter(isPendingShip);

  useEffect(() => {
    // Auto-seleciona o 1º navio pendente (não um finalizado que veio junto na query).
    if (!selectedShip) {
      const first = ships.find(isPendingShip) || ships[0];
      if (first) setSelectedShip(first.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ships, returns, selectedShip]);

  const currentShip = ships.find((s) => s.id === selectedShip);
  // A equipe vem do cadastro do navio (aba Navios) — não se escolhe aqui.
  // Navio sem equipe (ex.: Costado) mostra aviso e não lista kit nenhum.
  const selectedTeam = (currentShip?.assigned_team && TEAM_LABELS[currentShip.assigned_team]
    ? currentShip.assigned_team
    : null) as "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3" | "EQUIPE_4" | null;

  // Navio já EM OPERAÇÃO (embarque feito) abre direto na aba Retorno; agendado
  // abre no Embarque. Concluído sem Retorno também abre no Retorno — é o que
  // falta fazer nele. Só troca ao MUDAR de navio — respeita o clique manual.
  const lastTabShipRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentShip || lastTabShipRef.current === currentShip.id) return;
    lastTabShipRef.current = currentShip.id;
    const wantsReturn = currentShip.status === "EM_OPERACAO"
      || (currentShip.status === "CONCLUIDO" && isPendingShip(currentShip));
    setTab(wantsReturn ? "retorno" : "embarque");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentShip]);

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
        overridden: !!ovr && baseDef > 0 && ovr.quantity !== baseDef,
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
  // Quanto do material está separado PRA a equipe deste navio (o "em estoque"
  // que conta pro embarque — o total do galpão fica no Almoxarifado).
  const teamAllocFor = (stockItemId: number) =>
    allocs.find((a) => a.stock_item_id === stockItemId && a.team === selectedTeam)?.quantity ?? 0;

  const kitStockIds = new Set(kitItems.filter((k) => k.team === selectedTeam).map((k) => k.stock_item_id));
  const kitRows = kitItems
    .filter((k) => k.team === selectedTeam)
    .map((k) => {
      const ovr = overrideByItem.get(k.stock_item_id);
      const estName = k.stock_items?.name || `#${k.stock_item_id}`;
      const emEstoque = teamAllocFor(k.stock_item_id);
      const need = ovr ? ovr.quantity : k.quantity;
      return {
        id: k.id,
        stock_item_id: k.stock_item_id,
        estName,
        emEstoque,
        need,
        baseNeed: k.quantity,
        overridden: !!ovr && ovr.quantity !== k.quantity,
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
      const emEstoque = teamAllocFor(o.stock_item_id);
      return {
        id: -o.id, // id negativo: não colide com id de kit (React key)
        stock_item_id: o.stock_item_id,
        estName: si.name,
        emEstoque,
        need: o.quantity,
        baseNeed: 0,
        overridden: false,
        added: true,
        ready: emEstoque >= o.quantity,
        falta: Math.max(0, o.quantity - emEstoque),
        location: si.location || MATERIAL_TEAM_LABEL[(si as any).team] || "—",
        unit: si.unit || null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const teamKit = [...kitRows, ...extraRows].sort((a, b) => {
    const d = embarkSeq(a.estName) - embarkSeq(b.estName);
    return d !== 0 ? d : a.estName.localeCompare(b.estName, "pt-BR");
  });
  // Leva 0 = material tirado deste navio: some da lista principal e vai pra
  // seção "Removidos" (dá pra restaurar). Não conta como falta nem entra no
  // PDF/WhatsApp (buildListPayload já filtra need > 0).
  const teamKitActive = teamKit.filter((k) => k.need > 0);
  const teamKitRemoved = teamKit.filter((k) => k.need <= 0);
  const matReady = teamKitActive.filter((k) => k.ready).length;
  const matMissing = teamKitActive.length - matReady;

  // Layout responsivo das listas de Embarque (Materiais e Rancho), no mesmo
  // molde do Retorno: no desktop (sm+) alinha em colunas (grid); no celular
  // vira cartão — nome + categoria em cima e os campos numa linha com rótulo,
  // sem a rolagem horizontal que cortava os nomes. 5 colunas:
  // Item · Categoria · Quantidade · Em estoque/rancho · Status.
  const embarkGrid =
    "sm:grid sm:grid-cols-[minmax(0,1fr)_7rem_8rem_6rem_6rem_minmax(7rem,1.3fr)] sm:items-center sm:gap-2";

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

  // Disponível de cada material = Total do galpão − o que já está alocado pras
  // equipes (material_team_allocations). É esse número que o modal "Adicionar
  // material do Estoque" mostra (o que sobra livre pra puxar), não o Total.
  const availById = new Map<number, number>(stockItems.map((s) => [s.id, s.quantity]));
  for (const a of allocs) {
    availById.set(a.stock_item_id, (availById.get(a.stock_item_id) ?? 0) - a.quantity);
  }

  // Candidatos do modal "Adicionar item": tudo que está no Estoque (materiais)
  // ou no Rancho da equipe e ainda não aparece na lista deste navio. Item SEM
  // disponível nem aparece — só dá pra puxar o que sobra livre pra equipe que
  // vai embarcar (material: total − alocado; rancho: o que a equipe tem em mão).
  const listedIds = new Set([...teamKit.map((k) => k.stock_item_id), ...itemsWithStatus.map((i) => i.id)]);
  const addCandidates = addKind === "MATERIAL"
    ? stockItems.filter((i) => MATERIAL_TEAMS.has(String((i as any).team)) && !listedIds.has(i.id) && (availById.get(i.id) ?? 0) > 0)
    : addKind === "RANCHO"
      ? stockItems.filter((i) => (i as any).team === selectedTeam && !listedIds.has(i.id) && i.quantity > 0)
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
  // Upsert do ajuste por navio+item (quantidade E observação). O override só é
  // apagado quando NÃO há nada a lembrar: quantidade no padrão E sem observação.
  async function saveOverrideFull(
    kind: "MATERIAL" | "RANCHO", stockItemId: number, qty: number, note: string, baseQty: number,
  ) {
    if (!currentShip || !selectedTeam) return;
    // O único ajuste possível pro par navio+item (unique no banco) — pode ser
    // de outra equipe (navio trocou de equipe): aí é atualizado e "adotado".
    const existing = overrides.find((o) => o.ship_id === selectedShip && o.stock_item_id === stockItemId);
    const cleanNote = note.trim() || null;
    try {
      if (qty === baseQty && !cleanNote) {
        if (!existing) return;
        const res = await db.from("embark_list_overrides").delete().eq("id", existing.id);
        if (res.error) throw new Error(res.error.message);
        setOverrides((prev) => prev.filter((o) => o.id !== existing.id));
      } else if (existing) {
        if (existing.quantity === qty && (existing.note ?? null) === cleanNote && existing.team === selectedTeam && existing.kind === kind) return;
        const res = await db.from("embark_list_overrides").update({ quantity: qty, note: cleanNote, team: selectedTeam, kind }).eq("id", existing.id);
        if (res.error) throw new Error(res.error.message);
        setOverrides((prev) => prev.map((o) => (o.id === existing.id ? { ...o, quantity: qty, note: cleanNote, team: selectedTeam, kind } : o)));
      } else {
        const res: any = await db.from("embark_list_overrides").insert({
          ship_id: selectedShip,
          team: selectedTeam,
          kind,
          stock_item_id: stockItemId,
          quantity: qty,
          note: cleanNote,
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

  // Grava o "leva" de um item SÓ neste navio, preservando a observação atual.
  function saveOverride(kind: "MATERIAL" | "RANCHO", stockItemId: number, qty: number, baseQty: number) {
    const existing = overrides.find((o) => o.ship_id === selectedShip && o.stock_item_id === stockItemId);
    return saveOverrideFull(kind, stockItemId, qty, existing?.note ?? "", baseQty);
  }

  // Grava a observação de um item SÓ neste navio, preservando a quantidade atual.
  function saveOverrideNote(kind: "MATERIAL" | "RANCHO", stockItemId: number, note: string, baseQty: number) {
    const existing = overrides.find((o) => o.ship_id === selectedShip && o.stock_item_id === stockItemId);
    return saveOverrideFull(kind, stockItemId, existing ? existing.quantity : baseQty, note, baseQty);
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

  // Blur do campo "Obs." de um item: grava a observação (só neste navio).
  function commitNote(kind: "MATERIAL" | "RANCHO", stockItemId: number, baseQty: number) {
    const raw = noteDraft[stockItemId];
    if (raw == null) return;
    setNoteDraft((d) => {
      const nd = { ...d };
      delete nd[stockItemId];
      return nd;
    });
    void saveOverrideNote(kind, stockItemId, raw, baseQty);
  }

  // Observação salva de um item (do override do navio) — valor exibido no campo.
  const noteOf = (stockItemId: number) =>
    overrideByItem.get(stockItemId)?.note ?? "";

  // Aba "✨ Novo item" do modal de adicionar material: o mesmo cadastro do
  // Almoxarifado, mas que faz as duas coisas de uma vez — cria o item no
  // Estoque (Total + ENTRADA no histórico) E coloca na lista deste navio. A
  // parte que vai a bordo é separada pra equipe (material_team_allocations),
  // senão o item nasceria "com falta" e não seria baixado no Embarcar; o que
  // sobrar (quantidade − leva) fica no Disponível do galpão. O kit padrão da
  // equipe continua intacto (a lista ganha só o extra deste navio).
  async function handleCreateStockItem(data: {
    setor: string; name: string; unit: string; quantity: number; leva: number; unitValue: number; notes: string | null;
  }) {
    if (!currentShip || !selectedTeam) return;
    const actor = profile?.full_name || "Sistema";
    const today = new Date().toISOString().split("T")[0];

    const payload: Record<string, unknown> = {
      name: data.name,
      category: "OUTROS",
      team: data.setor,
      unit: data.unit || "UN",
      quantity: data.quantity,
      min_quantity: 0,
      notes: data.notes,
      updated_by: actor,
    };
    if (canSeeValue && data.unitValue > 0) payload.unit_value = data.unitValue;
    const insRes: any = await db.from("stock_items").insert(payload);
    if (insRes?.error) throw new Error(insRes.error.message);
    const created = (Array.isArray(insRes.data) ? insRes.data[0] : insRes.data) as StockItem | null;
    if (!created?.id) throw new Error("O item foi salvo mas a resposta veio vazia — recarregue a página.");

    if (data.quantity > 0) {
      await db.from("stock_movements").insert({
        stock_item_id: created.id,
        movement_type: "ENTRADA",
        quantity: data.quantity,
        movement_date: today,
        notes: `Cadastro via Embarque: ${currentShip.name} (${TEAM_LABELS[selectedTeam]})`,
        created_by: actor,
      } as any);
    }

    if (data.leva > 0) {
      const allocRes: any = await db.from("material_team_allocations").insert({
        stock_item_id: created.id, team: selectedTeam, quantity: data.leva, updated_by: actor,
      } as any);
      if (allocRes?.error) throw new Error(allocRes.error.message);
      const alloc = Array.isArray(allocRes.data) ? allocRes.data[0] : allocRes.data;
      if (alloc?.id) setAllocs((prev) => [...prev, alloc]);
    }

    // Atualiza o estado local direto (loadData desmontaria o modal aberto).
    setStockItems((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")));

    // Entra na lista deste navio como extra (embark_list_overrides).
    await saveOverride("MATERIAL", created.id, data.leva, 0);
  }

  // Renomeia o produto no Estoque (stock_items.name) — reflete em todos os
  // navios/telas, é o mesmo produto. Editável direto da lista de embarque.
  async function handleRenameStock(stockItemId: number) {
    const name = renameValue.trim();
    const current = stockItems.find((i) => i.id === stockItemId)?.name || "";
    if (!name || name === current) { setRenamingId(null); return; }
    setSavingRename(true);
    try {
      const res: any = await db.from("stock_items")
        .update({ name, updated_by: profile?.full_name || "Sistema" } as any)
        .eq("id", stockItemId);
      if (res?.error) throw new Error(res.error.message);
      setRenamingId(null);
      await loadData();
    } catch (err) {
      setEmbarkMsg(`Erro ao renomear: ${(err as Error).message}`);
    } finally {
      setSavingRename(false);
    }
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
    // Um embarque por navio: só embarca quem está AGENDADO. Depois de embarcar o
    // navio vira EM_OPERACAO (e no fim CONCLUIDO), então clicar de novo não baixa
    // o estoque duas vezes.
    if (currentShip.status !== "AGENDADO") {
      setConfirmEmbark(false);
      setEmbarkMsg(
        currentShip.status === "CONCLUIDO"
          ? "✅ Este navio já foi concluído — não dá pra embarcar de novo."
          : "⚓ Este navio já embarcou (Em Operação) — não dá pra embarcar de novo. Se precisar, faça o Retorno.",
      );
      return;
    }
    // Pode embarcar com pendências: baixa só o que a equipe tem (min entre o que
    // vai e o disponível). O que faltar simplesmente não é baixado — o navio
    // segue e a equipe se vira, é a flexibilidade que o operacional pediu.
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

    // Materiais (kit) -> o material separado PRA a equipe é consumido: baixa a
    // alocação da equipe E o total do galpão (o material vai pro navio, sai da
    // empresa). O "Disponível" (total − alocado) não muda — os dois caem junto.
    const today = new Date().toISOString().split("T")[0];
    for (const k of teamKit) {
      if (k.need <= 0 || k.emEstoque <= 0) continue;
      const toConsume = Math.min(k.emEstoque, k.need);
      await db.from("stock_movements").insert({
        stock_item_id: k.stock_item_id,
        movement_type: "BAIXA",
        quantity: toConsume,
        movement_date: today,
        notes: `Embarque (materiais): ${currentShip.name} (${selectedTeam})`,
        created_by: actor,
      } as any);
      // Baixa a alocação da equipe.
      const alloc = allocs.find((a) => a.stock_item_id === k.stock_item_id && a.team === selectedTeam);
      if (alloc) {
        await db.from("material_team_allocations").update({
          quantity: Math.max(0, +(alloc.quantity - toConsume).toFixed(3)),
          updated_by: actor,
        } as any).eq("id", alloc.id);
      }
      // Baixa o total do galpão.
      const si = stockItems.find((s) => s.id === k.stock_item_id);
      if (si) {
        await db.from("stock_items").update({
          quantity: Math.max(0, +(si.quantity - toConsume).toFixed(3)),
          updated_by: actor,
        } as any).eq("id", k.stock_item_id);
      }
    }

    // É AQUI que o embarque se fecha: o navio vira EM_OPERACAO, o botão
    // Embarcar some e a aba Retorno abre. Se esta gravação falhar o estoque JÁ
    // foi baixado, então não dá pra dizer "confirmado" e seguir — o navio
    // ficaria agendado pra sempre e alguém embarcaria de novo. Avisa na tela.
    let statusWarn = "";
    if (currentShip.status === "AGENDADO") {
      const upd = (await db.from("ships").update({ status: "EM_OPERACAO" } as any).eq("id", selectedShip)) as any;
      if (upd?.error) {
        statusWarn = ` ⚠️ ATENÇÃO: o estoque foi baixado mas o navio NÃO entrou em operação (${upd.error.message}) — mude o status pra "Em Operação" na aba Navios, senão o Retorno não abre.`;
      }
    }

    setEmbarking(false);
    setConfirmEmbark(false);

    // Aviso automático no grupo do WhatsApp (com a lista preenchida em PDF).
    // Best-effort: o embarque já aconteceu — falha aqui só vira aviso na tela.
    setEmbarkMsg("⚓ Embarque confirmado! Enviando a lista pro WhatsApp...");
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
        setEmbarkMsg(`⚓ Embarque confirmado! 📨 Lista enviada pro WhatsApp (${parts.join(" + ")})${pdfNote}.${statusWarn}`);
      } else if (data?.skipped || data?.warning) {
        setEmbarkMsg(`⚓ Embarque confirmado! ⚠️ ${data.skipped || data.warning}${statusWarn}`);
      } else {
        setEmbarkMsg(`⚓ Embarque confirmado! Não consegui mandar a lista no WhatsApp.${statusWarn}`);
      }
    } catch (err) {
      setEmbarkMsg(`⚓ Embarque confirmado! Erro ao mandar a lista no WhatsApp: ${(err as Error).message}${statusWarn}`);
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
        consumed: (it.consumed_qty || 0) > 0 ? String(it.consumed_qty) : "",
        note: it.note || "",
      };
    }
    setReturnDraft(draft);
    setReturnNotes(existingReturn.notes || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingReturn?.id, returns, selectedShip, selectedTeam]);

  function setDraft(stockItemId: number, patch: Partial<ReturnDraft>) {
    setReturnDraft((prev) => {
      const base: ReturnDraft = prev[stockItemId] ?? { returned: "", broken: "", lost: "", consumed: "", note: "" };
      return { ...prev, [stockItemId]: { ...base, ...patch } };
    });
  }

  // Linhas do retorno preenchidas (voltou/avariado/perdido/obs). Usadas pra
  // salvar e pros avisos. Materiais do kit + comida do Rancho.
  function buildReturnRows() {
    return [...teamKit, ...ranchoReturnables]
      .map((k) => {
        const d = returnDraft[k.stock_item_id] || { returned: "", broken: "", lost: "", consumed: "", note: "" };
        const returned = Math.max(0, Math.floor(parseFloat(d.returned) || 0));
        const broken = Math.max(0, Math.floor(parseFloat(d.broken) || 0));
        const lost = Math.max(0, Math.floor(parseFloat(d.lost) || 0));
        const consumed = Math.max(0, Math.floor(parseFloat(d.consumed) || 0));
        const note = d.note.trim();
        return { k, returned, broken, lost, consumed, note };
      })
      .filter((r) => r.returned > 0 || r.broken > 0 || r.lost > 0 || r.consumed > 0 || r.note);
  }

  // Ocorrências do retorno pro aviso no WhatsApp. A API recebe tudo em
  // `brokenItems` com o `kind` de cada uma (perdido/insumo/avariado) e agrupa
  // em seções — a observação fica só com o texto livre.
  function buildIncidentItems(rows: ReturnType<typeof buildReturnRows>) {
    type Kind = "perdido" | "insumo" | "avariado";
    const out: Array<{ name: string; qty: number; unit: string | null; note: string | null; kind?: Kind }> = [];
    for (const r of rows) {
      const unit = r.k.unit ?? null;
      const note = r.note || null;
      if (r.lost > 0) out.push({ name: r.k.estName, qty: r.lost, unit, note, kind: "perdido" });
      if (r.consumed > 0) out.push({ name: r.k.estName, qty: r.consumed, unit, note, kind: "insumo" });
      if (r.broken > 0) out.push({ name: r.k.estName, qty: r.broken, unit, note, kind: "avariado" });
      // Observação solta (sem quantidade e sem nada de volta) segue valendo como
      // ocorrência — é o jeito de registrar um caso sem número.
      if (r.broken === 0 && r.lost === 0 && r.consumed === 0 && r.returned === 0 && r.note) {
        out.push({ name: r.k.estName, qty: 0, unit, note: r.note });
      }
    }
    return out;
  }

  // Abre o diálogo que pergunta a data de saída do navio antes de confirmar o
  // retorno (é essa data que fecha o navio). Pré-preenche com a saída já
  // cadastrada, ou a data de hoje.
  function openConfirmReturn() {
    if (!currentShip || !selectedTeam) return;
    const rows = buildReturnRows();
    if (rows.length === 0 && !existingReturn) {
      setReturnMsg("Preencha quanto voltou ou quebrou em pelo menos um item.");
      return;
    }
    const today = new Date().toISOString().split("T")[0];
    setCloseDateDraft(
      currentShip.departure_date ? String(currentShip.departure_date).slice(0, 10) : today,
    );
    setReturnMsg(null);
    setConfirmReturnOpen(true);
  }

  async function handleSaveReturn(overrideCloseDate?: string) {
    if (!currentShip || !selectedTeam) return;
    const rows = buildReturnRows();
    if (rows.length === 0 && !existingReturn) {
      setReturnMsg("Preencha quanto voltou ou quebrou em pelo menos um item.");
      return;
    }
    setConfirmReturnOpen(false);
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
      const oldConsumed = new Map<number, number>();
      for (const it of existingReturn?.material_return_items || []) {
        if (it.stock_item_id == null) continue;
        oldReturned.set(it.stock_item_id, it.returned_qty);
        oldBroken.set(it.stock_item_id, it.broken_qty);
        oldLost.set(it.stock_item_id, it.lost_qty || 0);
        oldConsumed.set(it.stock_item_id, it.consumed_qty || 0);
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
          consumed_qty: r.consumed,
          note: r.note || null,
        });
        const itemId = r.k.stock_item_id;
        const returnedDelta = r.returned - (oldReturned.get(itemId) || 0);
        const brokenDelta = r.broken - (oldBroken.get(itemId) || 0);
        const lostDelta = r.lost - (oldLost.get(itemId) || 0);
        const consumedDelta = r.consumed - (oldConsumed.get(itemId) || 0);
        oldReturned.delete(itemId);
        oldBroken.delete(itemId);
        oldLost.delete(itemId);
        oldConsumed.delete(itemId);
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
        // Insumo sai do estoque igual ao avariado (não volta pra prateleira) e,
        // como ele, NÃO custa nada ao navio — é consumo normal (ver despesa só
        // conta o perdido).
        await registerLoss(consumedDelta, "Insumo");

        // Efeito líquido no estoque: crédito do que voltou bom − o que avariou,
        // sumiu e foi consumido (quando o embarque ainda não tinha descontado).
        const stockDelta = returnedDelta - (embarked ? 0 : brokenDelta + lostDelta + consumedDelta);
        if (stockDelta !== 0) {
          await db.from("stock_items").update({
            quantity: Math.max(0, r.k.emEstoque + stockDelta),
            updated_by: actor,
          } as any).eq("id", itemId);
        }
      }

      // Itens que saíram da edição (zerados): estorna o crédito do "voltou" e a
      // baixa de avaria/perda (esta só quando tinha sido baixada aqui, sem embarque).
      const leftoverIds = new Set([...oldReturned.keys(), ...oldBroken.keys(), ...oldLost.keys(), ...oldConsumed.keys()]);
      for (const stockItemId of leftoverIds) {
        const retQty = oldReturned.get(stockItemId) || 0;
        const brokeQty = embarkedIds.has(stockItemId)
          ? 0
          : (oldBroken.get(stockItemId) || 0) + (oldLost.get(stockItemId) || 0) + (oldConsumed.get(stockItemId) || 0);
        const delta = brokeQty - retQty; // devolve avaria/perda/insumo, tira o crédito
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

      // Retorno confirmado FECHA o navio de vez — mesmo fechamento do botão
      // "Fechar" da aba Navios (handleClose), pra não precisar ir lá:
      //   • marca CONCLUIDO + data de saída (departure_date);
      //   • fecha o end_date do(s) job(s) — só assim o navio entra no Financeiro;
      //   • solta a tripulação na hora (senão fica "Embarcado" o resto do dia).
      // Também garante que não haja um 2º retorno (navio sai da lista ativa).
      // Navio JÁ Concluído (fechado antes na aba Navios, sem Retorno) pula tudo
      // isso: aqui só confere o material — e o navio sai da lista pendente.
      if (currentShip.status !== "CONCLUIDO") {
        const closeDate = (overrideCloseDate && overrideCloseDate.slice(0, 10))
          || (currentShip.departure_date ? String(currentShip.departure_date).slice(0, 10) : today);
        // Confere o resultado do fechamento: se um update falhar (ex.: bloqueio
        // de permissão no /api/db), o navio NÃO fecha — avisa em vez de dizer
        // "concluído" sem ter fechado.
        const shipClose: any = await db.from("ships").update({ status: "CONCLUIDO", departure_date: closeDate } as any).eq("id", selectedShip);
        const jobsClose: any = await db.from("jobs").update({ end_date: closeDate } as any).eq("ship_id", selectedShip);
        if (shipClose?.error || jobsClose?.error) {
          const why = shipClose?.error?.message || jobsClose?.error?.message || "erro desconhecido";
          autoNote += ` ⚠️ Não consegui fechar o navio automaticamente (${why}). Feche manualmente em Controle › Navios.`;
        } else {
          try {
            await releaseShipAllocationsNow(selectedShip, actor);
          } catch (err) {
            console.warn("[retorno] release on close failed:", (err as Error).message);
          }
          autoNote += " ✅ Navio concluído (data de saída, Financeiro e tripulação fechados).";
        }
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
        .filter((it) => it.broken_qty > 0 || (it.lost_qty || 0) > 0 || (it.consumed_qty || 0) > 0 || (it.note && it.returned_qty === 0));
      if (lastRows.length > 0) {
        // Unidade não fica gravada no retorno — busca no cadastro do material.
        const unitOf = (id: number | null) => stockItems.find((s) => s.id === id)?.unit || null;
        type Kind = "perdido" | "insumo" | "avariado";
        brokenItems = lastRows.flatMap((it) => {
          const out: Array<{ name: string; qty: number; unit: string | null; note: string | null; kind?: Kind }> = [];
          const unit = unitOf(it.stock_item_id);
          const note = it.note || null;
          if ((it.lost_qty || 0) > 0) out.push({ name: it.item_name, qty: it.lost_qty, unit, note, kind: "perdido" });
          if ((it.consumed_qty || 0) > 0) out.push({ name: it.item_name, qty: it.consumed_qty, unit, note, kind: "insumo" });
          if (it.broken_qty > 0) out.push({ name: it.item_name, qty: it.broken_qty, unit, note, kind: "avariado" });
          if (it.broken_qty === 0 && (it.lost_qty || 0) === 0 && (it.consumed_qty || 0) === 0 && it.note) {
            out.push({ name: it.item_name, qty: 0, unit, note: it.note });
          }
          return out;
        });
        notesToSend = last!.notes;
      }
    }
    if (brokenItems.length === 0) {
      setReturnMsg("Nada de perdido, insumo ou avariado pra enviar — preencha as colunas (ou uma observação), ou salve um retorno com ocorrências.");
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

  // Reenvia a lista de embarque (materiais + rancho, com as quantidades que a
  // equipe leva) pro grupo configurado em Mensagens › "Lista de embarque" —
  // texto + a lista preenchida em PDF (layout do Check List) anexada.
  // O 1º envio é automático no ⚓ Embarcar; aqui é só pra mandar de novo depois.
  async function handleSendEmbarkList() {
    if (!currentShip || !selectedTeam) return;
    if (currentShip.status === "AGENDADO") {
      setEmbarkMsg("⚓ A lista vai pro grupo quando você confirmar o Embarcar — assim o navio entra em operação e o Retorno abre.");
      return;
    }
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
        ships={visibleShips}
        selectedShip={selectedShip}
        onSelect={setSelectedShip}
        showFinished={showFinished}
        onToggleFinished={setShowFinished}
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
            {/* Dá pra embarcar mesmo com item faltando (o operacional pediu essa
                flexibilidade): baixa só o que a equipe tem. Só embarca AGENDADO
                (um embarque por navio); depois vira Em Operação/Concluído.
                A lista só vai pro grupo NO embarque — antes disso não tem botão
                de enviar, senão a equipe recebe a lista e o navio fica agendado
                pra sempre (sem Retorno). Depois de embarcado sobra o reenvio. */}
            {currentShip?.status === "AGENDADO" ? (
              <Button
                size="sm"
                variant="warning"
                onClick={() => setConfirmEmbark(true)}
                title={
                  hasMissing
                    ? `Faltam ${missingNames.length} item(ns) — embarca baixando só o que a equipe tem`
                    : "Baixa o kit e o rancho do Estoque e manda a lista no grupo do WhatsApp"
                }
              >
                ⚓ Embarcar
              </Button>
            ) : (
              <>
                {currentShip?.status === "EM_OPERACAO" && (
                  <Button size="sm" variant="secondary" onClick={handleSendEmbarkList} disabled={sendingEmbarkList || embarking} title="Manda a lista de novo no grupo do WhatsApp com o PDF anexado">
                    {sendingEmbarkList ? "Enviando..." : "📨 Reenviar lista pro WhatsApp"}
                  </Button>
                )}
                <span className="text-xs font-medium px-3 py-2 rounded-lg bg-gray-100 text-text-light">
                  {currentShip?.status === "CONCLUIDO"
                    ? (shipHasReturn(currentShip.id)
                      ? "✅ Navio concluído"
                      : "✅ Navio concluído — falta o Retorno na aba ao lado")
                    : currentShip?.status === "CANCELADO"
                      ? "🚫 Navio cancelado"
                      : "⚓ Já embarcado (Em Operação) — faça o Retorno na aba ao lado"}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {tab === "embarque" && embarkMsg && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-sm text-blue-800">{embarkMsg}</div>
      )}

      {/* Aviso enquanto faltar item: agora é só um alerta (não trava mais o
          Embarcar). Mostra o que falta pra decisão consciente. */}
      {tab === "embarque" && canEmbarcar && selectedTeam && hasMissing && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">⚠️ {missingNames.length} item(ns) sem quantidade pra equipe</p>
          <p className="mt-1 text-xs">{missingSummary}</p>
          <p className="mt-1.5 text-xs text-amber-800">
            Dá pra embarcar assim mesmo — só o que a equipe tem é baixado. Se preferir completar antes,{" "}
            <strong>transfira</strong> o material pra equipe no Almoxarifado (ou reponha o Rancho), ou ajuste o <strong>Leva</strong> deste navio.
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
          onSave={openConfirmReturn}
          onSend={handleSendBroken}
          onDownload={(format) => handleDownloadChecklist("retorno", format)}
          downloading={downloading}
          saving={savingReturn}
          sending={sendingWhats}
          canEdit={canEmbarcar}
          concluded={!!currentShip && !isActiveShip(currentShip) && (currentShip.status !== "CONCLUIDO" || !!existingReturn)}
          closedPendingReturn={!!currentShip && currentShip.status === "CONCLUIDO" && !existingReturn}
          message={returnMsg}
          history={existingReturn ? [existingReturn] : []}
          editing={!!existingReturn}
          renamingId={renamingId}
          renameValue={renameValue}
          savingRename={savingRename}
          onStartRename={(id, name) => { setRenamingId(id); setRenameValue(name); }}
          onChangeRename={setRenameValue}
          onCancelRename={() => setRenamingId(null)}
          onSaveRename={(id) => void handleRenameStock(id)}
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
            <span className="text-xs text-text-light">{matReady} ok · {matMissing} com falta · {teamKitActive.length} itens{teamKitRemoved.length > 0 ? ` · ${teamKitRemoved.length} removido(s)` : ""}</span>
            {canEmbarcar && (
              <Button size="sm" variant="secondary" onClick={() => setAddKind("MATERIAL")} title="Adicionar um item do Estoque só na lista deste navio">
                ➕ Adicionar item
              </Button>
            )}
          </div>
        </div>
        {showMat && (
        <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
          {/* Cabeçalho só no desktop */}
          <div className={`${embarkGrid} bg-gray-50 border-b border-border px-4 py-3 text-xs font-semibold text-text-light uppercase hidden`}>
            <span>Item</span>
            <span className="text-center">Categoria</span>
            <span className="text-center" title="Quanto vai neste navio — editável, sem mexer no kit padrão da equipe">Materiais</span>
            <span className="text-center" title="Quanto deste material está separado pra esta equipe (transferido no Almoxarifado)">{selectedTeam ? TEAM_LABELS[selectedTeam] : "Separado"}</span>
            <span className="text-center">Status</span>
            <span>Obs.</span>
          </div>

          {teamKitActive.length === 0 ? (
            <div className="px-4 py-10 text-center text-text-light">
              <span className="text-3xl block mb-2">🧰</span>
              {teamKit.length === 0 ? "Sem kit de materiais para esta equipe" : "Nenhum material vai neste navio (todos removidos)"}
              {canEmbarcar && <span className="block text-xs mt-1">Use o ➕ Adicionar item pra montar a lista deste navio.</span>}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {teamKitActive.map((k) => (
                <div key={k.id} className={`px-4 py-3 sm:py-2.5 hover:bg-gray-50 flex flex-col gap-2 ${embarkGrid} ${!k.ready ? "bg-red-50/40" : ""}`}>
                  {/* Nome + categoria — juntos no topo no celular; viram colunas no desktop */}
                  <div className="flex items-center justify-between gap-2 sm:contents">
                    {renamingId === k.stock_item_id ? (
                      <span className="flex items-center gap-1 min-w-0">
                        <input
                          type="text"
                          autoFocus
                          value={renameValue}
                          disabled={savingRename}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void handleRenameStock(k.stock_item_id);
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          className="min-w-0 flex-1 px-2 py-1 border border-primary rounded text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/40"
                        />
                        <button type="button" onClick={() => void handleRenameStock(k.stock_item_id)} disabled={savingRename}
                          className="text-xs text-success hover:opacity-70 transition px-1" title="Salvar novo nome">
                          {savingRename ? "…" : "✓"}
                        </button>
                        <button type="button" onClick={() => setRenamingId(null)} disabled={savingRename}
                          className="text-xs text-text-light hover:text-danger transition px-1" title="Cancelar">✕</button>
                      </span>
                    ) : (
                      <span className="font-medium sm:truncate inline-flex items-center gap-1.5 min-w-0">
                        <span className="sm:truncate">{k.estName}</span>
                        {k.added && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold uppercase whitespace-nowrap" title="Item extra — só na lista deste navio">extra</span>
                        )}
                        {canEmbarcar && (
                          <button
                            type="button"
                            onClick={() => { setRenamingId(k.stock_item_id); setRenameValue(k.estName); }}
                            className="text-xs text-text-light hover:text-primary transition shrink-0"
                            title="Renomear este produto no Estoque (muda em todos os navios)"
                          >✏️</button>
                        )}
                      </span>
                    )}
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium whitespace-nowrap sm:justify-self-center">{k.location}</span>
                  </div>

                  {/* Campos — 3 colunas no celular; viram células no desktop */}
                  <div className="grid grid-cols-3 gap-2 sm:contents">
                    <div className="flex flex-col items-center gap-0.5 sm:block sm:text-center text-text-light">
                      <span className="text-[10px] text-text-light uppercase sm:hidden">Materiais</span>
                      {canEmbarcar ? (
                        <span className="inline-flex items-center gap-1">
                          <input
                            type="number" min={0} step="any"
                            value={qtyDraft[k.stock_item_id] ?? String(k.need)}
                            onChange={(e) => setQtyDraft((d) => ({ ...d, [k.stock_item_id]: e.target.value }))}
                            onBlur={() => commitQty("MATERIAL", k.stock_item_id, k.baseNeed)}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                            title={k.added ? "Item extra deste navio" : "Quanto vai deste material neste navio"}
                            className="w-16 px-2 py-1 border border-border rounded text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                          />
                          {k.overridden && (
                            <button
                              type="button"
                              onClick={() => saveOverride("MATERIAL", k.stock_item_id, k.baseNeed, k.baseNeed)}
                              className="text-xs text-text-light hover:text-primary transition"
                              title={`Voltar ao padrão do kit (${k.baseNeed})`}
                            >↺</button>
                          )}
                          {k.added ? (
                            <button
                              type="button"
                              onClick={() => saveOverride("MATERIAL", k.stock_item_id, 0, 0)}
                              className="text-lg font-bold leading-none text-danger hover:text-red-700 transition px-1"
                              title="Tirar este item extra da lista do navio"
                            >✕</button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => saveOverride("MATERIAL", k.stock_item_id, 0, k.baseNeed)}
                              className="text-lg font-bold leading-none text-danger hover:text-red-700 transition px-1"
                              title="Tirar este material da lista deste navio (não vai neste embarque)"
                            >✕</button>
                          )}
                        </span>
                      ) : (
                        k.need
                      )}
                    </div>
                    <div className="flex flex-col items-center gap-0.5 sm:block sm:text-center">
                      <span className="text-[10px] text-text-light uppercase sm:hidden">{selectedTeam ? TEAM_LABELS[selectedTeam] : "Separado"}</span>
                      <span className={`font-bold ${!k.ready ? "text-danger" : "text-success"}`}>{k.emEstoque}</span>
                    </div>
                    <div className="flex flex-col items-center gap-0.5 sm:block sm:text-center">
                      <span className="text-[10px] text-text-light uppercase sm:hidden">Status</span>
                      {k.ready ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium whitespace-nowrap">✓ Ok</span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium whitespace-nowrap">Falta {k.falta}</span>
                      )}
                    </div>
                  </div>
                  {/* Observação por item (igual à aba Retorno) */}
                  {canEmbarcar ? (
                    <input
                      type="text"
                      value={noteDraft[k.stock_item_id] ?? noteOf(k.stock_item_id)}
                      onChange={(e) => setNoteDraft((d) => ({ ...d, [k.stock_item_id]: e.target.value }))}
                      onBlur={() => commitNote("MATERIAL", k.stock_item_id, k.baseNeed)}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      placeholder="Obs.: ..."
                      className="w-full px-2 py-1 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  ) : noteOf(k.stock_item_id) ? (
                    <span className="text-xs text-text-light">{noteOf(k.stock_item_id)}</span>
                  ) : <span />}
                </div>
              ))}
            </div>
          )}
        </div>
        )}
        {/* Removidos deste navio — materiais tirados da lista (Leva 0). Ficam
            aqui pra restaurar com um clique, mesmo quando não têm disponível
            livre (aí não voltariam pelo "Adicionar item"). */}
        {showMat && canEmbarcar && teamKitRemoved.length > 0 && (
          <div className="rounded-xl border border-dashed border-border bg-gray-50 px-4 py-3">
            <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-2">🗑️ Removidos deste navio ({teamKitRemoved.length})</p>
            <div className="flex flex-wrap gap-2">
              {teamKitRemoved.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => saveOverride("MATERIAL", k.stock_item_id, k.added ? 0 : k.baseNeed, k.added ? 0 : k.baseNeed)}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-white border border-border text-text-light hover:text-primary hover:border-primary transition"
                  title={k.added ? "Restaurar este item extra" : `Restaurar (volta ao padrão do kit: ${k.baseNeed})`}
                >
                  ↺ {k.estName}
                </button>
              ))}
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
          {/* Cabeçalho só no desktop */}
          <div className={`${embarkGrid} bg-gray-50 border-b border-border px-4 py-3 text-xs font-semibold text-text-light uppercase hidden`}>
            <span>Item</span>
            <span className="text-center">Categoria</span>
            <span className="text-center" title="Quanto vai neste navio — editável, sem mexer no padrão do Rancho">Padrão</span>
            <span className="text-center">Em Rancho</span>
            <span className="text-center">Status</span>
            <span>Obs.</span>
          </div>

          {itemsWithStatus.length === 0 ? (
            <div className="px-4 py-10 text-center text-text-light">
              <span className="text-3xl block mb-2">🛒</span>
              Nenhum item com quantidade padrão definida
              {canEmbarcar && <span className="block text-xs mt-1">Use o ➕ Adicionar item pra montar a lista deste navio.</span>}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {itemsWithStatus.map((item) => (
                <div key={item.id} className={`px-4 py-3 sm:py-2.5 hover:bg-gray-50 flex flex-col gap-2 ${embarkGrid} ${!item.ready ? "bg-red-50/40" : ""}`}>
                  {/* Nome + categoria — juntos no topo no celular; viram colunas no desktop */}
                  <div className="flex items-center justify-between gap-2 sm:contents">
                    <span className="font-medium sm:truncate">
                      {item.name}
                      {item.added && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold uppercase" title="Item extra — só na lista deste navio">extra</span>
                      )}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium whitespace-nowrap sm:justify-self-center">
                      {item.category === "CARNE" ? "Carne" : item.category === "FEIRA" ? "Feira" : "Suprimentos"}
                    </span>
                  </div>

                  {/* Campos — 3 colunas no celular; viram células no desktop */}
                  <div className="grid grid-cols-3 gap-2 sm:contents">
                    <div className="flex flex-col items-center gap-0.5 sm:block sm:text-center text-text-light">
                      <span className="text-[10px] text-text-light uppercase sm:hidden">Padrão</span>
                      {canEmbarcar ? (
                        <span className="inline-flex items-center gap-1">
                          <input
                            type="number" min={0} step="any"
                            value={qtyDraft[item.id] ?? String(item.default_quantity)}
                            onChange={(e) => setQtyDraft((d) => ({ ...d, [item.id]: e.target.value }))}
                            onBlur={() => commitQty("RANCHO", item.id, item.base_default)}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                            title={item.added ? "Item extra deste navio" : "Quanto vai deste item neste navio"}
                            className="w-16 px-2 py-1 border border-border rounded text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                              className="text-lg font-bold leading-none text-danger hover:text-red-700 transition px-1"
                              title="Tirar este item extra da lista do navio"
                            >✕</button>
                          )}
                        </span>
                      ) : (
                        item.default_quantity
                      )}
                    </div>
                    <div className="flex flex-col items-center gap-0.5 sm:block sm:text-center">
                      <span className="text-[10px] text-text-light uppercase sm:hidden">Em Rancho</span>
                      <span className={`font-bold ${!item.ready ? "text-danger" : "text-success"}`}>{item.quantity}</span>
                    </div>
                    <div className="flex flex-col items-center gap-0.5 sm:block sm:text-center">
                      <span className="text-[10px] text-text-light uppercase sm:hidden">Status</span>
                      {item.ready ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium whitespace-nowrap">✓ Pronto</span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium whitespace-nowrap">Falta {item.falta}</span>
                      )}
                    </div>
                  </div>
                  {/* Observação por item (igual à aba Retorno) */}
                  {canEmbarcar ? (
                    <input
                      type="text"
                      value={noteDraft[item.id] ?? noteOf(item.id)}
                      onChange={(e) => setNoteDraft((d) => ({ ...d, [item.id]: e.target.value }))}
                      onBlur={() => commitNote("RANCHO", item.id, item.base_default)}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      placeholder="Obs.: ..."
                      className="w-full px-2 py-1 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  ) : noteOf(item.id) ? (
                    <span className="text-xs text-text-light">{noteOf(item.id)}</span>
                  ) : <span />}
                </div>
              ))}
            </div>
          )}
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
          availById={availById}
          shipName={currentShip?.name || ""}
          teamLabel={TEAM_LABELS[selectedTeam] || selectedTeam}
          createSetores={addKind === "MATERIAL" ? createSetores : []}
          showValue={canSeeValue}
          allMaterials={stockItems
            .filter((i) => MATERIAL_TEAMS.has(String((i as any).team)))
            .map((i) => ({ name: i.name, team: String((i as any).team) }))}
          onAdd={(stockItemId, qty) => saveOverride(addKind, stockItemId, qty, 0)}
          onCreate={handleCreateStockItem}
          onClose={() => setAddKind(null)}
        />
      )}

      <ConfirmDialog
        open={confirmEmbark}
        onClose={() => setConfirmEmbark(false)}
        onConfirm={handleEmbarcar}
        title="Confirmar Embarque"
        message={`Embarcar ${selectedTeam ? TEAM_LABELS[selectedTeam] : "a equipe"} no navio "${currentShip?.name}"? Os materiais do kit serão baixados do Estoque e a comida do Rancho desta equipe. A lista (com o PDF) vai automático pro grupo do WhatsApp e o navio passa pra Em Operação — aí abre a aba Retorno.${hasMissing ? ` ⚠️ Atenção: ${missingNames.length} item(ns) sem quantidade pra equipe (${missingSummary}) — só o que a equipe tem será baixado.` : ""}`}
        confirmLabel="⚓ Confirmar Embarque"
        variant="warning"
        loading={embarking}
      />

      {/* Confirmar retorno: pede a data de saída do navio, que fecha ele. Navio
          já Concluído (fechado antes na aba Navios) não pede data nenhuma — o
          retorno só confere o material e manda o resumo no WhatsApp. */}
      <Modal open={confirmReturnOpen} onClose={() => setConfirmReturnOpen(false)} title="Confirmar Retorno" maxWidth="max-w-md">
        <div className="space-y-4">
          {currentShip?.status === "CONCLUIDO" ? (
            <p className="text-sm text-text-light">
              Confirmar o retorno de <strong>{selectedTeam ? TEAM_LABELS[selectedTeam] : "a equipe"}</strong> no
              navio <strong>{currentShip?.name}</strong>. O que voltou bom volta pro Estoque — o navio já está
              <strong> Concluído</strong>, então nada muda no fechamento.
            </p>
          ) : (
            <>
              <p className="text-sm text-text-light">
                Confirmar o retorno de <strong>{selectedTeam ? TEAM_LABELS[selectedTeam] : "a equipe"}</strong> no
                navio <strong>{currentShip?.name}</strong>. O que voltou bom volta pro Estoque e o navio é
                <strong> fechado (Concluído)</strong> com a data abaixo.
              </p>
              <div>
                <label className="block text-sm font-medium text-text mb-1">Data de saída do navio</label>
                <input
                  type="date"
                  value={closeDateDraft}
                  onChange={(e) => setCloseDateDraft(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                <p className="text-xs text-text-light mt-1">É essa a data que fecha o navio, entra no Financeiro e solta a tripulação.</p>
              </div>
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="secondary" onClick={() => setConfirmReturnOpen(false)} disabled={savingReturn}>
              Cancelar
            </Button>
            <Button size="sm" onClick={() => handleSaveReturn(closeDateDraft)} disabled={savingReturn || (currentShip?.status !== "CONCLUIDO" && !closeDateDraft)}>
              {savingReturn
                ? "Confirmando..."
                : currentShip?.status === "CONCLUIDO" ? "✅ Confirmar Retorno" : "✅ Confirmar e fechar navio"}
            </Button>
          </div>
        </div>
      </Modal>
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
  onSave, onSend, onDownload, downloading, saving, sending, canEdit, concluded, closedPendingReturn, message, history, editing,
  renamingId, renameValue, savingRename, onStartRename, onChangeRename, onCancelRename, onSaveRename,
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
  // true = navio já concluído (retorno confirmado): campos travados e sem
  // reconfirmar (um retorno por navio).
  concluded: boolean;
  // true = navio fechado direto na aba Navios (Concluído) mas ainda SEM
  // Retorno: os campos seguem editáveis pra fazer o Retorno depois.
  closedPendingReturn: boolean;
  message: string | null;
  history: MaterialReturn[];
  editing: boolean;
  // Renomear o produto no Estoque direto da lista (igual ao Embarque).
  renamingId: number | null;
  renameValue: string;
  savingRename: boolean;
  onStartRename: (stockItemId: number, name: string) => void;
  onChangeRename: (v: string) => void;
  onCancelRename: () => void;
  onSaveRename: (stockItemId: number) => void;
}) {
  const numCls = "w-full sm:w-16 px-2 py-1 border border-border rounded text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary/40";
  // Campos travados: sem permissão OU navio já concluído (um retorno por navio).
  const locked = !canEdit || concluded;
  // Listas recolhíveis: materiais e rancho.
  const [showMat, setShowMat] = useState(true);
  const [showRancho, setShowRancho] = useState(true);

  // Tabela de conferência (mesma mecânica pros materiais e pro rancho; muda só
  // o rótulo do avariado: material "Avariado", comida "Estragou").
  //
  // Três destinos possíveis pro que foi: VOLTOU (bom, credita o estoque),
  // AVARIADO (voltou quebrado — a equipe trouxe, não custa ao navio) e PERDIDO
  // (não voltou — vira despesa do navio, dividida pela equipe).
  // Linha por material. Desktop (sm+) alinha em colunas (grid); no celular vira
  // um cartão: nome em cima, os números numa linha com rótulo, e a Observação em
  // largura total embaixo (antes ficava espremida na rolagem horizontal).
  const renderKitTable = (
    kit: ReturnKitRow[],
    labels: { item: string; broken: string; obsPlaceholder: string; empty: string; emptyIcon: string },
    opts?: { showBrokenLost?: boolean },
  ) => {
    // Rancho (comida) só tem VOLTOU e INSUMO — não faz sentido "estragou"/"perdido"
    // no alimento; o que não voltou foi consumido. Material mantém as 4 colunas.
    const showBL = opts?.showBrokenLost !== false;
    const gridCols = showBL
      ? "sm:grid sm:grid-cols-[minmax(0,1fr)_3rem_4.5rem_4.5rem_4.5rem_4.5rem_minmax(7rem,1.5fr)] sm:items-center sm:gap-2"
      : "sm:grid sm:grid-cols-[minmax(0,1fr)_3rem_4.5rem_4.5rem_minmax(7rem,1.5fr)] sm:items-center sm:gap-2";
    const numGrid = showBL ? "grid grid-cols-5 gap-2 sm:contents" : "grid grid-cols-3 gap-2 sm:contents";
    return (
    <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
      {/* Cabeçalho só no desktop */}
      <div className={`${gridCols} bg-gray-50 border-b border-border px-4 py-3 text-xs font-semibold text-text-light uppercase hidden`}>
        <span>{labels.item}</span>
        <span className="text-center" title="Quanto a equipe leva (referência)">Foi</span>
        <span className="text-center" title="Voltou em bom estado — credita o estoque de volta">Voltou</span>
        {showBL && <span className="text-center" title="Voltou, mas quebrado/estragado — a equipe trouxe de volta; não custa nada ao navio">{labels.broken}</span>}
        {showBL && <span className="text-center" title="Não voltou — vira despesa do navio, dividida pela equipe no Pagamento de Navios">Perdido</span>}
        <span className="text-center" title="Consumido de propósito (graxa, química...) — sai do estoque, mas não custa nada ao navio">Insumo</span>
        <span>Obs.</span>
      </div>

      {kit.length === 0 ? (
        <div className="px-4 py-10 text-center text-text-light">
          <span className="text-3xl block mb-2">{labels.emptyIcon}</span>
          {labels.empty}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {kit.map((k) => {
            const d = draft[k.stock_item_id] || { returned: "", broken: "", lost: "", consumed: "", note: "" };
            return (
              <div key={k.id} className={`px-4 py-3 sm:py-2.5 hover:bg-gray-50 flex flex-col gap-2 ${gridCols}`}>
                {/* Nome — renomeável (muda o produto no Estoque, igual no Embarque) */}
                {renamingId === k.stock_item_id ? (
                  <span className="flex items-center gap-1 min-w-0">
                    <input
                      type="text"
                      autoFocus
                      value={renameValue}
                      disabled={savingRename}
                      onChange={(e) => onChangeRename(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onSaveRename(k.stock_item_id);
                        if (e.key === "Escape") onCancelRename();
                      }}
                      className="min-w-0 flex-1 px-2 py-1 border border-primary rounded text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <button type="button" onClick={() => onSaveRename(k.stock_item_id)} disabled={savingRename}
                      className="text-xs text-success hover:opacity-70 transition px-1" title="Salvar novo nome">
                      {savingRename ? "…" : "✓"}
                    </button>
                    <button type="button" onClick={onCancelRename} disabled={savingRename}
                      className="text-xs text-text-light hover:text-danger transition px-1" title="Cancelar">✕</button>
                  </span>
                ) : (
                  <span className="font-medium sm:truncate inline-flex items-center gap-1.5 min-w-0">
                    <span className="sm:truncate">{k.estName}</span>
                    {canEdit && !concluded && (
                      <button
                        type="button"
                        onClick={() => onStartRename(k.stock_item_id, k.estName)}
                        className="text-xs text-text-light hover:text-primary transition shrink-0"
                        title="Renomear este produto no Estoque (muda em todos os navios)"
                      >✏️</button>
                    )}
                  </span>
                )}

                {/* Números — no celular viram uma linha com rótulos; no desktop, células */}
                <div className={numGrid}>
                  <div className="flex flex-col items-center gap-0.5 sm:block sm:text-center">
                    <span className="text-[10px] text-text-light uppercase sm:hidden">Foi</span>
                    <span className="text-text-light">{k.need}</span>
                  </div>
                  <div className="flex flex-col items-center gap-0.5 sm:block sm:text-center">
                    <span className="text-[10px] text-text-light uppercase sm:hidden">Voltou</span>
                    <input type="number" min={0} step={1} value={d.returned} disabled={locked}
                      onChange={(e) => {
                        const v = e.target.value;
                        const ret = parseInt(v);
                        // O que não voltou (e não foi marcado avariado/perdido) cai
                        // em INSUMO (Foi − Voltou − Avariado − Perdido) — consumo
                        // normal, não custa ao navio. Perdido/Avariado à mão.
                        const bro = parseInt(d.broken) || 0;
                        const lost = parseInt(d.lost) || 0;
                        const consumed = v === "" || isNaN(ret) ? "" : String(Math.max(0, k.need - ret - bro - lost));
                        setDraft(k.stock_item_id, { returned: v, consumed });
                      }}
                      className={numCls} placeholder="0" />
                  </div>
                  {showBL && (
                  <div className="flex flex-col items-center gap-0.5 sm:block sm:text-center">
                    <span className="text-[10px] text-text-light uppercase sm:hidden">{labels.broken}</span>
                    <input type="number" min={0} step={1} value={d.broken} disabled={locked}
                      onChange={(e) => {
                        const v = e.target.value;
                        const bro = parseInt(v) || 0;
                        const lost = parseInt(d.lost) || 0;
                        const ret = parseInt(d.returned);
                        // Marcar avariado tira do INSUMO (o item apareceu, quebrado).
                        const consumed = d.returned === "" || isNaN(ret) ? d.consumed : String(Math.max(0, k.need - ret - bro - lost));
                        setDraft(k.stock_item_id, { broken: v, consumed });
                      }}
                      className={`${numCls} ${(parseInt(d.broken) || 0) > 0 ? "border-amber-300 text-amber-700" : ""}`} placeholder="0" />
                  </div>
                  )}
                  {showBL && (
                  <div className="flex flex-col items-center gap-0.5 sm:block sm:text-center">
                    <span className="text-[10px] text-text-light uppercase sm:hidden">Perdido</span>
                    <input type="number" min={0} step={1} value={d.lost} disabled={locked}
                      onChange={(e) => {
                        const v = e.target.value;
                        const lost = parseInt(v) || 0;
                        const bro = parseInt(d.broken) || 0;
                        const ret = parseInt(d.returned);
                        // Marcar perdido tira do INSUMO (o que sumiu não foi consumo).
                        const consumed = d.returned === "" || isNaN(ret) ? d.consumed : String(Math.max(0, k.need - ret - bro - lost));
                        setDraft(k.stock_item_id, { lost: v, consumed });
                      }}
                      className={`${numCls} ${(parseInt(d.lost) || 0) > 0 ? "border-red-300 text-red-700 font-semibold" : ""}`} placeholder="0" />
                  </div>
                  )}
                  <div className="flex flex-col items-center gap-0.5 sm:block sm:text-center">
                    <span className="text-[10px] text-text-light uppercase sm:hidden">Insumo</span>
                    <input type="number" min={0} step={1} value={d.consumed} disabled={locked}
                      // INSUMO é o balde padrão do que não voltou — edição livre
                      // aqui só ajusta na mão (não recalcula os outros).
                      onChange={(e) => setDraft(k.stock_item_id, { consumed: e.target.value })}
                      className={`${numCls} ${(parseInt(d.consumed) || 0) > 0 ? "border-sky-300 text-sky-700" : ""}`} placeholder="0" />
                  </div>
                </div>

                {/* Observação — largura total no celular */}
                <input type="text" value={d.note} disabled={locked}
                  onChange={(e) => setDraft(k.stock_item_id, { note: e.target.value })}
                  placeholder={labels.obsPlaceholder}
                  className="w-full px-2 py-1 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
              </div>
            );
          })}
        </div>
      )}
    </div>
    );
  };

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-bold text-text uppercase tracking-wider">🛠️ Retorno de material — {TEAM_LABELS[team] || team}</h2>
          <span className="text-xs text-text-light">
            Bom volta pro estoque · o resto vira <span className="text-sky-700">insumo</span> (consumido, não custa) ·{" "}
            <span className="text-amber-700">avariado</span> a equipe trouxe (não custa) ·{" "}
            <span className="text-red-700">perdido</span> vira custo do navio, dividido pela equipe.
          </span>
        </div>

        {concluded ? (
          <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            ✅ Navio finalizado — o retorno já foi fechado (aparece em &ldquo;mostrar finalizados&rdquo;).
            Os campos ficam só pra consulta.
          </p>
        ) : closedPendingReturn ? (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            🏁 Navio já fechado (<strong>Concluído</strong>) — falta o <strong>Retorno</strong> do material.
            Confira abaixo e confirme: o resumo vai pro WhatsApp normalmente e o navio sai desta lista.
          </p>
        ) : editing && (
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
        }, { showBrokenLost: false })}

        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={locked} rows={2}
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
            <Button size="sm" onClick={onSave} disabled={saving || sending || concluded}>
              {saving ? "Confirmando..." : concluded ? "✅ Retorno concluído" : "✅ Confirmar Retorno"}
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
              const consumed = items.filter((it) => (it.consumed_qty || 0) > 0);
              // Observação solta (nada voltou, nada avariou/sumiu/consumiu) entra
              // junto dos avariados pra não sumir do resumo.
              const noteOnly = items.filter(
                (it) => it.broken_qty === 0 && (it.lost_qty || 0) === 0 && (it.consumed_qty || 0) === 0 && it.returned_qty === 0 && it.note,
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
                  {consumed.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {consumed.map((it) => (
                        <li key={`c${it.id}`} className="text-xs text-sky-700">
                          🛢️ Insumo: {it.item_name} ({it.consumed_qty}){it.note ? ` — ${it.note}` : ""}
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
  ships, selectedShip, onSelect, showFinished, onToggleFinished,
}: {
  ships: Ship[];
  selectedShip: string;
  onSelect: (id: string) => void;
  showFinished: boolean;
  onToggleFinished: (v: boolean) => void;
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
    switch (status) {
      case "AGENDADO": return { cls: "bg-blue-100 text-blue-700", label: "Agendado", icon: "📅" };
      case "EM_OPERACAO": return { cls: "bg-amber-100 text-amber-700", label: "Em Operação", icon: "⚓" };
      case "CONCLUIDO": return { cls: "bg-emerald-100 text-emerald-700", label: "Concluído", icon: "✅" };
      case "CANCELADO": return { cls: "bg-red-100 text-red-700", label: "Cancelado", icon: "🚫" };
      default: return { cls: "bg-gray-100 text-gray-700", label: status, icon: "🚢" };
    }
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
                {current.assigned_team && TEAM_LABELS[current.assigned_team] && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-primary/10 text-primary" title="Equipe do navio (aba Navios)">
                    👥 {TEAM_LABELS[current.assigned_team]}
                  </span>
                )}
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
                        {s.assigned_team && TEAM_LABELS[s.assigned_team] && (
                          <span className="text-primary font-medium">👥 {TEAM_LABELS[s.assigned_team]}</span>
                        )}
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
          <div className="px-3 py-2 bg-gray-50 border-t border-border flex items-center justify-between gap-2">
            <span className="text-[10px] text-text-light">
              {ships.length} navio(s) {showFinished ? "(inclui finalizados)" : "(Agendado / Em Operação / aguardando Retorno)"}
            </span>
            <label className="flex items-center gap-1.5 text-[11px] text-text-light cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showFinished}
                onChange={(e) => onToggleFinished(e.target.checked)}
                className="w-3.5 h-3.5"
              />
              Mostrar finalizados
            </label>
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
// Materiais têm ainda a aba "✨ Novo item": o mesmo cadastro do Almoxarifado
// (setor, nome, unidade, quantidade, valor...), só que além de criar o item no
// Estoque ele já entra na lista deste navio (onCreate faz as duas coisas).
function AddItemModal({
  kind, candidates, availById, shipName, teamLabel, createSetores, showValue, allMaterials, onAdd, onCreate, onClose,
}: {
  kind: "MATERIAL" | "RANCHO";
  candidates: StockItem[];
  // Disponível por material (Total − alocado às equipes). Só usado no MATERIAL.
  availById: Map<number, number>;
  shipName: string;
  teamLabel: string;
  // Setores em que o papel pode CRIAR item (vazio = aba "Novo item" escondida).
  createSetores: { key: string; label: string }[];
  showValue: boolean;
  // Nome+setor de TODOS os materiais do Estoque — aviso de duplicado no cadastro.
  allMaterials: { name: string; team: string }[];
  onAdd: (stockItemId: number, qty: number) => Promise<void>;
  onCreate: (data: { setor: string; name: string; unit: string; quantity: number; leva: number; unitValue: number; notes: string | null }) => Promise<void>;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  // Quantidade digitada por item (padrão 1) e trava anti-duplo-clique.
  const [qtyByItem, setQtyByItem] = useState<Record<number, string>>({});
  const [addingId, setAddingId] = useState<number | null>(null);
  const [addedCount, setAddedCount] = useState(0);

  // Aba "Novo item" (só materiais, e só pra quem pode criar item no Almoxarifado).
  const canCreate = kind === "MATERIAL" && createSetores.length > 0;
  const [mode, setMode] = useState<"SEARCH" | "NEW">("SEARCH");
  const [newSetor, setNewSetor] = useState(createSetores[0]?.key || "GALPAO");
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState("UN");
  const [newQty, setNewQty] = useState("");
  // O "Leva" espelha a Quantidade até a pessoa mexer nele (o normal é a compra
  // ir inteira pro navio); mexeu, vale o que foi digitado.
  const [newLeva, setNewLeva] = useState("");
  const [levaTouched, setLevaTouched] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const filtered = candidates.filter((c) => matchSearch(c.name, search));
  const showNew = canCreate && mode === "NEW";

  const nameTrim = newName.trim();
  const qtyNum = parseDecimalBR(newQty);
  const levaStr = levaTouched ? newLeva : newQty;
  const levaNum = parseDecimalBR(levaStr);
  const valueNum = parseDecimalBR(newValue);
  const duplicate = nameTrim
    ? allMaterials.find((m) => normalize(m.name) === normalize(nameTrim)) || null
    : null;
  const levaOk = levaNum > 0 && levaNum <= qtyNum + 1e-9;
  const createValid = !!nameTrim && qtyNum > 0 && levaOk;
  const setorLabelOf = (team: string) =>
    createSetores.find((s) => s.key === team)?.label || MATERIAL_TEAM_LABEL[team] || team;
  const newInputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createValid || creating) return;
    setCreating(true);
    setCreateError(null);
    setCreateMsg(null);
    try {
      await onCreate({
        setor: newSetor,
        name: nameTrim,
        unit: newUnit,
        quantity: qtyNum,
        leva: levaNum,
        unitValue: valueNum,
        notes: newNotes.trim() || null,
      });
      setAddedCount((n) => n + 1);
      setCreateMsg(`✅ ${nameTrim} entrou no Estoque (${setorLabelOf(newSetor)}) e na lista deste navio.`);
      setNewName(""); setNewQty(""); setNewLeva(""); setLevaTouched(false); setNewValue(""); setNewNotes("");
    } catch (err) {
      setCreateError(`Erro ao criar o item: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

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
          {showNew ? (
            <>O item novo é cadastrado no <strong>Estoque do Almoxarifado</strong> e já entra como <strong>extra</strong> na lista do navio <strong>{shipName}</strong> — o kit padrão da equipe não muda.</>
          ) : (
            <>O item entra como <strong>extra</strong> só na lista do navio <strong>{shipName}</strong> — o
            {kind === "MATERIAL" ? " kit padrão da equipe" : " padrão do Rancho"} não muda.</>
          )}
        </p>
        {canCreate && (
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            <button
              type="button"
              onClick={() => setMode("SEARCH")}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs font-semibold transition ${!showNew ? "bg-white text-primary shadow-sm" : "text-text-light hover:text-text"}`}
            >
              🔍 Do Estoque
            </button>
            <button
              type="button"
              onClick={() => setMode("NEW")}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs font-semibold transition ${showNew ? "bg-white text-primary shadow-sm" : "text-text-light hover:text-text"}`}
            >
              ✨ Novo item
            </button>
          </div>
        )}
        {!showNew ? (<>
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
                {canCreate && (
                  <button
                    type="button"
                    onClick={() => { setMode("NEW"); if (search.trim()) setNewName(search.trim()); }}
                    className="block mx-auto mt-2 text-xs font-medium text-primary hover:underline"
                  >
                    ➕ Cadastrar {search.trim() ? `"${search.trim()}"` : "um item novo"} no Estoque e já colocar na lista
                  </button>
                )}
              </div>
            ) : (
              filtered.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <p className="text-[11px] text-text-light">
                      <span className="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium mr-1.5">{badgeOf(c)}</span>
                      {kind === "MATERIAL" ? "disponível" : "no rancho"}: {formatQty(kind === "MATERIAL" ? Math.max(0, availById.get(c.id) ?? c.quantity) : c.quantity)} {unitSuffix(c.unit)}
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
        </>) : (
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-text mb-1">Setor *</label>
            <select value={newSetor} onChange={(e) => setNewSetor(e.target.value)} className={newInputCls}>
              {createSetores.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-text-light">Onde o item fica guardado no Almoxarifado.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-text mb-1">Nome *</label>
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} required className={newInputCls} />
            {duplicate && (
              <p className="mt-1 text-[11px] text-amber-700">
                ⚠️ Já existe <strong>{duplicate.name}</strong> em {setorLabelOf(duplicate.team)} — se for o mesmo produto, use a aba «Do Estoque» pra não duplicar.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text mb-1">Unidade de medida</label>
              <select value={newUnit} onChange={(e) => setNewUnit(e.target.value)} className={newInputCls}>
                {STOCK_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>{u.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-1">Quantidade Atual *</label>
              <input type="text" inputMode="decimal" value={newQty} onChange={(e) => setNewQty(e.target.value)} placeholder="Ex: 8" className={newInputCls} />
              <p className="mt-1 text-[11px] text-text-light">Entra no Total do Estoque.</p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-text mb-1">Leva neste navio *</label>
            <input
              type="text" inputMode="decimal"
              value={levaStr}
              onChange={(e) => { setNewLeva(e.target.value); setLevaTouched(true); }}
              placeholder="Ex: 8"
              className={newInputCls}
            />
            <p className={`mt-1 text-[11px] ${qtyNum > 0 && !levaOk ? "text-amber-700" : "text-text-light"}`}>
              {qtyNum > 0 && !levaOk
                ? `O Leva precisa ser maior que 0 e no máximo ${formatQty(qtyNum)} (a Quantidade).`
                : <>Vai separado pra <strong>{teamLabel}</strong> e entra na lista deste navio; o que sobrar fica no Disponível.</>}
            </p>
          </div>
          {showValue && (
            <div>
              <label className="block text-sm font-medium text-text mb-1">Valor Unitário <span className="text-text-light font-normal">(R$, opcional)</span></label>
              <input type="text" inputMode="decimal" value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="Ex: 24,90" className={newInputCls} />
              {valueNum > 0 && qtyNum > 0 && (
                <p className="text-xs text-text-light mt-1">
                  Total em estoque: <strong>{formatCurrency(valueNum * qtyNum)}</strong>
                </p>
              )}
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-text mb-1">Observações <span className="text-text-light font-normal">(opcional)</span></label>
            <textarea value={newNotes} onChange={(e) => setNewNotes(e.target.value)} rows={2} className={`${newInputCls} resize-none`} />
          </div>
          {createError && <p className="text-xs text-red-600">{createError}</p>}
          {createMsg && !createError && <p className="text-xs text-emerald-700">{createMsg}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={creating || !createValid}>
              {creating ? "Salvando..." : "Salvar e adicionar à lista"}
            </Button>
          </div>
        </form>
        )}
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
