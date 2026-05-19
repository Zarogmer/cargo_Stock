"use client";

import { useState } from "react";
import type { Employee } from "@/types/database";
import { DdsSubTab } from "./dds-sub-tab";
import { FichaEpiSubTab } from "./ficha-epi-sub-tab";
import { AvisoMedicoSubTab } from "./aviso-medico-sub-tab";

type SubTabKey = "dds" | "ficha-epi" | "aviso-medico";

const SUB_TABS: { key: SubTabKey; label: string }[] = [
  { key: "dds", label: "DDS" },
  { key: "ficha-epi", label: "Ficha de EPI" },
  { key: "aviso-medico", label: "Aviso Médico" },
];

export function DocumentosTab({ employees }: { employees: Employee[] }) {
  const [active, setActive] = useState<SubTabKey>("dds");

  return (
    <div className="space-y-4">
      <div className="flex overflow-x-auto border-b border-border gap-1 -mx-4 px-4 md:mx-0 md:px-0">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition shrink-0 ${
              active === t.key
                ? "border-primary text-primary"
                : "border-transparent text-text-light hover:text-text hover:border-gray-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active === "dds" && <DdsSubTab employees={employees} />}
      {active === "ficha-epi" && <FichaEpiSubTab employees={employees} />}
      {active === "aviso-medico" && <AvisoMedicoSubTab employees={employees} />}
    </div>
  );
}
