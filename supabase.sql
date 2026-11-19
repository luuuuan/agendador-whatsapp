-- Rode este script inteiro no Supabase: SQL Editor -> New query -> Run

-- 1) Agendamentos
create table if not exists public.agendamentos (
  id           uuid primary key default gen_random_uuid(),
  destino      text not null,              -- número (ex.: 5545999999999) ou id de grupo (...@g.us)
  destino_nome text,                       -- apelido pra mostrar no painel
  mensagem     text,                       -- texto (ou legenda da foto)
  foto_path    text,                       -- caminho no bucket "fotos" (opcional)
  data_hora    timestamptz not null,       -- quando enviar
  recorrencia  text not null default 'nenhuma'
               check (recorrencia in ('nenhuma', 'diaria', 'semanal', 'mensal')),
  status       text not null default 'pendente'
               check (status in ('pendente', 'enviando', 'enviado', 'erro', 'cancelado', 'expirado')),
  erro         text,
  enviado_em   timestamptz,
  criado_em    timestamptz not null default now(),
  constraint tem_conteudo check (coalesce(mensagem, '') <> '' or foto_path is not null)
);

create index if not exists agendamentos_pendentes_idx
  on public.agendamentos (data_hora) where status = 'pendente';

-- 2) Sessão do WhatsApp (pra não pedir QR code de novo a cada restart do Render)
create table if not exists public.whatsapp_auth (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- 3) Segurança: RLS ligado e SEM políticas = ninguém acessa pela chave pública (anon).
--    O servidor usa a service_role key, que passa por cima do RLS.
alter table public.agendamentos  enable row level security;
alter table public.whatsapp_auth enable row level security;

-- 4) Bucket privado pras fotos
insert into storage.buckets (id, name, public)
values ('fotos', 'fotos', false)
on conflict (id) do nothing;
