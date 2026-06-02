"use client";

import { useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";
import { EmailComposer } from "@/components/marketing/email-composer";
import { ClientsPanel } from "@/components/marketing/clients-panel";

// Marketing: duas abas dirigidas pelo submenu da sidebar via ?tab= (mesmo padrão
// do Almoxarifado). "email" = compositor do email de prospecção; "clientes" =
// cadastro de clientes reutilizável no envio.
export default function MarketingPage() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") || "email";

  const tabs = [
    { key: "email", label: "Enviar email", content: <EmailComposer /> },
    { key: "clientes", label: "Clientes", content: <ClientsPanel /> },
  ];

  const activeTabLabel = tabs.find((t) => t.key === initialTab)?.label;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h1 className="text-2xl font-bold text-text">Marketing 📣</h1>
        {activeTabLabel && (
          <>
            <span className="text-text-light">›</span>
            <span className="text-lg font-semibold text-text-light">{activeTabLabel}</span>
          </>
        )}
      </div>

      <Tabs tabs={tabs} defaultTab={initialTab} hideHeader />
    </div>
  );
}
