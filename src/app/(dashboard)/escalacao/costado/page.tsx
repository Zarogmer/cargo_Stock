"use client";

import { EscalacaoCrewPage } from "@/components/escalacao/escalacao-crew-page";

export default function EscalacaoCostadoPage() {
  return (
    <EscalacaoCrewPage
      config={{ kind: "COSTADO", title: "Escalação de Costado", emoji: "🧽" }}
    />
  );
}
