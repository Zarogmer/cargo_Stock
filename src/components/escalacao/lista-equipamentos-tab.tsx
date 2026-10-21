"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatQty, matchSearch, parseDecimalBR } from "@/lib/utils";
import { embarkSeq, MATERIAL_TEAMS, MATERIAL_TEAM_LABEL } from "@/lib/embark-order";

// Controle › Lista de Equipamentos: o kit PADRÃO de materiais que cada equipe
// leva ao navio (embark_kit_items). É a lista que o Checklist (Embarque e
// Retorno), o PDF/WhatsApp de embarque e a Petição carregam como ponto de
// partida. O ajuste por navio continua no Checklist (embark_list_overrides);
// aqui muda o padrão — vale pra todos os navios daqui em diante.
//
// "Equipe normal" = Equipes 1 e 2: sempre a MESMA lista (a 2 nasceu como cópia
// da 1 no import do Check List), então o que se salva aqui grava nas duas.
// "Equipe Turbo" = EQUIPE_4 (leva mais de quase tudo).

interface KitRow {
  id: number;
  team: string;
  stock_item_id: number;
  quantity: number;
  stock_items: { id: number; name: string; location: string | null; unit: string | null; team: string | null } | null;
}

interface Material {
  id: number;
  name: string;
  team: string | null;
  location: string | null;
  unit: string | null;
  quantity: number;
}

const GROUPS = [
  { key: "NORMAL", label: "Equipe normal", hint: "Equipes 1 e 2", teams: ["EQUIPE_1", "EQUIPE_2"] },
  { key: "TURBO", label: "Equipe Turbo", hint: "Equipe 4", teams: ["EQUIPE_4"] },
] as const;
type GroupKey = (typeof GROUPS)[number]["key"];

const sectorLabel = (m: { location: string | null; team: string | null } | null | undefined): string =>
  m?.location || MATERIAL_TEAM_LABEL[String(m?.team)] || "—";

// Nº · Item · Setor · Quantidade · ✕ (desktop); no celular vira cartão.
const GRID = "sm:grid sm:grid-cols-[2.5rem_minmax(0,1fr)_7rem_8rem_2.5rem] sm:items-center sm:gap-2";

