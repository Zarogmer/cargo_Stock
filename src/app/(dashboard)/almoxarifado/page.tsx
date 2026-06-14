"use client";

import { useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";
import { EstoquePanel } from "@/components/almoxarifado/estoque-panel";
import { StockInventoryPanel } from "@/components/almoxarifado/materiais-panel";
import { SimpleInventoryPanel } from "@/components/almoxarifado/inventory-simple-panel";
import { ToolsPanel } from "@/components/almoxarifado/tools-panel";
import { HistoricoPanel } from "@/components/almoxarifado/historico-panel";
import { ComprasPanel } from "@/components/almoxarifado/compras-panel";

// Almoxarifado: a aba "Galpão" agrupa, numa barra de abas no topo da página,
// TODAS as categorias de inventário — Estoque (galpão), Rancho, EPI, Uniforme,
// Maquinário, Ferramenta e Elétrica. Cada categoria mantém suas próprias abas
// internas (ex.: Rancho tem Reserva / Equipe 1 / Equipe 2). Compras e Histórico
// seguem como abas próprias, fora do grupo Estoque.
//
// Dois níveis:
//   • Externo (controlado pelo submenu da sidebar via ?tab=, hideHeader):
//       estoque (grupo) | compras | historico
//   • Interno (barra de abas visível, dentro do grupo Estoque):
//       estoque | rancho | epi | uniforme | maquinario | ferramenta | eletrica
//
// Links antigos continuam válidos: ?tab=rancho, ?tab=epi, ?tab=maquinario,
// ?tab=ferramenta, ?tab=eletrica, ?tab=uniforme caem na aba Estoque já com a
// aba interna correta selecionada (usados pelos cards do Dashboard e pelos
// redirects de /estoque, /equipamentos e /colaboradores).
//
// Histórico de nomes (jun/2026): a antiga aba "Estoque" (comida) virou "Rancho"
// e a antiga aba "Ferramentas" (empréstimo) deu lugar à aba "Estoque" —
// inventário de materiais com quantidade. Ferramenta e Elétrica também são
// inventário (StockInventoryPanel, team sentinela em stock_items). Só o
// Maquinário segue com o controle de empréstimo por equipe (tabela `tools`).

// Chaves das abas internas do grupo Estoque (inventário). A ordem define o que
// aparece na barra de abas, da esquerda pra direita.
const ESTOQUE_KEYS = [
  "estoque",
  "rancho",
  "epi",
  "uniforme",
  "maquinario",
  "ferramenta",
  "eletrica",
];

export default function AlmoxarifadoPage() {
  const searchParams = useSearchParams();
  // Aceita ?tab=ferramentas (link bem antigo da aba de empréstimo) como atalho
  // pro Estoque (galpão).
  const rawTab = searchParams.get("tab") || "estoque";
  const tab = rawTab === "ferramentas" ? "estoque" : rawTab;

  // Qualquer chave de categoria (rancho, epi, …) seleciona o grupo Estoque e a
  // aba interna correspondente. As demais (compras, historico) são abas externas.
  const isEstoque = ESTOQUE_KEYS.includes(tab);
  const outerTab = isEstoque ? "estoque" : tab;
  const innerTab = isEstoque ? tab : "estoque";

  // Abas internas do grupo Estoque — barra de abas visível no topo da página.
  const estoqueTabs = [
    { key: "estoque", label: "Estoque", content: <StockInventoryPanel kind="GALPAO" /> },
    { key: "rancho", label: "Rancho", content: <EstoquePanel /> },
    { key: "epi", label: "EPI", content: <SimpleInventoryPanel kind="EPI" /> },
    { key: "uniforme", label: "Uniforme", content: <SimpleInventoryPanel kind="UNIFORME" /> },
    { key: "maquinario", label: "Maquinário", content: <ToolsPanel assetType="MAQUINARIO" /> },
    { key: "ferramenta", label: "Ferramenta", content: <StockInventoryPanel kind="FERRAMENTA" /> },
    { key: "eletrica", label: "Elétrica", content: <StockInventoryPanel kind="ELETRICA" /> },
  ];

  // Abas externas — dirigidas pelo submenu da sidebar (hideHeader). A aba
  // "Estoque" embute a barra de abas interna acima.
  const outerTabs = [
    { key: "estoque", label: "Galpão", content: <Tabs tabs={estoqueTabs} defaultTab={innerTab} /> },
    { key: "compras", label: "Compras", content: <ComprasPanel /> },
    { key: "historico", label: "Histórico", content: <HistoricoPanel /> },
  ];

  const activeTabLabel = outerTabs.find((t) => t.key === outerTab)?.label;

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

      <Tabs tabs={outerTabs} defaultTab={outerTab} hideHeader />
    </div>
  );
}
