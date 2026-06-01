"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// "Estoque" virou a aba "Estoque" do Almoxarifado. Mantemos a rota antiga como
// redirect pra não quebrar links/bookmarks.
export default function EstoqueRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/almoxarifado?tab=estoque");
  }, [router]);
  return null;
}
