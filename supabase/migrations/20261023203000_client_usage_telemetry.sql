-- Telemetria operacional do Painel 360.
-- Mede atividade observada no desktop web; nao guarda conteudo do CRM nem email.

create table if not exists public.client_usage_locations (
  location_id text primary key,
  display_name text not null default '',
  enabled boolean not null default false,
  batch_seconds integer not null default 300 check (batch_seconds between 60 and 1800),
  idle_seconds integer not null default 120 check (idle_seconds between 30 and 900),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_usage_users (
  location_id text not null references public.client_usage_locations(location_id) on delete cascade,
  user_id text not null,
  display_name text not null default '',
  user_role text not null default '',
  user_type text not null default '',
  last_seen_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (location_id, user_id)
);

create table if not exists public.client_usage_events (
  event_id uuid primary key,
  session_id uuid not null,
  location_id text not null references public.client_usage_locations(location_id) on delete cascade,
  user_id text not null,
  module text not null check (module in (
    'apps', 'automations', 'calendars', 'contacts', 'conversations', 'dashboard',
    'marketing', 'opportunities', 'other', 'payments', 'reporting', 'settings', 'sites'
  )),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  active_seconds integer not null check (active_seconds between 0 and 1800),
  page_views integer not null default 0 check (page_views between 0 and 50),
  collector_version text not null,
  source text not null default 'ghl_custom_js' check (source = 'ghl_custom_js'),
  received_at timestamptz not null default now(),
  check (ended_at >= started_at)
);

create index if not exists client_usage_events_location_started_idx
  on public.client_usage_events (location_id, started_at desc);
create index if not exists client_usage_events_user_started_idx
  on public.client_usage_events (location_id, user_id, started_at desc);
create index if not exists client_usage_events_session_idx
  on public.client_usage_events (session_id);

alter table public.client_usage_locations enable row level security;
alter table public.client_usage_users enable row level security;
alter table public.client_usage_events enable row level security;

revoke all on table public.client_usage_locations from public;
revoke all on table public.client_usage_users from public;
revoke all on table public.client_usage_events from public;
revoke all on table public.client_usage_locations from anon, authenticated;
revoke all on table public.client_usage_users from anon, authenticated;
revoke all on table public.client_usage_events from anon, authenticated;
grant select, insert, update, delete on table public.client_usage_locations to service_role;
grant select, insert, update, delete on table public.client_usage_users to service_role;
grant select, insert, update, delete on table public.client_usage_events to service_role;

create or replace view public.client_usage_daily_user_module
with (security_invoker = true)
as
select
  (started_at at time zone 'America/Sao_Paulo')::date as activity_date,
  location_id,
  user_id,
  module,
  sum(active_seconds)::bigint as active_seconds,
  sum(page_views)::bigint as page_views,
  count(distinct session_id)::bigint as sessions,
  min(started_at) as first_seen_at,
  max(ended_at) as last_seen_at
from public.client_usage_events
group by 1, location_id, user_id, module;

create or replace view public.client_usage_daily_location
with (security_invoker = true)
as
select
  (started_at at time zone 'America/Sao_Paulo')::date as activity_date,
  location_id,
  sum(active_seconds)::bigint as active_seconds,
  sum(page_views)::bigint as page_views,
  count(distinct user_id)::bigint as active_users,
  count(distinct session_id)::bigint as sessions,
  min(started_at) as first_seen_at,
  max(ended_at) as last_seen_at
from public.client_usage_events
group by 1, location_id;

revoke all on table public.client_usage_daily_user_module from public, anon, authenticated;
revoke all on table public.client_usage_daily_location from public, anon, authenticated;
grant select on table public.client_usage_daily_user_module to service_role;
grant select on table public.client_usage_daily_location to service_role;

-- Rollout inicial: somente Internal Testing. Habilitar cliente exige linha aqui
-- E inclusao explicita no mapa PILOTOS do Custom JS.
insert into public.client_usage_locations (
  location_id, display_name, enabled, batch_seconds, idle_seconds, updated_at
) values (
  'd8voPwkhJK7k7S5xjHcA', 'Internal Testing', true, 300, 120, now()
)
on conflict (location_id) do update set
  display_name = excluded.display_name,
  enabled = true,
  batch_seconds = excluded.batch_seconds,
  idle_seconds = excluded.idle_seconds,
  updated_at = now();