export function ListaEquipamentosTab() {
  const { profile } = useAuth();
  const role = profile?.role || "RH";
  // Mesma régua do Checklist: quem embarca é quem ajusta o kit padrão.
  const canEdit = hasPermission(role, "EMBARQUE", "embarcar");

  const [kit, setKit] = useState<KitRow[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<GroupKey>("NORMAL");
  // Quantidade digitada por item (chave: stock_item_id) até o blur gravar.
  const [qtyDraft, setQtyDraft] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ stockItemId: number; name: string } | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [kitRes, matRes] = await Promise.all([
        db.from("embark_kit_items").select("*, stock_items(id, name, location, unit, team)"),
        db.from("stock_items").select("id, name, team, location, unit, quantity").in("team", [...MATERIAL_TEAMS]).order("name"),
      ]);
      if (kitRes.error) throw new Error(kitRes.error.message);
      if (matRes.error) throw new Error(matRes.error.message);
      setKit((kitRes.data as KitRow[]) || []);
      setMaterials((matRes.data as Material[]) || []);
    } catch (err) {
      setError(`Erro ao carregar a lista: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const current = GROUPS.find((g) => g.key === group) ?? GROUPS[0];
  const teams: readonly string[] = current.teams;
  // A tela mostra a 1ª equipe do grupo (normal = Equipe 1); salvar grava em todas.
  const displayTeam = teams[0];

  const rowFor = useCallback(
    (team: string, stockItemId: number) => kit.find((k) => k.team === team && k.stock_item_id === stockItemId),
    [kit],
  );

  const rows = useMemo(
    () =>
      kit
        .filter((k) => k.team === displayTeam)
        .map((k) => ({
          stock_item_id: k.stock_item_id,
          name: k.stock_items?.name || `#${k.stock_item_id}`,
          sector: sectorLabel(k.stock_items),
          unit: k.stock_items?.unit || null,
          quantity: k.quantity,
        }))
        .sort((a, b) => {
          const d = embarkSeq(a.name) - embarkSeq(b.name);
          return d !== 0 ? d : a.name.localeCompare(b.name, "pt-BR");
        }),
    [kit, displayTeam],
  );
  const totalQty = rows.reduce((s, r) => s + r.quantity, 0);
  const listedIds = useMemo(() => new Set(rows.map((r) => r.stock_item_id)), [rows]);

  // Equipe 2 fora de sincronia com a Equipe 1 (só no grupo normal): itens com
  // quantidade diferente ou que só existem numa das duas. Não deveria
  // acontecer (tudo aqui grava nas duas), mas um script/ajuste à mão pode
  // desalinhar — aí a tela avisa e oferece igualar.
  const divergent = useMemo(() => {
    if (group !== "NORMAL") return 0;
    const e1 = new Map(kit.filter((k) => k.team === "EQUIPE_1").map((k) => [k.stock_item_id, k.quantity]));
    const e2 = new Map(kit.filter((k) => k.team === "EQUIPE_2").map((k) => [k.stock_item_id, k.quantity]));
    let n = 0;
    for (const id of new Set([...e1.keys(), ...e2.keys()])) if (e1.get(id) !== e2.get(id)) n++;
    return n;
  }, [kit, group]);

  function flash(text: string) {
    setError(null);
    setMsg(text);
  }

  // Grava a quantidade de um item em TODAS as equipes do grupo (upsert por
  // equipe+item — a linha pode não existir ainda numa delas).
  async function writeQty(stockItemId: number, qty: number) {
    for (const team of teams) {
      const existing = rowFor(team, stockItemId);
      const res: any = existing
        ? await db.from("embark_kit_items").update({ quantity: qty }).eq("id", existing.id)
        : await db.from("embark_kit_items").insert({ team, stock_item_id: stockItemId, quantity: qty });
      if (res?.error) throw new Error(res.error.message);
    }
  }

  async function commitQty(stockItemId: number) {
    const raw = qtyDraft[stockItemId];
    if (raw == null) return;
    setQtyDraft((d) => { const n = { ...d }; delete n[stockItemId]; return n; });
    const row = rows.find((r) => r.stock_item_id === stockItemId);
    if (!row) return;
    const qty = parseDecimalBR(raw);
    if (!(qty > 0)) {
      if (raw.trim() !== "") setError("Quantidade precisa ser maior que zero — pra tirar o item da lista use o ✕.");
      return;
    }
    if (qty === row.quantity) return;
    setSaving(true);
    try {
      await writeQty(stockItemId, qty);
      await load();
      flash(`✅ ${row.name}: ${formatQty(qty)} na lista da ${current.label}.`);
    } catch (err) {
      setError(`Erro ao salvar: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!removeTarget) return;
    setSaving(true);
    try {
      const res: any = await db.from("embark_kit_items").delete().in("team", [...teams]).eq("stock_item_id", removeTarget.stockItemId);
      if (res?.error) throw new Error(res.error.message);
      await load();
      flash(`🗑️ ${removeTarget.name} saiu da lista da ${current.label}.`);
    } catch (err) {
      setError(`Erro ao remover: ${(err as Error).message}`);
    } finally {
      setSaving(false);
      setRemoveTarget(null);
    }
  }

  async function handleAdd(stockItemId: number, qty: number) {
    await writeQty(stockItemId, qty);
    await load();
  }

  // Renomear muda o nome do produto no Estoque (stock_items) — vale em todo o
  // sistema (Almoxarifado, Checklist, PDF, Petição), igual ao ✏️ do Checklist.
  async function handleRename(stockItemId: number) {
    const name = renameValue.trim();
    const before = materials.find((m) => m.id === stockItemId)?.name || "";
    if (!name || name === before) { setRenamingId(null); return; }
    setSaving(true);
    try {
      const res: any = await db
        .from("stock_items")
        .update({ name, updated_by: profile?.full_name || "Sistema" })
        .eq("id", stockItemId);
      if (res?.error) throw new Error(res.error.message);
      setRenamingId(null);
      await load();
      flash(`✏️ "${before}" agora se chama "${name}" (no Estoque e em todas as listas).`);
    } catch (err) {
      setError(`Erro ao renomear: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  // Igualar Equipe 2 à Equipe 1: upsert de tudo da 1 na 2 e apaga o que só
  // existe na 2.
  async function syncTeam2() {
    setSaving(true);
    try {
      const e1 = kit.filter((k) => k.team === "EQUIPE_1");
      const e2 = kit.filter((k) => k.team === "EQUIPE_2");
      const e1Ids = new Set(e1.map((k) => k.stock_item_id));
      for (const k of e1) {
        const ex = e2.find((x) => x.stock_item_id === k.stock_item_id);
        const res: any = !ex
          ? await db.from("embark_kit_items").insert({ team: "EQUIPE_2", stock_item_id: k.stock_item_id, quantity: k.quantity })
          : ex.quantity !== k.quantity
            ? await db.from("embark_kit_items").update({ quantity: k.quantity }).eq("id", ex.id)
            : null;
        if (res?.error) throw new Error(res.error.message);
      }
      const orphans = e2.filter((k) => !e1Ids.has(k.stock_item_id)).map((k) => k.id);
      if (orphans.length > 0) {
        const res: any = await db.from("embark_kit_items").delete().in("id", orphans);
        if (res?.error) throw new Error(res.error.message);
      }
      await load();
      flash("✅ Equipe 2 igualada à Equipe 1.");
    } catch (err) {
      setError(`Erro ao igualar: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-text-light max-w-3xl">
          Kit padrão de materiais que cada equipe leva ao navio — é a lista que o Checklist (Embarque e Retorno),
          o PDF/WhatsApp de embarque e a Petição carregam. O ajuste de um navio específico continua no Checklist;
          o que mudar aqui vale pra todos os próximos navios.
        </p>
        {canEdit && (
          <Button size="sm" variant="primary" onClick={() => setAddOpen(true)} disabled={loading}>
            ➕ Adicionar material
          </Button>
        )}
      </div>

      {/* Equipe normal (1 e 2) × Equipe Turbo */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border bg-gray-50 p-0.5">
          {GROUPS.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => { setGroup(g.key); setMsg(null); setError(null); setRenamingId(null); }}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${group === g.key ? "bg-white shadow-sm text-primary" : "text-text-light hover:text-text"}`}
            >
              {g.label} <span className="text-[11px] font-normal opacity-70">· {g.hint}</span>
            </button>
          ))}
        </div>
        <span className="text-xs text-text-light">
          {rows.length} ite{rows.length === 1 ? "m" : "ns"} · {formatQty(totalQty)} unidades no total
        </span>
      </div>

      {group === "NORMAL" && divergent > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-800 flex flex-wrap items-center justify-between gap-2">
          <span>⚠️ A Equipe 2 está diferente da Equipe 1 em {divergent} ite{divergent === 1 ? "m" : "ns"}. A tela mostra a Equipe 1; salvar um item aqui grava nas duas.</span>
          {canEdit && (
            <Button size="sm" variant="warning" onClick={() => void syncTeam2()} disabled={saving}>
              Igualar Equipe 2 à Equipe 1
            </Button>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 flex justify-between items-start gap-2">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-red-500 hover:text-red-700 font-bold shrink-0">✕</button>
        </div>
      )}
      {msg && (
        <div className="bg-emerald-50 border border-emerald-300 rounded-lg p-3 text-sm text-emerald-700 flex justify-between items-start gap-2">
          <span>{msg}</span>
          <button type="button" onClick={() => setMsg(null)} className="text-emerald-500 hover:text-emerald-700 font-bold shrink-0">✕</button>
        </div>
      )}

      <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
        <div className={`${GRID} bg-gray-50 border-b border-border px-4 py-3 text-xs font-semibold text-text-light uppercase hidden`}>
          <span className="text-center">Nº</span>
          <span>Item</span>
          <span className="text-center">Setor</span>
          <span className="text-center" title="Quanto a equipe leva por padrão — editável">Quantidade</span>
          <span />
        </div>

        {loading ? (
          <div className="px-4 py-10 text-center text-text-light">Carregando…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-text-light">
            <span className="text-3xl block mb-2">🧰</span>
            Sem kit cadastrado pra {current.label}.
            {canEdit && <span className="block text-xs mt-1">Use o ➕ Adicionar material pra montar a lista.</span>}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r, i) => (
              <div key={r.stock_item_id} className={`px-4 py-3 sm:py-2 hover:bg-gray-50 flex flex-col gap-2 ${GRID}`}>
                <div className="flex items-center justify-between gap-2 sm:contents">
                  <span className="hidden sm:block text-xs text-text-light text-center">{i + 1}</span>
                  {renamingId === r.stock_item_id ? (
                    <span className="flex items-center gap-1 min-w-0 flex-1">
                      <input
                        type="text"
                        autoFocus
                        value={renameValue}
                        disabled={saving}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleRename(r.stock_item_id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="min-w-0 flex-1 px-2 py-1 border border-primary rounded text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/40"
                      />
                      <button type="button" onClick={() => void handleRename(r.stock_item_id)} disabled={saving}
                        className="text-xs text-success hover:opacity-70 transition px-1" title="Salvar novo nome">
                        {saving ? "…" : "✓"}
                      </button>
                      <button type="button" onClick={() => setRenamingId(null)} disabled={saving}
                        className="text-xs text-text-light hover:text-danger transition px-1" title="Cancelar">✕</button>
                    </span>
                  ) : (
                    <span className="font-medium inline-flex items-center gap-1.5 min-w-0">
                      <span className="sm:hidden text-xs text-text-light">{i + 1}.</span>
                      <span className="sm:truncate">{r.name}</span>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => { setRenamingId(r.stock_item_id); setRenameValue(r.name); }}
                          className="text-xs text-text-light hover:text-primary transition shrink-0"
                          title="Renomear este produto no Estoque (muda em todas as listas e navios)"
                        >✏️</button>
                      )}
                    </span>
                  )}
                  <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium whitespace-nowrap sm:justify-self-center">{r.sector}</span>
                </div>

                <div className="flex items-center justify-between gap-2 sm:contents">
                  <span className="text-[10px] text-text-light uppercase sm:hidden">Quantidade</span>
                  <span className="inline-flex items-center gap-1 sm:justify-self-center">
                    {canEdit ? (
                      <input
                        type="number" min={0} step="any"
                        value={qtyDraft[r.stock_item_id] ?? String(r.quantity)}
                        disabled={saving}
                        onChange={(e) => setQtyDraft((d) => ({ ...d, [r.stock_item_id]: e.target.value }))}
                        onBlur={() => void commitQty(r.stock_item_id)}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        title={`Quanto a ${current.label} leva por padrão`}
                        className="w-20 px-2 py-1 border border-border rounded text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    ) : (
                      <span className="font-bold text-text">{formatQty(r.quantity)}</span>
                    )}
                    {r.unit && r.unit.toUpperCase() !== "UN" && <span className="text-xs text-text-light">{r.unit.toLowerCase()}</span>}
                  </span>
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => setRemoveTarget({ stockItemId: r.stock_item_id, name: r.name })}
                      disabled={saving}
                      className="text-lg font-bold leading-none text-danger hover:text-red-700 transition px-1 sm:justify-self-end"
                      title={`Tirar da lista padrão da ${current.label}`}
                    >✕</button>
                  ) : <span />}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && rows.length > 0 && (
          <div className="px-4 py-2 bg-gray-50 border-t border-border text-xs text-text-light flex justify-between">
            <span>{rows.length} ite{rows.length === 1 ? "m" : "ns"}</span>
            <span>Total: <b className="text-text">{formatQty(totalQty)}</b></span>
          </div>
        )}
      </div>

      <p className="text-[11px] text-text-light">
        A ordem é a do formulário oficial de embarque (a mesma do Checklist). Navios que já embarcaram não mudam;
        o que estiver aberto no Checklist passa a carregar a lista nova.
      </p>

      {addOpen && (
        <AddMaterialModal
          groupLabel={current.label}
          candidates={materials.filter((m) => !listedIds.has(m.id))}
          onAdd={handleAdd}
          onClose={() => setAddOpen(false)}
        />
      )}

      <ConfirmDialog
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => void handleRemove()}
        title="Tirar da lista padrão"
        message={`Tirar "${removeTarget?.name}" da lista padrão da ${current.label}? Deixa de ir nos próximos navios desta equipe (dá pra voltar pelo ➕ Adicionar material).`}
        loading={saving}
      />
    </div>
  );
}

