-- Rode no SQL Editor do Supabase (só uma vez) se o banco já existia antes desta versão
alter table public.agendamentos add column if not exists termina_em timestamptz;
