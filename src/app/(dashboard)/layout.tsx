"use client";

import { useState, useEffect } from "react";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { Sidebar } from "@/components/sidebar";
import { MenuIcon } from "@/components/icons";

function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, profile, loading } = useAuth();

  // When loading finishes and there's no user, redirect to login
  useEffect(() => {
    if (!loading && !user) {
      window.location.href = "/login";
    }
  }, [loading, user]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg overflow-hidden">
        <div className="flex flex-col items-center gap-4">
          {/* Ship sailing animation */}
          <div className="relative w-48 h-20">
            {/* Waves */}
            <div className="absolute bottom-0 left-0 right-0 h-6">
              <svg viewBox="0 0 200 20" className="w-full h-full text-blue-300/40" preserveAspectRatio="none">
                <path d="M0,10 Q25,0 50,10 T100,10 T150,10 T200,10 V20 H0 Z" fill="currentColor">
                  <animate attributeName="d" dur="2s" repeatCount="indefinite"
                    values="M0,10 Q25,0 50,10 T100,10 T150,10 T200,10 V20 H0 Z;M0,10 Q25,20 50,10 T100,10 T150,10 T200,10 V20 H0 Z;M0,10 Q25,0 50,10 T100,10 T150,10 T200,10 V20 H0 Z" />
                </path>
              </svg>
            </div>
            {/* Ship emoji moving */}
            <div className="absolute bottom-4 animate-ship-sail">
              <span className="text-4xl">🚢</span>
            </div>
          </div>

          <p className="text-primary font-bold text-lg">Cargo Stock</p>
          <p className="text-text-light text-sm animate-pulse">Carregando...</p>
        </div>

        <style jsx>{`
          @keyframes ship-sail {
            0% { transform: translateX(120px) rotate(2deg); }
            50% { transform: translateX(-30px) rotate(-2deg); }
            100% { transform: translateX(120px) rotate(2deg); }
          }
          .animate-ship-sail {
            animation: ship-sail 4s ease-in-out infinite;
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-bg overflow-hidden">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar (mobile) */}
        <header className="md:hidden flex items-center justify-between bg-white border-b border-border px-4 py-3 sticky top-0 z-30 shadow-sm">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 hover:bg-gray-100 rounded-lg transition"
          >
            <MenuIcon />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center">
              <span className="text-sm">🚢</span>
            </div>
            <h1 className="font-bold text-primary text-sm">Cargo Stock</h1>
          </div>
          <div className="w-10" />
        </header>

        {/* Main content */}
        <main className="flex-1 p-4 md:p-8 overflow-y-auto animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShell>{children}</DashboardShell>
    </AuthProvider>
  );
}
