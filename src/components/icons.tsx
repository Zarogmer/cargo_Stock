// All app icons re-exported from lucide-react.
// Public names (e.g. `PlusIcon`, `NavIcon`) are kept stable so callers
// don't need to change. To browse available icons: https://lucide.dev/icons/
import {
  LayoutDashboard,
  Zap,
  Package,
  Users,
  Wrench,
  Ship,
  ClipboardList,
  CircleDollarSign,
  LogOut,
  Menu,
  X,
  Plus,
  Pencil,
  Trash2,
  Search,
  ChevronDown,
} from "lucide-react";

interface IconProps {
  className?: string;
}

export function DashboardIcon({ className = "w-5 h-5" }: IconProps) {
  return <LayoutDashboard className={className} />;
}

export function EmbarqueIcon({ className = "w-5 h-5" }: IconProps) {
  return <Zap className={className} />;
}

export function EstoqueIcon({ className = "w-5 h-5" }: IconProps) {
  return <Package className={className} />;
}

export function EpiIcon({ className = "w-5 h-5" }: IconProps) {
  return <Users className={className} />;
}

export function EquipamentosIcon({ className = "w-5 h-5" }: IconProps) {
  return <Wrench className={className} />;
}

export function NaviosIcon({ className = "w-5 h-5" }: IconProps) {
  return <Ship className={className} />;
}

export function SolicitacoesIcon({ className = "w-5 h-5" }: IconProps) {
  return <ClipboardList className={className} />;
}

export function FinanceiroIcon({ className = "w-5 h-5" }: IconProps) {
  return <CircleDollarSign className={className} />;
}

export function LogoutIcon({ className = "w-5 h-5" }: IconProps) {
  return <LogOut className={className} />;
}

export function MenuIcon({ className = "w-6 h-6" }: IconProps) {
  return <Menu className={className} />;
}

export function CloseIcon({ className = "w-6 h-6" }: IconProps) {
  return <X className={className} />;
}

export function PlusIcon({ className = "w-5 h-5" }: IconProps) {
  return <Plus className={className} />;
}

export function EditIcon({ className = "w-4 h-4" }: IconProps) {
  return <Pencil className={className} />;
}

export function TrashIcon({ className = "w-4 h-4" }: IconProps) {
  return <Trash2 className={className} />;
}

export function SearchIcon({ className = "w-5 h-5" }: IconProps) {
  return <Search className={className} />;
}

export function ChevronDownIcon({ className = "w-4 h-4" }: IconProps) {
  return <ChevronDown className={className} />;
}

const ICON_MAP: Record<string, React.FC<IconProps>> = {
  dashboard: DashboardIcon,
  embarque: EmbarqueIcon,
  estoque: EstoqueIcon,
  epi: EpiIcon,
  equipamentos: EquipamentosIcon,
  solicitacoes: SolicitacoesIcon,
  navios: NaviosIcon,
  financeiro: FinanceiroIcon,
};

export function NavIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICON_MAP[name] || DashboardIcon;
  return <Icon className={className} />;
}
