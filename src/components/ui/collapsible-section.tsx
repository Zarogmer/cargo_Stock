"use client";

import { useEffect, useState } from "react";
import { ChevronDownIcon } from "@/components/icons";

interface Props {
  /** Unique key used to persist the collapsed state in localStorage. */
  storageKey: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Optional content rendered on the right of the header (e.g. "Ver todas →"). */
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  /** Container classes (e.g. border tone). Defaults to the standard card style. */
  className?: string;
  /** Whether to start collapsed when there's no saved preference. */
  defaultCollapsed?: boolean;
}

export function CollapsibleSection({
  storageKey,
  title,
  subtitle,
  headerRight,
  children,
  className = "bg-card rounded-2xl border border-border overflow-hidden",
  defaultCollapsed = false,
}: Props) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`dashboard:collapsed:${storageKey}`);
      if (saved !== null) setCollapsed(saved === "1");
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, [storageKey]);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(`dashboard:collapsed:${storageKey}`, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  return (
    <section className={className}>
      <header className="px-6 pt-5 pb-4 border-b border-border flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text">{title}</h2>
          {subtitle && <p className="text-xs text-text-light mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {headerRight}
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expandir" : "Minimizar"}
            aria-expanded={!collapsed}
            className="p-1.5 text-text-light hover:text-text hover:bg-gray-100 rounded-lg transition"
          >
            <ChevronDownIcon className={`w-4 h-4 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
          </button>
        </div>
      </header>
      {hydrated && !collapsed && <div>{children}</div>}
    </section>
  );
}
