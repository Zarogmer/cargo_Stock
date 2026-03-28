"use client";

import { useState, useEffect } from "react";

interface Tab {
  key: string;
  label: string;
  content: React.ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
}

export function Tabs({ tabs, defaultTab }: TabsProps) {
  const [active, setActive] = useState(defaultTab || tabs[0]?.key);

  // Update active tab when defaultTab changes (e.g., from URL params)
  useEffect(() => {
    if (defaultTab) {
      setActive(defaultTab);
    }
  }, [defaultTab]);

  return (
    <div>
      {/* Tab headers - scrollable on mobile */}
      <div className="flex overflow-x-auto border-b border-border gap-1 mb-4 -mx-4 px-4 md:mx-0 md:px-0">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActive(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition shrink-0
              ${
                active === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-text-light hover:text-text hover:border-gray-300"
              }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tabs.find((t) => t.key === active)?.content}
    </div>
  );
}
