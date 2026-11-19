-- Rode no SQL Editor do Supabase (só uma vez): liga os agendamentos criados juntos,
-- pra poder editar o texto/foto de todos os grupos e horários de uma vez
alter table public.agendamentos add column if not exists lote uuid;
create index if not exists agendamentos_lote_idx on public.agendamentos (lote);
