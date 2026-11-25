-- Aplicada em 2026-10-28 (~14:42 BRT) pelo MCP. Primeira tentativa com "drop trigger if exists" travou no
-- MCP (comando destrutivo pede confirmacao); reaplicada com "create or replace trigger".
-- Status das instancias "na hora" na pagina de conexao sem abrir a tabela.
-- Antes: Supabase Realtime postgres_changes em `instances` com a anon key, que entregava a linha inteira
-- (inclusive instance_api_key) e parou quando a tabela ganhou RLS. Agora um gatilho publica so
-- {instance, status} num canal de Broadcast publico por subconta: `instances:<location_id>`.
-- A pagina ouve o canal e recarrega pela EF. Falha no Realtime nunca bloqueia o update de status.
-- Testado: ouvinte com a anon recebeu close/connecting de bWUO1BvKlvjPZUNHq9tc-1 em ~1 s.
create or replace function public.instances_broadcast_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if tg_op = 'DELETE' then
      perform realtime.send(jsonb_build_object('instance', old.evolution_name, 'status', 'deleted'),
        'status', 'instances:' || old.location_id, false);
    elsif tg_op = 'INSERT' or old.status is distinct from new.status then
      perform realtime.send(jsonb_build_object('instance', new.evolution_name, 'status', new.status),
        'status', 'instances:' || new.location_id, false);
    end if;
  exception when others then
    raise warning 'instances_broadcast_status: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.instances_broadcast_status() from public, anon, authenticated;

create or replace trigger instances_broadcast_status
  after insert or update or delete on public.instances
  for each row execute function public.instances_broadcast_status();
