"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function EscalacaoIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/escalacao/embarque");
  }, [router]);
  return null;
}
