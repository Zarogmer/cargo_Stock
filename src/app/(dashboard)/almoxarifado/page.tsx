"use client";

import { useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";
import { EstoquePanel } from "@/components/almoxarifado/estoque-panel";
import { MateriaisPanel } from "@/components/almoxarifado/materiais-panel";
import { SimpleInventoryPanel } from "@/components/almoxarifado/inventory-simple-panel";
import { ToolsPanel } from "@/components/almoxarifado/tools-panel";
import { HistoricoPanel } from "@/components/almoxarifado/historico-panel";
import { ComprasPanel } from "@/components/almoxarifado/compras-panel";

// Almoxarifado: centraliza Estoque (materiais do galpão), Rancho (comida por
// equipe), EPI, Uniforme, Maquinário em abas únicas. A troca de aba é dirigida
// pelo submenu da sidebar via ?tab= (mesmo padrão das outras telas, com
// hideHeader).
//
// Histórico de nomes (jun/2026): a antiga aba "Estoque" (comida) virou "Rancho"
// e a antiga aba "Ferramentas" (controle de empréstimo) deu lugar à nova aba
// "Estoque" — inventário de materiais com quantidade. O maquinário continua com
// o controle de empréstimo (tabela `tools`).
export default function AlmoxarifadoPage() {
  const searchParams = useSearchParams();
  // Aceita ?tab=ferramentas (link antigo) como atalho pro novo Estoque.
  const rawTab = searchParams.get("tab") || "estoque";
  const initialTab = rawTab === "ferramentas" ? "estoque" : rawTab;

  const tabs = [
    { key: "estoque", label: "Estoque", content: <MateriaisPanel /> },
    { key: "rancho", label: "Rancho", content: <EstoquePanel /> },
    { key: "epi", label: "EPI", content: <SimpleInventoryPanel kind="EPI" /> },
    { key: "uniforme", label: "Uniforme", content: <SimpleInventoryPanel kind="UNIFORME" /> },
    { key: "compras", label: "Compras", content: <ComprasPanel /> },
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
