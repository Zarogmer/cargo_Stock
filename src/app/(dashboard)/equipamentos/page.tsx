"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// "Equipamentos" foi absorvido pelo Almoxarifado (abas Ferramentas/Maquinário).
// Mantemos a rota antiga como redirect pra não quebrar links/bookmarks.
export default function EquipamentosRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/almoxarifado?tab=ferramentas");
  }, [router]);
  return null;
}
