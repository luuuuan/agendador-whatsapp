-- Rode no SQL Editor do Supabase (só uma vez) pra ativar login/cadastro e um WhatsApp por conta.

-- 1) Contas
create table if not exists public.usuarios (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  email      text not null unique,
  senha_hash text not null,
  criado_em  timestamptz not null default now()
);
alter table public.usuarios enable row level security;
grant all on table public.usuarios to service_role;

-- 2) Cada agendamento passa a ter dono
alter table public.agendamentos
  add column if not exists usuario_id uuid references public.usuarios (id) on delete cascade;
create index if not exists agendamentos_usuario_idx on public.agendamentos (usuario_id);

-- 3) A sessão antiga do WhatsApp (de antes do login) não serve mais:
--    agora cada conta lê o próprio QR code. Os agendamentos antigos NÃO são apagados:
--    a primeira conta criada herda eles automaticamente.
delete from public.whatsapp_auth where id not like '%:%';
