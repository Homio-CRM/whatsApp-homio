-- Aplicada em 2026-10-28 11:30 BRT pelo MCP (version 20261028143053). Cron no fim, aplicado a parte.
-- Vigia de restricao: registra cada close 401 da Evolution e o contexto das 24 h anteriores.
-- Lido pela EF instance-restriction-watch (cron a cada 5 min), que avisa no grupo "Homio - Avisos".
create table if not exists public.instance_restriction_alerts (
  event_id integer primary key,            -- webhook_events.id do connection.update close 401
  instance_name text not null,
  location_id text,
  closed_at timestamptz not null,
  reopened_at timestamptz,                 -- open em ate 10 min depois do 401
  prev_401_24h integer not null default 0,
  alerted boolean not null default false,
  stats jsonb,
  message text,
  send_status integer,
  send_error text,
  created_at timestamptz not null default now()
);
alter table public.instance_restriction_alerts enable row level security;
revoke all on public.instance_restriction_alerts from anon, authenticated;
grant select, insert, update on public.instance_restriction_alerts to service_role;

-- Token do cron, gerado no banco (ninguem ve)
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'restriction_watch_token') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'restriction_watch_token', 'Token do cron instance-restriction-watch');
  end if;
end $$;

create or replace function public.restriction_watch_token() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'restriction_watch_token' limit 1
$$;
revoke all on function public.restriction_watch_token() from public, anon, authenticated;
grant execute on function public.restriction_watch_token() to service_role;

create or replace function public.restriction_watch_candidates(
  p_since timestamptz default '-infinity',
  p_wait interval default '10 minutes',
  p_lookback interval default '24 hours'
) returns table (
  event_id integer, instance_name text, location_id text, number_connected text, name_connected text,
  closed_at timestamptz, reopened_at timestamptz, prev_401_24h integer,
  api_sends integer, api_dest integer, device_sends integer, device_sources jsonb, inbound integer, cold_dest integer
) language sql stable security definer set search_path = public as $$
  with c as (
    select w.id, w.instance_name, w.received_at
    from webhook_events w
    where w.event_type = 'connection.update'
      and w.received_at > greatest(p_since, now() - p_lookback)
      and w.received_at <= now() - p_wait
      and w.payload->'data'->>'state' = 'close'
      and w.payload->'data'->>'statusReason' = '401'
      and not exists (select 1 from instance_restriction_alerts a where a.event_id = w.id)
  )
  select c.id, c.instance_name, i.location_id, i.number_connected, i.name_connected, c.received_at,
    r.reopened_at, p.prev_401_24h, s.api_sends, s.api_dest, s.device_sends, s.device_sources, s.inbound, s.cold_dest
  from c
  left join lateral (
    select ins.location_id::text, ins.number_connected::text, ins.name_connected::text
    from instances ins where ins.evolution_name = c.instance_name limit 1
  ) i on true
  left join lateral (
    select min(o.received_at) reopened_at from webhook_events o
    where o.instance_name = c.instance_name and o.event_type = 'connection.update'
      and o.payload->'data'->>'state' = 'open'
      and o.received_at > c.received_at and o.received_at <= c.received_at + p_wait
  ) r on true
  left join lateral (
    select count(*)::int prev_401_24h from webhook_events q
    where q.instance_name = c.instance_name and q.event_type = 'connection.update'
      and q.payload->'data'->>'state' = 'close' and q.payload->'data'->>'statusReason' = '401'
      and q.received_at < c.received_at and q.received_at > c.received_at - interval '24 hours'
  ) p on true
  left join lateral (
    with e as (
      select x.event_type, x.payload->'data'->'key'->>'fromMe' fm, x.payload->'data'->>'source' src,
             x.payload->'data'->'key'->>'remoteJid' jid, x.payload->'data'->'key'->>'remoteJidAlt' jid_alt
      from webhook_events x
      where x.instance_name = c.instance_name
        and x.received_at > c.received_at - interval '24 hours' and x.received_at <= c.received_at
        and x.event_type in ('send.message', 'messages.upsert')
    ),
    pessoa as (
      select * from e
      where coalesce(jid, '') not like '%@g.us' and coalesce(jid, '') not like '%@broadcast'
        and coalesce(jid, '') not like '%@newsletter'
    ),
    saida as (select jid from pessoa where event_type = 'send.message' or (event_type = 'messages.upsert' and fm = 'true')),
    entrada as (
      select jid from pessoa where event_type = 'messages.upsert' and fm = 'false' and jid is not null
      union
      select jid_alt from pessoa where event_type = 'messages.upsert' and fm = 'false' and jid_alt is not null
    )
    select
      (select count(*) from pessoa where event_type = 'send.message')::int api_sends,
      (select count(distinct jid) from pessoa where event_type = 'send.message')::int api_dest,
      (select count(*) from pessoa where event_type = 'messages.upsert' and fm = 'true')::int device_sends,
      (select coalesce(jsonb_object_agg(d.src, d.n), '{}'::jsonb)
         from (select coalesce(src, '?') src, count(*) n from pessoa
               where event_type = 'messages.upsert' and fm = 'true' group by 1) d) device_sources,
      (select count(*) from pessoa where event_type = 'messages.upsert' and fm = 'false')::int inbound,
      (select count(distinct sa.jid) from saida sa where sa.jid not in (select en.jid from entrada en))::int cold_dest
  ) s on true
  order by c.received_at;
$$;
revoke all on function public.restriction_watch_candidates(timestamptz, interval, interval) from public, anon, authenticated;
grant execute on function public.restriction_watch_candidates(timestamptz, interval, interval) to service_role;

-- So o que vier daqui pra frente: 401 das ultimas 24 h entram como ja vistos, sem aviso
insert into public.instance_restriction_alerts (event_id, instance_name, closed_at, alerted, message)
select w.id, w.instance_name, w.received_at, false, 'seed: anterior ao vigia'
from webhook_events w
where w.event_type = 'connection.update' and w.received_at > now() - interval '24 hours'
  and w.payload->'data'->>'state' = 'close' and w.payload->'data'->>'statusReason' = '401'
on conflict (event_id) do nothing;

-- Cron (aplicado a parte, job 6). Desligar: select cron.alter_job(6, active := false);
-- select cron.schedule('instance-restriction-watch', '*/5 * * * *', $cmd$
--   select net.http_post(
--     url := 'https://mlntilbkenjjejksevdx.supabase.co/functions/v1/instance-restriction-watch',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'x-watch-token', public.restriction_watch_token()),
--     body := '{}'::jsonb, timeout_milliseconds := 60000)
-- $cmd$);
