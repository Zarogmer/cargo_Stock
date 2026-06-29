export type Role = "GESTOR" | "EXECUTIVO" | "MANUTENCAO" | "FINANCEIRO" | "RH" | "TECNOLOGIA" | "ESTAGIO";

export type StockCategory = "COMPRAS" | "CARNES" | "FEIRA" | "OUTROS" | "CARNE" | "SUPRIMENTOS";

export type MovementType = "ENTRADA" | "BAIXA" | "AJUSTE";

export type EpiMovementType = "ENTREGA" | "DEVOLUCAO";

export type ToolStatus = "DISPONIVEL" | "EQUIPE_1" | "EQUIPE_2" | "MANUTENCAO";

export type ToolMovementType =
  | "EQUIPE_1"
  | "EQUIPE_2"
  | "DEVOLUCAO"
  | "MANUTENCAO";

export type AssetType = "FERRAMENTA" | "MAQUINARIO" | "ELETRICA";

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  created_at: string;
  updated_at: string;
}

export interface StockItem {
  id: number;
  name: string;
  category: StockCategory;
  unit: string;
  location: string | null;
  quantity: number;
  default_quantity: number;
  team: string | null;
  // Onde o item está (abas de inventário): null/"DISPONIVEL" = no almoxarifado;
  // "EQUIPE_1"/"EQUIPE_2" = levado pela equipe. (Rancho não usa isto.)
  assigned_team: string | null;
  expiry_date: string | null;
  min_quantity: number;
  image_url: string | null;
  notes: string | null;
  updated_at: string;
  updated_by: string;
}

export interface StockMovement {
  id: number;
  stock_item_id: number;
  movement_type: MovementType;
  quantity: number;
  movement_date: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  stock_item?: StockItem;
}

export type TeamType = "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3" | "COSTADO" | null;

export interface Employee {
  id: number;
  name: string;
  team: TeamType;
  birth_date: string | null;
  phone: string | null;
  email: string | null;
  family_phone: string | null;
  notes: string | null;
  // Dados bancários
  bank_name: string | null;
  bank_agency: string | null;
  bank_account: string | null;
  bank_account_type: "CORRENTE" | "POUPANCA" | "CONTA_SAL" | "DIGITAL" | null;
  // Documentos
  has_vaccination_card: boolean | null;
  has_cnh: boolean | null;
  // Identificação (planilha oficial)
  cpf: string | null;
  rg: string | null;
  isps_code: string | null;
  e_social: string | null;
  subestipulante: number | null;
  modulo: number | null;
  // Vínculo / Status
  status: "ATIVO" | "INATIVO" | "PENDENCIA" | null;
  sector: "OPERACIONAL" | "ADMINISTRATIVO" | null;
  role: string | null;
  salary: string | number | null;
  admission_date: string | null;
  // Data limite p/ gozo de férias (coluna "Limite p/ gozo" da Programação de
  // Férias). Prazo legal do período aquisitivo mais antigo em aberto.
  vacation_limit_date: string | null;
  dismissal_date: string | null;
  contract_type: "REGISTRADO" | "INTERMITENTE" | null;
  // Treinamentos
  nrs_training: string | null;
  meio_ambiente_training: string | null;
  lifeguard_training: boolean | null;
  rubber_boot: boolean | null;
  // Tamanhos
  boot_size: string | null;
  shirt_size: string | null;
  bermuda_size: string | null;
  // ASO
  last_aso_date: string | null;
  aso_status: string | null;
  // Operacional
  realiza_limpeza: boolean | null;
  does_costado: boolean | null;
  escala_unavailable: boolean | null;
  updated_at: string;
  updated_by: string;
}

export interface Epi {
  id: number;
  name: string;
  ca_code: string | null;
  size: string | null;
  stock_qty: number;
  min_quantity: number;
  updated_at: string;
  updated_by: string;
}

export interface EpiMovement {
  id: number;
  epi_id: number;
  employee_name: string;
  movement_type: EpiMovementType;
  quantity: number;
  movement_date: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  epi?: Epi;
}

export interface Uniform {
  id: number;
  name: string;
  size: string | null;
  stock_qty: number;
  min_quantity: number;
  updated_at: string;
  updated_by: string;
}

export interface UniformMovement {
  id: number;
  uniform_id: number;
  employee_name: string;
  movement_type: EpiMovementType;
  quantity: number;
  movement_date: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  uniform?: Uniform;
}

export interface Tool {
  id: number;
  name: string;
  status: ToolStatus;
  location: string | null;
  notes: string | null;
  asset_type: AssetType;
  updated_at: string;
  updated_by: string;
}

export interface ToolMovement {
  id: number;
  tool_id: number;
  employee_name: string;
  movement_type: ToolMovementType;
  movement_date: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  tool?: Tool;
}

export interface MissionStandardItem {
  id: number;
  name: string;
  embark_name: string;
  category: string;
  required_qty: number;
  display_order: number;
}

// Ship type
export interface Ship {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  port: string | null;
  status: "AGENDADO" | "EM_OPERACAO" | "CONCLUIDO" | "CANCELADO";
  assigned_team: string | null;
  notes: string | null;
  // Empty (or no "COSTADO") = Embarque; ["COSTADO"] = Costado-only.
  // Embarque sub-services: "LAVAGEM_PORAO" | "PINTURA" | "RASPAGEM".
  services?: string[] | null;
  created_by: string;
  created_at: string;
}

