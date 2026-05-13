"use client";

import { EscalacaoCrewPage } from "@/components/escalacao/escalacao-crew-page";

export default function EscalacaoEmbarquePage() {
  return (
    <EscalacaoCrewPage
      config={{ kind: "EMBARQUE", title: "Escalação de Embarque", emoji: "⚓" }}
    />
  );
}
