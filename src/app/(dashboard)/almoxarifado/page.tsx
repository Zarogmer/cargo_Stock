"use client";

import { useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";
import { EstoquePanel } from "@/components/almoxarifado/estoque-panel";
import { SimpleInventoryPanel } from "@/components/almoxarifado/inventory-simple-panel";
import { ToolsPanel } from "@/components/almoxarifado/tools-panel";
import { HistoricoPanel } from "@/components/almoxarifado/historico-panel";

// Almoxarifado: centraliza Estoque (suprimentos), EPI, Uniforme, Ferramentas e
// Maquinário em abas únicas. A troca de aba é dirigida pelo submenu da sidebar
// via ?tab= (mesmo padrão das outras telas, com hideHeader).
export default function AlmoxarifadoPage() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") || "estoque";

  const tabs = [
    { key: "estoque", label: "Estoque", content: <EstoquePanel /> },
    { key: "epi", label: "EPI", content: <SimpleInventoryPanel kind="EPI" /> },
    { key: "uniforme", label: "Uniforme", content: <SimpleInventoryPanel kind="UNIFORME" /> },
    { key: "ferramentas", label: "Ferramentas", content: <ToolsPanel assetType="FERRAMENTA" /> },
    { key: "maquinario", label: "Maquinário", content: <ToolsPanel assetType="MAQUINARIO" /> },
    { key: "historico", label: "Histórico", content: <HistoricoPanel /> },
  ];

  const activeTabLabel = tabs.find((t) => t.key === initialTab)?.label;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h1 className="text-2xl font-bold text-text">Almoxarifado</h1>
        {activeTabLabel && (
          <>
            <span className="text-text-light">›</span>
            <span className="text-lg font-semibold text-text-light">{activeTabLabel}</span>
          </>
        )}
      </div>

      <Tabs tabs={tabs} defaultTab={initialTab} hideHeader />
    </div>
  );
}