// Product Link type
export interface ProductLink {
  id: string;
  name: string;
  url: string;
  category: string;
  description: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// Tool Request type
export interface ToolRequest {
  id: string;
  tool_name: string;
  quantity: number;
  reason: string;
  status: "PENDENTE" | "APROVADO" | "RECUSADO" | "COMPRADO";
  requested_by: string;
  responded_by: string | null;
  response_notes: string | null;
  created_at: string;
  updated_at: string;
}

// ── Sistema Financeiro ────────────────────────────────────────────────────────

export type JobUnit = "MENSALISTA" | "PORAO" | "POR_NAVIO" | "POR_DIA" | "POR_HORA" | "POR_OPERACAO" | "TURNO";

// Unidades de função "operacionais" — as que entram na escala de navio: porão/
// embarque (PORAO, POR_NAVIO, POR_OPERACAO) + turno de Costado (TURNO). As demais
// (MENSALISTA, POR_DIA, POR_HORA) são administrativas/mensalistas (ex.: Analista
// RH) e NÃO devem aparecer nos seletores de função da escalação. Espelha a
// distinção de UNIT_LABELS no Financeiro (onde essas três = "Mensalista").
export const ESCALABLE_JOB_UNITS: JobUnit[] = ["PORAO", "POR_NAVIO", "POR_OPERACAO", "TURNO"];
export function isEscalableJobUnit(unit: string | null | undefined): boolean {
  return !!unit && (ESCALABLE_JOB_UNITS as string[]).includes(unit);
}
export type JobStatus = "ABERTO" | "EM_ANDAMENTO" | "VERIFICADO" | "FECHADO" | "CANCELADO";
export type AdjustmentType = "ADICIONAL" | "REDUCAO";

export interface JobFunction {
  id: number;
  name: string;
  description: string | null;
  default_rate: string | number;
  unit: JobUnit;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface JobFunctionRate {
  id: number;
  function_id: number;
  rate: string | number;
  valid_from: string;
  valid_until: string | null;
  notes: string | null;
  created_at: string;
}

// Override por funcionário do default_rate da função.
export interface EmployeeFunctionRate {
  id: number;
  employee_id: number;
  function_id: number;
  rate: string | number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  name: string;
  ship_id: string | null;
  start_date: string;
  end_date: string | null;
  status: JobStatus;
  contract_value: string | number | null;
  notes: string | null;
  // Metadata fechamento
  client: string | null;
  supervisor: string | null;
  cargo_type: string | null;
  holds_count: number | null;
  port: string | null;
  // Workflow
  verified_at: string | null;
  verified_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  payroll_value: string | number | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  ships?: { name: string } | null;
}

export type AllocationStatus = "ATIVO" | "REMOVIDO" | "SUBSTITUIDO";
export type AllocationKind = "EMBARQUE" | "COSTADO" | "ADMINISTRATIVO";
export type ShiftPeriod = "07-13" | "13-19" | "19-01" | "01-07";
// Ordem dos turnos no dia: começa de manhã (07h) e a madrugada (01-07) é o
// último. Define a ordem dos cards na Escalação de Costado e do seletor de
// período (Navios).
export const SHIFT_PERIODS: ShiftPeriod[] = ["07-13", "13-19", "19-01", "01-07"];

export interface JobAllocation {
  id: number;
  job_id: string;
  function_id: number;
  employee_id: number | null;
  quantity: number;
  rate: string | number;
  pluxee_value: string | number | null;
  // Valor extra de rateio (quando faltou alguém da função e o valor foi dividido).
  extra_value: string | number | null;
  extra_reason: string | null;
  notes: string | null;
  status: AllocationStatus;
  kind: AllocationKind;
  // Override de função travado pelo executivo só neste navio (a normalização não
  // reescreve quando true). Opcional: ausente em clientes antigos = false.
  function_locked?: boolean | null;
  shift_date: string | null;
  shift_period: ShiftPeriod | null;
  replaces_id: number | null;
  added_by: string;
  added_at: string;
  removed_by: string | null;
  removed_at: string | null;
  removal_reason: string | null;
  job_functions?: { name: string; unit: JobUnit } | null;
  employees?: { name: string; bank_name: string | null; bank_agency: string | null; bank_account: string | null; bank_account_type: string | null } | null;
}

export interface CostadoPeriodStatus {
  id: number;
  job_id: string;
  shift_date: string;
  shift_period: ShiftPeriod;
  status: string;
  created_by: string;
  created_at: string;
}

// Linha única com os dados fixos da empresa pro arquivo Pluxee (PLANSIP4C).
export interface PluxeeConfig {
  id: number;
  client_code: string | null;
  order_type: string | null;
  product: string | null;
  delivery_place: string | null;
  cep: string | null;
  address: string | null;
  number: string | null;
  complement: string | null;
  reference: string | null;
  neighborhood: string | null;
  city: string | null;
  uf: string | null;
  responsible_name: string | null;
  responsible_ddd: string | null;
  responsible_phone: string | null;
  inactive_value: string | number | null;
  updated_at: string;
  updated_by: string | null;
}

export interface JobAdjustment {
  id: number;
  job_id: string;
  type: AdjustmentType;
  // COMPRAS | QUIMICA | MATERIAL_DANIFICADO | AJUDA_DE_CUSTO | ALIMENTACAO | RESTAURANTE | OUTROS
  // Null = legado/sem categoria.
  category: string | null;
  description: string;
  amount: string | number;
  created_at: string;
}

export interface WhatsappMessage {
  id: string;
  message_id: string | null;
  instance_name: string;
  remote_jid: string;
  from_me: boolean;
  push_name: string | null;
  message_type: string;
  text: string | null;
  media_mimetype: string | null;
  media_filename: string | null;
  timestamp_ms: string | number;
  sent_by_user_id: string | null;
  raw_event: unknown;
  created_at: string;
}

