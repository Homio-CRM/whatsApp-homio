-- Aplicada em 2026-10-28 pelo MCP em duas versions: 20261028165746 (tabela + funcao) e
-- 20261028165809 (funcao recriada: a variavel `n` conflitava com colunas `n`). Abaixo, o estado final.
-- Cron: job 7 `instance-risk-daily`, '20 6 * * *' (03:20 BRT), calcula o dia anterior:
--   select public.refresh_instance_risk_daily(((now() at time zone 'America/Sao_Paulo')::date - 1))
--
-- Metricas de risco por instancia e dia (BRT). Cada saida (API ou celular/web, sem grupo) e classificada:
--   resposta  = o contato escreveu nas 24 h anteriores
--   existente = ja havia evento com o contato na janela (ate 7 dias antes), sem resposta recente
--   nova      = primeiro contato visto na janela (webhook_events guarda ~7 dias; aproximado)
create table if not exists public.instance_risk_daily (
  dia date not null,
  instance_name text not null,
  location_id text,
  api_envios integer not null default 0,
  celular_envios integer not null default 0,
  recebidas integer not null default 0,
  saidas_resposta integer not null default 0,
  saidas_existente integer not null default 0,
  saidas_novas integer not null default 0,
  dest_saida integer not null default 0,
  dest_sem_resposta integer not null default 0,
  pico_por_minuto integer not null default 0,
  invalid_phone_subconta integer not null default 0,   -- send_errors da subconta inteira no dia
  computed_at timestamptz not null default now(),
  primary key (dia, instance_name)
);
alter table public.instance_risk_daily enable row level security;
revoke all on public.instance_risk_daily from anon, authenticated;
grant select, insert, update, delete on public.instance_risk_daily to service_role;

create or replace function public.refresh_instance_risk_daily(p_dia date) returns integer
language plpgsql security definer set search_path = public as $$
declare
  ini timestamptz := (p_dia::timestamp at time zone 'America/Sao_Paulo');
  fim timestamptz := ((p_dia + 1)::timestamp at time zone 'America/Sao_Paulo');
  v_linhas integer;
begin
  delete from instance_risk_daily where dia = p_dia;

  with ev as (
    select w.id, w.instance_name inst, w.received_at t,
      case when w.event_type = 'send.message' then 'api'
           when w.payload->'data'->'key'->>'fromMe' = 'true' then 'celular' else 'entrada' end tipo,
      w.payload->'data'->'key'->>'remoteJid' jid, w.payload->'data'->'key'->>'remoteJidAlt' jid_alt
    from webhook_events w
    where w.event_type in ('send.message', 'messages.upsert')
      and w.received_at >= ini - interval '7 days' and w.received_at < fim
      and coalesce(w.payload->'data'->'key'->>'remoteJid', '') not like '%@g.us'
      and coalesce(w.payload->'data'->'key'->>'remoteJid', '') not like '%@broadcast'
      and coalesce(w.payload->'data'->'key'->>'remoteJid', '') not like '%@newsletter'
  ), ent as (
    select inst, t, jid from ev where tipo = 'entrada' and jid is not null
    union all
    select inst, t, jid_alt from ev where tipo = 'entrada' and jid_alt is not null
  ), primeiro as (
    select inst, jid, min(t) t0
    from (select inst, t, jid from ev where jid is not null union all select inst, t, jid from ent) x
    group by 1, 2
  ), sai as (
    select e.id, e.inst, e.t, e.tipo, e.jid, (p.t0 < e.t) existente
    from ev e join primeiro p on p.inst = e.inst and p.jid = e.jid
    where e.tipo in ('api', 'celular') and e.t >= ini
  ), resp as (
    select distinct s.id from sai s
    join ent on ent.inst = s.inst and ent.jid = s.jid and ent.t < s.t and ent.t > s.t - interval '24 hours'
  ), ent_dia as (
    select distinct inst, jid from ent where t >= ini
  ), sem_resp as (
    select s.inst, count(distinct s.jid) qtd from sai s
    left join ent_dia d on d.inst = s.inst and d.jid = s.jid
    where d.jid is null group by 1
  ), pico as (
    select inst, max(qtd) qtd from (select inst, date_trunc('minute', t) m, count(*) qtd from sai group by 1, 2) x group by 1
  ), agg_sai as (
    select s.inst,
      count(*) filter (where s.tipo = 'api') api_envios,
      count(*) filter (where s.tipo = 'celular') celular_envios,
      count(*) filter (where r.id is not null) saidas_resposta,
      count(*) filter (where r.id is null and s.existente) saidas_existente,
      count(*) filter (where r.id is null and not s.existente) saidas_novas,
      count(distinct s.jid) dest_saida
    from sai s left join resp r on r.id = s.id group by 1
  ), agg_ent as (
    select inst, count(*) recebidas from ev where tipo = 'entrada' and t >= ini group by 1
  ), insts as (
    select inst from agg_sai union select inst from agg_ent
  ), inval as (
    select location_id, count(*) qtd from send_errors
    where error_type = 'invalid_phone' and created_at >= ini and created_at < fim group by 1
  )
  insert into instance_risk_daily (dia, instance_name, location_id, api_envios, celular_envios, recebidas,
    saidas_resposta, saidas_existente, saidas_novas, dest_saida, dest_sem_resposta, pico_por_minuto, invalid_phone_subconta)
  select p_dia, i.inst, ins.location_id,
    coalesce(a.api_envios, 0), coalesce(a.celular_envios, 0), coalesce(e.recebidas, 0),
    coalesce(a.saidas_resposta, 0), coalesce(a.saidas_existente, 0), coalesce(a.saidas_novas, 0),
    coalesce(a.dest_saida, 0), coalesce(sr.qtd, 0), coalesce(pc.qtd, 0), coalesce(iv.qtd, 0)
  from insts i
  left join agg_sai a on a.inst = i.inst
  left join agg_ent e on e.inst = i.inst
  left join sem_resp sr on sr.inst = i.inst
  left join pico pc on pc.inst = i.inst
  left join lateral (select location_id::text from instances where evolution_name = i.inst limit 1) ins on true
  left join inval iv on iv.location_id = ins.location_id;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end $$;
revoke all on function public.refresh_instance_risk_daily(date) from public, anon, authenticated;
grant execute on function public.refresh_instance_risk_daily(date) to service_role;
