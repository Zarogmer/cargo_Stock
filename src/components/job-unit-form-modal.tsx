"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { normalizeUnit, unitLabel, normalizePayMode, PAY_MODE_LABELS, type UnitPayMode } from "@/lib/jobUnits";
import type { WorkUnit } from "@/types/database";

// Modal de criar/editar UNIDADE (o grupo/seção das funções). Só nome + descrição.
// Grava na tabela job_units. Usado tanto no Valores (Financeiro) quanto nas
// Funções (RH) — a unidade é a mesma coisa nos dois lugares.
export function UnitFormModal({
  open, item, onClose, onSaved,
}: {
  open: boolean;
  item: WorkUnit | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [payMode, setPayMode] = useState<UnitPayMode>("PORAO");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (item) {
      setName(item.name);
      setDescription(item.description || "");
      setPayMode(normalizePayMode(item.pay_mode));
    } else {
      setName("");
      setDescription("");
      setPayMode("PORAO");
    }
    setError(null);
  }, [item, open]);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const clean = normalizeUnit(name);
    if (!clean) return;
    setSaving(true);
    setError(null);
    const payload = { name: clean, description: description.trim() || null, pay_mode: payMode };
    const res = item
      ? await db.from("job_units").update(payload).eq("id", item.id)
      : await db.from("job_units").insert(payload);
    setSaving(false);
    if (res.error) {
      setError(/uniqu|duplicat|already exists/i.test(res.error.message)
        ? "Já existe uma unidade com esse nome."
        : res.error.message);
      return;
    }
    onSaved();
  }

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Unidade" : "Nova Unidade"}>
      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Nome da unidade *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            required
            autoFocus
            className={inputCls}
            placeholder="EMBARQUE, COSTADO, MENSALISTA..."
          />
          {name.trim() && (
            <p className="text-[11px] text-text-light mt-1">
              Vira a seção <strong>{unitLabel(normalizeUnit(name))}</strong> na lista.
            </p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Como será o pagamento? *</label>
          <select
            value={payMode}
            onChange={(e) => setPayMode(e.target.value as UnitPayMode)}
            className={inputCls}
          >
            {(Object.keys(PAY_MODE_LABELS) as UnitPayMode[]).map((m) => (
              <option key={m} value={m}>{PAY_MODE_LABELS[m]}</option>
            ))}
          </select>
          <p className="text-[11px] text-text-light mt-1">
            Por porão e por turno entram na escala do navio. Mensalidade é valor fixo (fica fora da escala).
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Descrição</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={inputCls}
            placeholder="Opcional — ex.: Pago por porão"
          />
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving || !name.trim()}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}
