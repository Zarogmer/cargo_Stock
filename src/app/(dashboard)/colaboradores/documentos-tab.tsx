"use client";

import { useSearchParams } from "next/navigation";
import type { Employee } from "@/types/database";
import { DdsSubTab } from "./dds-sub-tab";
import { FichaEpiSubTab } from "./ficha-epi-sub-tab";
import { AvisoMedicoSubTab } from "./aviso-medico-sub-tab";
import { ReciboPagamentoSubTab } from "./recibo-pagamento-sub-tab";

type SubTabKey = "dds" | "ficha-epi" | "aviso-medico" | "recibo-pagamento";

function parseDoc(raw: string | null): SubTabKey {
  if (raw === "ficha-epi" || raw === "aviso-medico" || raw === "recibo-pagamento" || raw === "dds") return raw;
  return "dds";
}

export function DocumentosTab({ employees }: { employees: Employee[] }) {
  const searchParams = useSearchParams();
  const active = parseDoc(searchParams.get("doc"));

  if (active === "ficha-epi") return <FichaEpiSubTab employees={employees} />;
  if (active === "aviso-medico") return <AvisoMedicoSubTab employees={employees} />;
  if (active === "recibo-pagamento") return <ReciboPagamentoSubTab employees={employees} />;
  return <DdsSubTab employees={employees} />;
}