// ─── Adicionar material do Estoque à lista padrão ────────────────────────────
// Busca nos materiais do Almoxarifado (setores de material, sem Rancho) que
// ainda não estão na lista; quantidade por item (padrão 1). O modal fica aberto
// depois de adicionar, pra incluir vários de uma vez (o item some da busca
// porque entrou na lista).
function AddMaterialModal({
  groupLabel, candidates, onAdd, onClose,
}: {
  groupLabel: string;
  candidates: Material[];
  onAdd: (stockItemId: number, qty: number) => Promise<void>;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [qtyByItem, setQtyByItem] = useState<Record<number, string>>({});
  const [addingId, setAddingId] = useState<number | null>(null);
  const [addedCount, setAddedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const filtered = candidates.filter((c) => matchSearch(c.name, search));

  async function handleAdd(c: Material) {
    const qty = parseDecimalBR(qtyByItem[c.id] ?? "1");
    if (!(qty > 0)) { setError("Informe uma quantidade maior que zero."); return; }
    setAddingId(c.id);
    setError(null);
    try {
      await onAdd(c.id, qty);
      setAddedCount((n) => n + 1);
    } catch (err) {
      setError(`Erro ao adicionar: ${(err as Error).message}`);
    } finally {
      setAddingId(null);
    }
  }

  return (
    <Modal open onClose={onClose} title={`➕ Adicionar material — ${groupLabel}`} maxWidth="max-w-2xl">
      <div className="space-y-3">
        <p className="text-xs text-text-light">
          Materiais do Almoxarifado que ainda não estão na lista padrão da {groupLabel}. Entra pra todos os próximos navios desta equipe.
        </p>
        <input
          type="text"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar material…"
          className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        {addedCount > 0 && <p className="text-xs text-emerald-700">✅ {addedCount} ite{addedCount === 1 ? "m adicionado" : "ns adicionados"} à lista.</p>}
        <div className="max-h-[50vh] overflow-y-auto border border-border rounded-lg divide-y divide-border">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-text-light">
              {candidates.length === 0 ? "Todo material do Almoxarifado já está na lista." : "Nenhum material encontrado."}
            </p>
          ) : (
            filtered.map((c) => (
              <div key={c.id} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text truncate">{c.name}</p>
                  <p className="text-[11px] text-text-light">{sectorLabel(c)} · {formatQty(c.quantity)} no Almoxarifado</p>
                </div>
                <input
                  type="number" min={0} step="any"
                  value={qtyByItem[c.id] ?? "1"}
                  onChange={(e) => setQtyByItem((d) => ({ ...d, [c.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleAdd(c); }}
                  className="w-16 px-2 py-1 border border-border rounded text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  title="Quanto a equipe leva por padrão"
                />
                <Button size="sm" variant="primary" onClick={() => void handleAdd(c)} disabled={addingId === c.id}>
                  {addingId === c.id ? "…" : "Adicionar"}
                </Button>
              </div>
            ))
          )}
        </div>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>Fechar</Button>
        </div>
      </div>
    </Modal>
  );
}
