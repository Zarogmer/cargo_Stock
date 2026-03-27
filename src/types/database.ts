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

export type TeamType = "EQUIPE_1" | "EQUIPE_2" | null;

export interface Employee {
  id: number;
  name: string;
  team: TeamType;
  birth_date: string | null;
  phone: string | null;
  email: string | null;
  family_phone: string | null;
  notes: string | null;
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

// Simplified Database type - uses Record<string, any> for Insert/Update
// to avoid complex type inference issues with Supabase client
type TableDef<T> = {
  Row: T;
  Insert: Record<string, any>;
  Update: Record<string, any>;
};

export interface Database {
  public: {
    Tables: {
      profiles: TableDef<Profile>;
      stock_items: TableDef<StockItem>;
      stock_movements: TableDef<StockMovement>;
      employees: TableDef<Employee>;
      epis: TableDef<Epi>;
      epi_movements: TableDef<EpiMovement>;
      uniforms: TableDef<Uniform>;
      uniform_movements: TableDef<UniformMovement>;
      tools: TableDef<Tool>;
      tool_movements: TableDef<ToolMovement>;
      mission_standard_items: TableDef<MissionStandardItem>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      role: Role;
      stock_category: StockCategory;
      movement_type: MovementType;
      epi_movement_type: EpiMovementType;
      tool_status: ToolStatus;
      tool_movement_type: ToolMovementType;
      asset_type: AssetType;
    };
  };
}
