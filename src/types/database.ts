export type Role = "GESTOR" | "EXECUTIVO" | "MANUTENCAO" | "FINANCEIRO" | "RH" | "TECNOLOGIA";

export type StockCategory = "COMPRAS" | "CARNES" | "FEIRA" | "OUTROS" | "CARNE" | "SUPRIMENTOS";

export type MovementType = "ENTRADA" | "BAIXA" | "AJUSTE";

export type EpiMovementType = "ENTREGA" | "DEVOLUCAO";

export type ToolStatus = "DISPONIVEL" | "EQUIPE_1" | "EQUIPE_2" | "MANUTENCAO";

export type ToolMovementType =
  | "EQUIPE_1"
  | "EQUIPE_2"
  | "DEVOLUCAO"
  | "MANUTENCAO";

export type AssetType = "FERRAMENTA" | "MAQUINARIO";

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
  location: string | null;
  quantity: number;
  default_quantity: number;
  team: string | null;
  expiry_date: string | null;
  min_quantity: number;
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
  updated_at: string;
  updated_by: string;
}

export interface Epi {
  id: number;
  name: string;
  ca_code: string | null;
  size: string | null;
  stock_qty: number;
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

export type JobUnit = "POR_NAVIO" | "POR_DIA" | "POR_HORA" | "POR_OPERACAO";
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

export interface JobAllocation {
  id: number;
  job_id: string;
  function_id: number;
  employee_id: number | null;
  quantity: number;
  rate: string | number;
  pluxee_value: string | number | null;
  notes: string | null;
  status: AllocationStatus;
  replaces_id: number | null;
  added_by: string;
  added_at: string;
  removed_by: string | null;
  removed_at: string | null;
  removal_reason: string | null;
  job_functions?: { name: string; unit: JobUnit } | null;
  employees?: { name: string; bank_name: string | null; bank_agency: string | null; bank_account: string | null; bank_account_type: string | null } | null;
}

export interface JobAdjustment {
  id: number;
  job_id: string;
  type: AdjustmentType;
  description: string;
  amount: string | number;
  created_at: string;
}

