"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// "Equipamentos" foi absorvido pelo Almoxarifado. A antiga aba "Ferramentas"
// (empréstimo) deu lugar ao Estoque de materiais; o controle de empréstimo segue
// em "Maquinário". Mantemos a rota antiga como redirect pra não quebrar links.
export default function EquipamentosRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/almoxarifado?tab=maquinario");
  }, [router]);
  return null;
}
