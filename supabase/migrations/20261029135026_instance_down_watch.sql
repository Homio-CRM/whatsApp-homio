-- Aplicada em 2026-10-29 10:50 BRT pelo MCP (version 20261029135026). Cron no fim, aplicado a parte.
-- Vigia de WhatsApp Homio fora (regra nº 2 do vigia do Painel 360).
-- Lido pela EF instance-down-watch (cron a cada 30 min), que avisa no grupo "Homio - Avisos".
-- Dois sinais:
--   fora          instancia que nao esta `open` ha mais de 2 h (so volta com QR no celular do cliente;
--                 a queda de 13/10 deixou 10 assim por 15 dias sem ninguem perceber)
--   sem_instancia envio do GHL pelo canal Whats Homio que falhou com `no_instance` (provedor visivel na
--                 subconta sem instancia por tras: Doces, Brasmetal, Mivita depois de remover o -2)
-- Complementa o instance-restriction-watch (401 = possivel restricao), nao substitui: a queda com 401
-- aparece aqui marcada, para ninguem pedir QR antes de ler o aviso de restricao.
-- Nao toca nas EFs compartilhadas. Wiki: projetos/painel_clientes_homio.md (Vigia de WhatsApp fora).

create table if not exists public.instance_watch_incidents (
  id              bigserial primary key,
  chave           text not null,                    -- 'fora:<evolution_name>' ou 'sem_instancia:<location_id>'
  tipo            text not null check (tipo in ('fora', 'sem_instancia')),
  instance_name   text,
  location_id     text not null,
  perfil          text,                             -- name_connected na abertura
  numero          text,
  desde           timestamptz not null,             -- fora: status_changed_at; sem_instancia: 1o erro visto
  ultimo_erro_em  timestamptz,
  erros           int not null default 0,           -- envios do GHL que falharam (send_errors atribuidos)
  restricao       boolean not null default false,   -- a queda foi um 401 registrado pelo vigia de restricao
  ultimo_aviso_em timestamptz,
  aberto_em       timestamptz not null default now(),
  fechado_em      timestamptz,
  fechado_por     text                              -- voltou | removida | silenciada | sem_erro_7d
);
create unique index if not exists instance_watch_incidente_aberto
  on public.instance_watch_incidents (chave) where fechado_em is null;

-- Nome da subconta (buscado na GHL pela EF e guardado aqui) e o interruptor por subconta.
create table if not exists public.instance_watch_locations (
  location_id     text primary key,
  nome            text,
  nome_tentado_em timestamptz,
  vigiar          boolean not null default true,    -- false = nao avisar desta subconta (churn, interna, teste)
  nota            text
);

create table if not exists public.instance_watch_avisos (
  id         bigserial primary key,
  enviado_em timestamptz not null default now(),
  texto      text not null,
  status     int,
  erro       text
);

alter table public.instance_watch_incidents enable row level security;
alter table public.instance_watch_locations enable row level security;
alter table public.instance_watch_avisos    enable row level security;
revoke all on public.instance_watch_incidents, public.instance_watch_locations, public.instance_watch_avisos
  from anon, authenticated;
grant select, insert, update, delete on public.instance_watch_incidents, public.instance_watch_locations,
  public.instance_watch_avisos to service_role;
revoke all on sequence public.instance_watch_incidents_id_seq, public.instance_watch_avisos_id_seq
  from anon, authenticated;
grant usage, select on sequence public.instance_watch_incidents_id_seq, public.instance_watch_avisos_id_seq
  to service_role;

-- Token do cron, gerado no banco (ninguem ve)
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'instance_watch_token') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'instance_watch_token', 'Token do cron instance-down-watch');
  end if;
end $$;

create or replace function public.instance_watch_token() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'instance_watch_token' limit 1
$$;
revoke all on function public.instance_watch_token() from public, anon, authenticated;
grant execute on function public.instance_watch_token() to service_role;

-- Foto do momento, numa chamada so:
--   fora          toda instancia que nao esta open, com os envios que falharam por ela desde a queda
--                 (`instance_disconnected` traz o nome no texto: "Instance <nome> status=<status>")
--   abertas       nomes das instancias open (para fechar o incidente de quem voltou)
--   sem_instancia `no_instance` por subconta desde p_desde, com quantas instancias a subconta tem
create or replace function public.instance_watch_snapshot(p_desde timestamptz default now() - interval '24 hours')
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'agora', now(),
    'fora', coalesce((
      select jsonb_agg(jsonb_build_object(
        'instance_name', i.evolution_name, 'location_id', i.location_id, 'status', i.status::text,
        'desde', coalesce(i.status_changed_at, i.updated_at), 'perfil', i.name_connected,
        'numero', i.number_connected, 'erros', e.n, 'ultimo_erro_em', e.ultimo,
        'restricao', exists (
          select 1 from instance_restriction_alerts r
          where r.instance_name = i.evolution_name
            and r.closed_at >= coalesce(i.status_changed_at, i.updated_at) - interval '2 minutes')
      ) order by coalesce(i.status_changed_at, i.updated_at))
      from instances i
      left join lateral (
        select count(*)::int n, max(s.created_at) ultimo
        from send_errors s
        where s.location_id = i.location_id and s.error_type = 'instance_disconnected'
          and s.error_message like 'Instance ' || i.evolution_name || ' status=%'
          and s.created_at >= coalesce(i.status_changed_at, i.updated_at)
      ) e on true
      where i.status::text <> 'open'
    ), '[]'::jsonb),
    'abertas', coalesce((select jsonb_agg(i.evolution_name) from instances i where i.status::text = 'open'), '[]'::jsonb),
    'sem_instancia', coalesce((
      select jsonb_agg(jsonb_build_object(
        'location_id', x.location_id, 'erros', x.n, 'primeiro', x.primeiro, 'ultimo', x.ultimo,
        'instancias', (select count(*)::int from instances i2 where i2.location_id = x.location_id)))
      from (
        select s.location_id, count(*)::int n, min(s.created_at) primeiro, max(s.created_at) ultimo
        from send_errors s
        where s.error_type = 'no_instance' and s.created_at >= p_desde and s.location_id is not null
        group by 1
      ) x
    ), '[]'::jsonb)
  )
$$;
revoke all on function public.instance_watch_snapshot(timestamptz) from public, anon, authenticated;
grant execute on function public.instance_watch_snapshot(timestamptz) to service_role;

-- Cron (aplicado a parte, job 8, 2026-10-29). Desligar: select cron.alter_job(8, active := false);
-- select cron.schedule('instance-down-watch', '7,37 * * * *', $cmd$
--   select net.http_post(
--     url := 'https://mlntilbkenjjejksevdx.supabase.co/functions/v1/instance-down-watch',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'x-watch-token', public.instance_watch_token()),
--     body := '{}'::jsonb, timeout_milliseconds := 60000)
-- $cmd$);
