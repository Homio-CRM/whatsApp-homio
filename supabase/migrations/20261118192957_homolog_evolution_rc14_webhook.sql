-- Homologacao Evolution 2.3.7 + Baileys rc14 (2026-11-18). Descartavel: apagar as duas tabelas ao fim da homologacao.
create table if not exists public.homolog_webhook_events (
  id bigserial primary key,
  received_at timestamptz not null default now(),
  instance_name text,
  event_type text,
  msg_id text,
  from_me boolean,
  remote_jid text,
  msg_ts timestamptz,
  payload jsonb not null
);
create index if not exists homolog_webhook_events_received_idx on public.homolog_webhook_events (received_at desc);
create index if not exists homolog_webhook_events_msg_idx on public.homolog_webhook_events (msg_id);
alter table public.homolog_webhook_events enable row level security;
comment on table public.homolog_webhook_events is
  'Homologacao Evolution 2.3.7 + Baileys rc14 (2026-11-18): webhook da instancia de teste, so registro. Nao alimenta o CRM. Descartavel.';

create table if not exists public.homolog_config (chave text primary key, valor text not null);
alter table public.homolog_config enable row level security;
insert into public.homolog_config (chave, valor)
values ('webhook_token_sha256', 'caead501a97048e3f2b734dced64198ec0e23f92be3d64eeaa714bd3dd256990')
on conflict (chave) do update set valor = excluded.valor;
