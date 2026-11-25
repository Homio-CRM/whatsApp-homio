-- Aplicada em 2026-10-28 12:13 BRT pelo MCP (version 20261028151319).
-- A anon key (publica, vai no bundle do front) lia e escrevia em 14 tabelas sem RLS,
-- inclusive agency_token e location_tokens. Todo acesso legitimo e service_role (EFs, cron, pg_net):
-- 24 h de log do gateway sem nenhuma chamada REST com outro papel; o front so chama EFs.
-- Efeito colateral aceito: o Realtime de `instances` (connectionGrid) deixa de entregar para anon;
-- o front passou a revalidar por polling (commit 40c571c).
-- Reverter (tabela a tabela): alter table public.<t> disable row level security;
--   grant select, insert, update, delete on public.<t> to anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['agency_token','billing_messages','billing_templates','conversations','historico_queue',
    'history_worker_lock','instances','location_tokens','message_reactions','messages','providers','send_errors',
    'send_queue','webhook_events']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  -- defesa em profundidade: nenhum privilegio de tabela para anon/authenticated no public
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r','p','v','m')
  loop
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- views antigas rodavam com o dono e furavam o RLS
alter view public.v_failed_events set (security_invoker = true);
alter view public.v_instance_health set (security_invoker = true);
alter view public.v_messages_summary set (security_invoker = true);
alter view public.v_metrics_by_instance set (security_invoker = true);
alter view public.v_metrics_daily set (security_invoker = true);
alter view public.v_metrics_hourly set (security_invoker = true);

-- funcoes da fila de historico: so o worker (service_role)
revoke execute on function public.claim_history_jobs(integer) from public, anon, authenticated;
revoke execute on function public.try_acquire_history_worker_lock(integer) from public, anon, authenticated;
revoke execute on function public.release_history_worker_lock() from public, anon, authenticated;
grant execute on function public.claim_history_jobs(integer) to service_role;
grant execute on function public.try_acquire_history_worker_lock(integer) to service_role;
grant execute on function public.release_history_worker_lock() to service_role;
