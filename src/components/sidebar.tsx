"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getNavItemsForRole } from "@/lib/rbac";
import { NavIcon, LogoutIcon, CloseIcon } from "@/components/icons";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const { profile, signOut } = useAuth();
  const pathname = usePathname();

  if (!profile) return null;

  const navItems = getNavItemsForRole(profile.role);

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  const roleLabels: Record<string, string> = {
    GESTOR: "Gestor",
    EXECUTIVO: "Executivo",
    MANUTENCAO: "Manutenção",
    FINANCEIRO: "Financeiro",
    RH: "RH",
    TECNOLOGIA: "Tecnologia",
  };

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 h-full w-64 bg-sidebar text-white z-50 transform transition-transform duration-300 ease-in-out
          ${open ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0 md:static md:z-auto`}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between p-5 border-b border-white/5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-primary to-primary-light rounded-xl flex items-center justify-center shadow-lg shadow-primary/20">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
              </div>
              <div>
                <h2 className="font-bold text-sm tracking-wide">Cargo Stock</h2>
                <p className="text-[10px] text-gray-500 uppercase tracking-widest">v2.0</p>
              </div>
            </div>
            <button onClick={onClose} className="md:hidden p-1.5 hover:bg-sidebar-hover rounded-lg transition">
              <CloseIcon className="w-5 h-5" />
            </button>
          </div>

          {/* User info */}
          <div className="px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-gradient-to-br from-primary-light to-primary rounded-full flex items-center justify-center text-sm font-bold">
                {profile.full_name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{profile.full_name}</p>
                <p className="text-xs text-gray-400">{roleLabels[profile.role] || profile.role}</p>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="mx-5 border-t border-white/5" />

          {/* Navigation */}
          <nav className="flex-1 py-3 px-3 overflow-y-auto space-y-0.5">
            <p className="px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase tracking-widest">Menu</p>
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-200
                  ${isActive(item.href)
                    ? "bg-primary text-white font-medium shadow-lg shadow-primary/20"
                    : "text-gray-400 hover:bg-white/5 hover:text-white"
                  }`}
              >
                <NavIcon name={item.icon} className="w-5 h-5 shrink-0" />
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>

          {/* Logout */}
          <div className="p-3 border-t border-white/5">
            <button
              onClick={signOut}
              className="flex items-center gap-3 w-full px-3 py-2.5 text-sm text-gray-400 hover:bg-red-500/10 hover:text-red-400 rounded-lg transition-all duration-200"
            >
              <LogoutIcon className="w-5 h-5 shrink-0" />
              <span>Sair</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
