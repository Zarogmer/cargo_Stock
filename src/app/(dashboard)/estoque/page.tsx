"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// A antiga "/estoque" (comida) virou a aba "Rancho" do Almoxarifado — a aba
// "Estoque" agora é o inventário de materiais. Mantemos a rota antiga como
// redirect pra não quebrar links/bookmarks.
export default function EstoqueRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/almoxarifado?tab=rancho");
  }, [router]);
  return null;
}
