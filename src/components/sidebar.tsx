"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getNavItemsForRole, type NavItem, type NavSubItem } from "@/lib/rbac";
import { NavIcon, LogoutIcon, CloseIcon, ChevronDownIcon } from "@/components/icons";

// Match a sub-item href (which may include query params like
// ?tab=documentos&doc=dds) against the current URL. Returns true when every
// param in the sub-item's href is present on the page with the same value.
function isLeafActive(href: string, pathname: string, searchParams: URLSearchParams) {
  const [path, query] = href.split("?");
  if (pathname !== path && !pathname.startsWith(path + "/")) return false;
  if (!query) return true;
  const params = new URLSearchParams(query);
  for (const [k, v] of params) {
    if (searchParams.get(k) !== v) return false;
  }
  return true;
}

// Auto-expand a sub-tree if any descendant href matches the current URL.
function hasActiveDescendant(item: NavSubItem, pathname: string, searchParams: URLSearchParams): boolean {
  if (isLeafActive(item.href, pathname, searchParams)) return true;
  return (item.children || []).some((c) => hasActiveDescendant(c, pathname, searchParams));
}

function NavSubEntry({
  child,
  pathname,
  searchParams,
  onClose,
  depth,
}: {
  child: NavSubItem;
  pathname: string;
  searchParams: URLSearchParams;
  onClose: () => void;
  depth: number;
}) {
  const hasChildren = !!child.children && child.children.length > 0;
  const childActiveDeep = hasActiveDescendant(child, pathname, searchParams);
  const [expanded, setExpanded] = useState(childActiveDeep);

  useEffect(() => {
    if (childActiveDeep) setExpanded(true);
  }, [childActiveDeep]);

  if (!hasChildren) {
    const active = isLeafActive(child.href, pathname, searchParams);
    return (
      <Link
        href={child.href}
        onClick={onClose}
        className={`block px-3 py-2 rounded-lg text-xs transition-all duration-200
          ${active
            ? "bg-primary text-white font-medium"
            : "text-gray-400 hover:bg-white/5 hover:text-white"
          }`}
      >
        {child.label}
      </Link>
    );
  }

  // Branch sub-item: clicking the row only toggles, navigation happens through
  // the nested leaves.
  const selfActive = childActiveDeep;
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs transition-all duration-200
          ${selfActive
            ? "bg-primary/15 text-white font-medium"
            : "text-gray-400 hover:bg-white/5 hover:text-white"
          }`}
      >
        <span className="flex-1 text-left">{child.label}</span>
        <ChevronDownIcon className={`w-3.5 h-3.5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div className={`mt-0.5 ${depth === 0 ? "ml-3" : "ml-3"} space-y-0.5 border-l border-white/5 pl-2`}>
          {child.children!.map((c) => (
            <NavSubEntry
              key={c.href}
              child={c}
              pathname={pathname}
              searchParams={searchParams}
              onClose={onClose}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NavEntry({
  item,
  isActive,
  pathname,
  searchParams,
  onClose,
}: {
  item: NavItem;
  isActive: (href: string) => boolean;
  pathname: string;
  searchParams: URLSearchParams;
  onClose: () => void;
}) {
  const hasChildren = !!item.children && item.children.length > 0;
  const parentActive = isActive(item.href);
  const [expanded, setExpanded] = useState(parentActive);

  // Auto-expand when navigating into this parent's area.
  useEffect(() => {
    if (parentActive) setExpanded(true);
  }, [parentActive]);

  if (!hasChildren) {
    return (
      <Link
        href={item.href}
        onClick={onClose}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-200
          ${parentActive
            ? "bg-primary text-white font-medium shadow-lg shadow-primary/20"
            : "text-gray-400 hover:bg-white/5 hover:text-white"
          }`}
      >
        <NavIcon name={item.icon} className="w-5 h-5 shrink-0" />
        <span>{item.label}</span>
      </Link>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm transition-all duration-200
          ${parentActive
            ? "bg-primary/15 text-white font-medium"
            : "text-gray-400 hover:bg-white/5 hover:text-white"
          }`}
      >
        <NavIcon name={item.icon} className="w-5 h-5 shrink-0" />
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronDownIcon className={`w-4 h-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div className="mt-0.5 ml-7 space-y-0.5 border-l border-white/5 pl-2">
          {item.children!.map((child) => (
            <NavSubEntry
              key={child.href}
              child={child}
              pathname={pathname}
              searchParams={searchParams}
              onClose={onClose}
              depth={0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  /** Desktop: quando true a sidebar recolhe (largura 0) pra dar mais tela. */
  collapsed?: boolean;
}

export function Sidebar({ open, onClose, collapsed = false }: SidebarProps) {
  const { profile, signOut } = useAuth();
  const pathname = usePathname();
  const searchParams = useSearchParams();

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
    ESTAGIO: "Estágio",
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
        className={`fixed top-0 left-0 h-full w-64 bg-sidebar text-white z-50 transform overflow-hidden transition-[transform,width] duration-300 ease-in-out
          ${open ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0 md:sticky md:top-0 md:z-auto md:shrink-0 md:h-screen
          ${collapsed ? "md:w-0" : "md:w-64"}`}
      >
        {/* Largura fixa interna: quando o aside recolhe pra 0 o conteúdo é
            cortado (overflow-hidden) em vez de reflowar/espremer. */}
        <div className="flex flex-col h-full w-64">
          {/* Header */}
          <div className="flex items-center justify-between p-5 border-b border-white/5">
            <Link
              href="/"
              onClick={onClose}
              title="Ir para o Dashboard"
              className="flex items-center gap-3 -m-1.5 p-1.5 rounded-lg hover:bg-white/5 transition"
            >
              <div className="w-10 h-10 bg-gradient-to-br from-primary to-primary-light rounded-xl flex items-center justify-center shadow-lg shadow-primary/20">
                <span className="text-xl">🚢</span>
              </div>
              <div>
                <h2 className="font-bold text-sm tracking-wide">Cargo Stock</h2>
              </div>
            </Link>
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
              <NavEntry
                key={item.href}
                item={item}
                isActive={isActive}
                pathname={pathname}
                searchParams={searchParams}
                onClose={onClose}
              />
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
