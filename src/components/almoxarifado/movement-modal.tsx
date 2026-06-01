"use client";

import { useState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import type { Employee } from "@/types/database";

// Modal de entrega/devolução de EPI ou Uniforme — escolhe o colaborador,
// quantidade e observação. Movido de colaboradores/page.tsx para ser
// reaproveitado pelos painéis do Almoxarifado.
export function MovementModal({
  open, onClose, onConfirm, title, saving, employees,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (emp: string, qty: number, notes: string) => void;
  title: string;
  saving: boolean;
  employees: Employee[];
}) {
  const [empName, setEmpName] = useState("");
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");

  useEffect(() => { setEmpName(""); setQty(1); setNotes(""); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(empName, qty, notes); }} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Colaborador *</label>
          <select value={empName} onChange={(e) => setEmpName(e.target.value)} required className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none">
            <option value="">Selecione...</option>
            {employees.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
          </select>
        </div>
        <div><label className="block text-sm font-medium mb-1">Quantidade</label><input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} min={1} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        <div><label className="block text-sm font-medium mb-1">Observações</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none" /></div>
        <div className="flex gap-3 justify-end pt-2"><Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={saving}>{saving ? "Registrando..." : "Confirmar"}</Button></div>
      </form>
    </Modal>
  );
}
