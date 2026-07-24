"use client";

import { useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";
import { EstoquePanel } from "@/components/almoxarifado/estoque-panel";
import { GeralPanel } from "@/components/almoxarifado/geral-panel";
import { StockInventoryPanel } from "@/components/almoxarifado/materiais-panel";
import { SimpleInventoryPanel } from "@/components/almoxarifado/inventory-simple-panel";
import { HistoricoPanel } from "@/components/almoxarifado/historico-panel";
import { ComprasPanel } from "@/components/almoxarifado/compras-panel";

// Almoxarifado: dois grupos agrupam, cada um numa barra de abas no topo da
// página, as categorias de inventário:
//   • Estoque    → Utensílios (galpão), Rancho, Fluídos, Maquinário,
//                  Ferramenta, Elétrica
//   • Funcionário → EPI, Uniforme (itens entregues ao colaborador)
// Cada categoria mantém suas próprias abas internas (ex.: Rancho tem Reserva /
// Equipe 1 / Equipe 2). Compras e Histórico seguem como abas próprias, fora dos
// grupos.
//
// Dois níveis:
//   • Externo (controlado pelo submenu da sidebar via ?tab=, hideHeader):
//       estoque (grupo) | funcionario (grupo) | compras | historico
//   • Interno (barra de abas visível, dentro de cada grupo):
//       estoque: estoque | rancho | fluidos | maquinario | ferramenta | eletrica
//       funcionario: epi | uniforme
//
// Links antigos continuam válidos: ?tab=rancho, ?tab=epi, ?tab=maquinario,
// ?tab=ferramenta, ?tab=eletrica, ?tab=uniforme caem no grupo certo já com a
// aba interna correta selecionada (usados pelos cards do Dashboard e pelos
// redirects de /estoque, /equipamentos e /colaboradores).
//
// Histórico de nomes (jun/2026): a antiga aba "Estoque" (comida) virou "Rancho"
// e a antiga aba "Ferramentas" (empréstimo) deu lugar à aba "Estoque" —
// inventário de materiais com quantidade. Ferramenta, Elétrica, Fluídos e
// Maquinário também são inventário (StockInventoryPanel, team sentinela em
// stock_items). A tabela `tools` (empréstimo por equipe) ficou sem uso.

// Chaves das abas internas de cada grupo. A ordem define o que aparece na barra
// de abas, da esquerda pra direita.
const ESTOQUE_KEYS = [
  "geral",
  "estoque",
  "rancho",
  "fluidos",
  "maquinario",
  "ferramenta",
  "eletrica",
];
const FUNCIONARIO_KEYS = ["epi", "uniforme"];

export default function AlmoxarifadoPage() {
  const searchParams = useSearchParams();
  // Aceita ?tab=ferramentas (link bem antigo da aba de empréstimo) como atalho
  // pro Estoque (galpão).
  const rawTab = searchParams.get("tab") || "geral";
  const tab = rawTab === "ferramentas" ? "estoque" : rawTab;

  // Cada chave de categoria seleciona seu grupo (Estoque ou Funcionário) e a aba
  // interna correspondente. As demais (compras, historico) são abas externas.
  const isEstoque = ESTOQUE_KEYS.includes(tab);
  const isFuncionario = FUNCIONARIO_KEYS.includes(tab);
  const outerTab = isEstoque ? "estoque" : isFuncionario ? "funcionario" : tab;
  const innerEstoque = isEstoque ? tab : "geral";
  const innerFuncionario = isFuncionario ? tab : "epi";

  // Abas internas do grupo Estoque — barra de abas visível no topo da página.
  const estoqueTabs = [
    { key: "geral", label: "Geral", content: <GeralPanel /> },
    { key: "estoque", label: "Utensílios", content: <StockInventoryPanel kind="GALPAO" /> },
    { key: "rancho", label: "Rancho", content: <EstoquePanel /> },
    { key: "fluidos", label: "Fluídos", content: <StockInventoryPanel kind="FLUIDOS" /> },
    { key: "maquinario", label: "Maquinário", content: <StockInventoryPanel kind="MAQUINARIO" /> },
    { key: "ferramenta", label: "Ferramenta", content: <StockInventoryPanel kind="FERRAMENTA" /> },
    { key: "eletrica", label: "Elétrica", content: <StockInventoryPanel kind="ELETRICA" /> },
  ];

  // Abas internas do grupo Funcionário — itens entregues ao colaborador.
  const funcionarioTabs = [
    { key: "epi", label: "EPI", content: <SimpleInventoryPanel kind="EPI" /> },
    { key: "uniforme", label: "Uniforme", content: <SimpleInventoryPanel kind="UNIFORME" /> },
  ];

  // Abas externas — dirigidas pelo submenu da sidebar (hideHeader). Os grupos
  // "Estoque" e "Funcionário" embutem suas barras de abas internas acima.
  const outerTabs = [
    { key: "estoque", label: "Estoque", content: <Tabs tabs={estoqueTabs} defaultTab={innerEstoque} /> },
    { key: "funcionario", label: "Funcionário", content: <Tabs tabs={funcionarioTabs} defaultTab={innerFuncionario} /> },
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
