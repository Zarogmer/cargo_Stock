-- ============================================================
-- CARGO STOCK - Supabase Schema
-- Execute this SQL in your Supabase SQL Editor
-- (Dashboard > SQL Editor > New Query > Paste > Run)
-- ============================================================

-- 1. ENUMS
-- ============================================================
CREATE TYPE public.role AS ENUM ('GESTOR', 'EXECUTIVO', 'MANUTENCAO', 'RH');
CREATE TYPE public.stock_category AS ENUM ('COMPRAS', 'CARNES', 'FEIRA', 'OUTROS');
CREATE TYPE public.movement_type AS ENUM ('ENTRADA', 'BAIXA', 'AJUSTE');
CREATE TYPE public.epi_movement_type AS ENUM ('ENTREGA', 'DEVOLUCAO');
CREATE TYPE public.tool_status AS ENUM ('DISPONIVEL', 'EQUIPE_1', 'EQUIPE_2', 'MANUTENCAO');
CREATE TYPE public.tool_movement_type AS ENUM ('EQUIPE_1', 'EQUIPE_2', 'DEVOLUCAO', 'MANUTENCAO');
CREATE TYPE public.asset_type AS ENUM ('FERRAMENTA', 'MAQUINARIO');

-- 2. PROFILES (linked to auth.users)
-- ============================================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role public.role NOT NULL DEFAULT 'RH',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE((NEW.raw_user_meta_data->>'role')::public.role, 'RH')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 3. STOCK ITEMS
-- ============================================================
CREATE TABLE public.stock_items (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category public.stock_category NOT NULL DEFAULT 'OUTROS',
  location TEXT,
  quantity INTEGER NOT NULL DEFAULT 0,
  expiry_date DATE,
  min_quantity INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
);

CREATE TRIGGER stock_items_updated_at
  BEFORE UPDATE ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 4. STOCK MOVEMENTS
-- ============================================================
CREATE TABLE public.stock_movements (
  id BIGSERIAL PRIMARY KEY,
  stock_item_id BIGINT NOT NULL REFERENCES public.stock_items(id) ON DELETE CASCADE,
  movement_type public.movement_type NOT NULL,
  quantity INTEGER NOT NULL,
  movement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. EMPLOYEES
-- ============================================================
CREATE TABLE public.employees (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  birth_date DATE,
  phone TEXT,
  email TEXT,
  family_phone TEXT,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
);

CREATE TRIGGER employees_updated_at
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 6. EPIs
-- ============================================================
CREATE TABLE public.epis (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  ca_code TEXT,
  size TEXT,
  stock_qty INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
);

CREATE TRIGGER epis_updated_at
  BEFORE UPDATE ON public.epis
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 7. EPI MOVEMENTS
-- ============================================================
CREATE TABLE public.epi_movements (
  id BIGSERIAL PRIMARY KEY,
  epi_id BIGINT NOT NULL REFERENCES public.epis(id) ON DELETE CASCADE,
  employee_name TEXT NOT NULL,
  movement_type public.epi_movement_type NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  movement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. UNIFORMS
-- ============================================================
CREATE TABLE public.uniforms (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  size TEXT,
  stock_qty INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
);

CREATE TRIGGER uniforms_updated_at
  BEFORE UPDATE ON public.uniforms
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 9. UNIFORM MOVEMENTS
-- ============================================================
CREATE TABLE public.uniform_movements (
  id BIGSERIAL PRIMARY KEY,
  uniform_id BIGINT NOT NULL REFERENCES public.uniforms(id) ON DELETE CASCADE,
  employee_name TEXT NOT NULL,
  movement_type public.epi_movement_type NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  movement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10. TOOLS (ferramentas + maquinário)
-- ============================================================
CREATE TABLE public.tools (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  status public.tool_status NOT NULL DEFAULT 'DISPONIVEL',
  location TEXT,
  notes TEXT,
  asset_type public.asset_type NOT NULL DEFAULT 'FERRAMENTA',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
);

CREATE TRIGGER tools_updated_at
  BEFORE UPDATE ON public.tools
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 11. TOOL MOVEMENTS
-- ============================================================
CREATE TABLE public.tool_movements (
  id BIGSERIAL PRIMARY KEY,
  tool_id BIGINT NOT NULL REFERENCES public.tools(id) ON DELETE CASCADE,
  employee_name TEXT NOT NULL,
  movement_type public.tool_movement_type NOT NULL,
  movement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 12. MISSION STANDARD ITEMS
-- ============================================================
CREATE TABLE public.mission_standard_items (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  embark_name TEXT NOT NULL,
  category TEXT NOT NULL,
  required_qty INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0
);

-- 13. LOGIN LOGS (track user login/logout)
-- ============================================================
CREATE TABLE public.login_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'LOGIN', -- LOGIN or LOGOUT
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 14. TOOL REQUESTS (solicitações de compra)
-- ============================================================
CREATE TABLE public.tool_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE', -- PENDENTE, APROVADO, RECUSADO, COMPRADO
  requested_by TEXT NOT NULL,
  responded_by TEXT,
  response_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 15. PRODUCT LINKS (catálogo de produtos)
-- ============================================================
CREATE TABLE public.product_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Outros',
  description TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- All authenticated users can read/write (5 trusted employees)
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.epis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.epi_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uniforms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uniform_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mission_standard_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_links ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read all, update only their own
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid());

-- All other tables: authenticated users can do everything
-- (since it's a small trusted team of 5)
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'stock_items', 'stock_movements',
      'employees',
      'epis', 'epi_movements',
      'uniforms', 'uniform_movements',
      'tools', 'tool_movements',
      'mission_standard_items',
      'login_logs',
      'tool_requests',
      'product_links'
    ])
  LOOP
    EXECUTE format('CREATE POLICY "%s_select" ON public.%I FOR SELECT TO authenticated USING (true)', tbl, tbl);
    EXECUTE format('CREATE POLICY "%s_insert" ON public.%I FOR INSERT TO authenticated WITH CHECK (true)', tbl, tbl);
    EXECUTE format('CREATE POLICY "%s_update" ON public.%I FOR UPDATE TO authenticated USING (true)', tbl, tbl);
    EXECUTE format('CREATE POLICY "%s_delete" ON public.%I FOR DELETE TO authenticated USING (true)', tbl, tbl);
  END LOOP;
END;
$$;

-- ============================================================
-- INDEXES for performance
-- ============================================================
CREATE INDEX idx_stock_items_category ON public.stock_items(category);
CREATE INDEX idx_stock_movements_item ON public.stock_movements(stock_item_id);
CREATE INDEX idx_epi_movements_epi ON public.epi_movements(epi_id);
CREATE INDEX idx_uniform_movements_uniform ON public.uniform_movements(uniform_id);
CREATE INDEX idx_tool_movements_tool ON public.tool_movements(tool_id);
CREATE INDEX idx_tools_asset_type ON public.tools(asset_type);
CREATE INDEX idx_tools_status ON public.tools(status);
CREATE INDEX idx_mission_standard_items_embark ON public.mission_standard_items(embark_name);
CREATE INDEX idx_login_logs_created_at ON public.login_logs(created_at DESC);
CREATE INDEX idx_tool_requests_status ON public.tool_requests(status);
CREATE INDEX idx_tool_requests_created_at ON public.tool_requests(created_at DESC);
CREATE INDEX idx_product_links_category ON public.product_links(category);
