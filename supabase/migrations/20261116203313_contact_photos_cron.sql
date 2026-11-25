-- Aplicada em 2026-11-16 17:33 BRT pelo MCP (version 20261116203313).
-- Foto do contato, parte 2 (2026-11-16): criterio de "devida" num lugar so + cron.
-- A view e usada pelo claim da EF e pelo cron, que so chama a EF quando ha linha devida: fila vazia nao
-- gasta invocacao (o desenho previa ~21,6 mil chamadas/mes com cron cego de 2 min).
-- Pula instancia com 401 nas ultimas 24 h (instance_restriction_alerts, gravada pelo instance-restriction-watch):
-- consultar foto em numero possivelmente restrito nao vale o risco.

create or replace view public.contact_photos_fila with (security_invoker = true) as
select cp.*
  from public.contact_photos cp
  join public.instances i on i.evolution_name = cp.instance_name and i.status::text = 'open'
 where cp.status <> 'manual'
   and cp.next_check_at <= now()
   and (cp.claimed_until is null or cp.claimed_until < now())
   and (cp.status = 'pendente'
        or (cp.status = 'erro' and cp.tentativas < 5)
        or cp.last_seen_at > coalesce(cp.checked_at, '-infinity'::timestamptz))
   and public.contact_photo_enabled(cp.location_id)
   and not exists (select 1 from public.instance_restriction_alerts a
                    where a.instance_name = cp.instance_name and a.closed_at > now() - interval '24 hours');

revoke all on public.contact_photos_fila from anon, authenticated;
grant select on public.contact_photos_fila to service_role;

create or replace function public.contact_photo_claim(p_per_instance int, p_total int)
returns setof public.contact_photos language sql set search_path = public as $$
  with devidas as (
    select d.id, row_number() over (partition by d.instance_name order by d.next_check_at, d.id) as rn
      from public.contact_photos_fila d
  ), escolhidas as (
    select id from devidas where rn <= p_per_instance order by id limit p_total
  )
  update public.contact_photos cp
     set claimed_until = now() + interval '5 minutes'
    from escolhidas e
   where cp.id = e.id and (cp.claimed_until is null or cp.claimed_until < now())
  returning cp.*;
$$;
revoke execute on function public.contact_photo_claim(int, int) from public, anon, authenticated;
grant execute on function public.contact_photo_claim(int, int) to service_role;

select cron.schedule('contact-photo-sync', '*/2 * * * *', $cron$
  select net.http_post(
    url := 'https://mlntilbkenjjejksevdx.supabase.co/functions/v1/contact-photo-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-watch-token', public.instance_watch_token()),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000)
  where exists (select 1 from public.contact_photos_fila)
$cron$);
