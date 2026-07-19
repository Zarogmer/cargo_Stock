// Mescla as seções FIXAS da Demonstração (src/lib/demonstracao-financeira.ts,
// presas à planilha da diretoria) com as que o usuário cria no banco
// (custom_statement_sections). Puro/sem Prisma — pode ser usado no cliente.
//
// A chave gravada em payable_invoices.statement_section é:
//   • fixa   → "6.1", "9.2", "12"...   (SECTION_BY_KEY)
//   • custom → "c<id>"                 (isCustomKey / customKey)

import { STATEMENT_SECTIONS, STATEMENT_GROUPS, SECTION_BY_KEY } from "@/lib/demonstracao-financeira";

export interface CustomSectionRow {
  id: number;
  label: string;
  group_label: string;
  sort_order: number;
  active: boolean;
}

// Renomeia uma seção FIXA (só o rótulo; a chave "6.1"/"9.2"/... não muda).
export interface SectionOverrideRow {
  section_key: string;
  label: string;
}

export interface MergedSection {
  key: string;
  label: string;
  shortLabel: string;
  group: string;
  custom: boolean;
  /** true quando é uma seção fixa cujo rótulo foi renomeado pelo usuário. */
  overridden: boolean;
}

const CUSTOM_KEY_RE = /^c(\d+)$/;

export function isCustomKey(key: string): boolean {
  return CUSTOM_KEY_RE.test(key);
}

export function customKeyId(key: string): number | null {
  const m = key.match(CUSTOM_KEY_RE);
  return m ? Number(m[1]) : null;
}

export function customKey(id: number): string {
  return `c${id}`;
}

// Lista unificada (fixas + custom ativas) e a ordem dos grupos. Grupos oficiais
// vêm primeiro (na ordem da planilha); grupos novos criados pelo usuário entram
// depois, em ordem alfabética.
export function mergeSections(
  custom: CustomSectionRow[],
  overrides: SectionOverrideRow[] = [],
): {
  sections: MergedSection[];
  groups: string[];
  byKey: Map<string, MergedSection>;
} {
  const ov = new Map<string, string>();
  for (const o of overrides) {
    const l = o.label.trim();
    if (l) ov.set(o.section_key, l);
  }
  const builtin: MergedSection[] = STATEMENT_SECTIONS.map((s) => {
    const renamed = ov.get(s.key);
    return renamed
      ? { key: s.key, label: renamed, shortLabel: renamed, group: s.group, custom: false, overridden: true }
      : { key: s.key, label: s.label, shortLabel: s.shortLabel, group: s.group, custom: false, overridden: false };
  });
  const customActive = custom
    .filter((c) => c.active)
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label, "pt-BR"))
    .map((c) => ({
      key: customKey(c.id), label: c.label, shortLabel: c.label, group: c.group_label, custom: true, overridden: false,
    }));

  const sections = [...builtin, ...customActive];
  const byKey = new Map(sections.map((s) => [s.key, s]));

  const builtinGroups = [...STATEMENT_GROUPS];
  const extraGroups = [...new Set(customActive.map((s) => s.group))]
    .filter((g) => !builtinGroups.includes(g as (typeof STATEMENT_GROUPS)[number]))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const groups = [...builtinGroups, ...extraGroups];

  return { sections, groups, byKey };
}

// Rótulo de uma chave de seção (fixa ou custom) — usado onde a UI não tem a
// lista mesclada em mãos. Custom sem lista carregada cai num placeholder.
export function sectionShortLabel(
  key: string | null | undefined,
  byKey?: Map<string, MergedSection>,
): string | null {
  if (!key) return null;
  if (byKey?.has(key)) return byKey.get(key)!.shortLabel;
  const builtin = SECTION_BY_KEY.get(key);
  if (builtin) return builtin.shortLabel;
  return isCustomKey(key) ? "Seção personalizada" : key;
}
