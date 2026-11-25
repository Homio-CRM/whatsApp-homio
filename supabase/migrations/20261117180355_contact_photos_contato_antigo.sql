-- 2026-11-17 — decisão do Luan: contato antigo que manda mensagem também ganha foto.
-- Antes: contato sem linha em contact_photos e sem conversa nova -> 'noop' (só conversa nova entrava).
-- Agora: a primeira mensagem de qualquer contato de subconta ligada põe o contato na fila.
-- Sem lote: só entra quem interage; depois disso vale o recheck_hours (24 h) como antes.
create or replace function public.contact_photo_touch(p_location_id text, p_contact_id text, p_conversation_id text, p_jid text, p_instance_name text, p_is_group boolean, p_is_new boolean)
 returns text
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if coalesce(p_location_id, '') = '' or coalesce(p_contact_id, '') = '' or coalesce(p_jid, '') = ''
     or coalesce(p_instance_name, '') = '' then
    return 'skip:args';
  end if;
  if not public.contact_photo_enabled(p_location_id) then return 'off'; end if;

  if p_is_new then
    insert into public.contact_photos (location_id, contact_id, conversation_id, jid, instance_name, is_group)
    values (p_location_id, p_contact_id, nullif(p_conversation_id, ''), p_jid, p_instance_name, coalesce(p_is_group, false))
    on conflict (location_id, contact_id) do update
      set last_seen_at = now(), jid = excluded.jid, instance_name = excluded.instance_name,
          conversation_id = coalesce(excluded.conversation_id, public.contact_photos.conversation_id),
          is_group = excluded.is_group, updated_at = now();
    return 'queued';
  end if;

  -- mensagem de contato que ja tem linha: marca a interacao (no maximo uma escrita a cada 10 min)
  update public.contact_photos
     set last_seen_at = now(), jid = p_jid, instance_name = p_instance_name,
         conversation_id = coalesce(nullif(p_conversation_id, ''), conversation_id), updated_at = now()
   where location_id = p_location_id and contact_id = p_contact_id
     and last_seen_at < now() - interval '10 minutes';
  if found then return 'touched'; end if;

  -- contato antigo ainda sem linha: entra na fila na primeira mensagem (2026-11-17)
  insert into public.contact_photos (location_id, contact_id, conversation_id, jid, instance_name, is_group)
  values (p_location_id, p_contact_id, nullif(p_conversation_id, ''), p_jid, p_instance_name, coalesce(p_is_group, false))
  on conflict (location_id, contact_id) do nothing;
  return case when found then 'queued' else 'noop' end;
end $function$;

revoke all on function public.contact_photo_touch(text, text, text, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.contact_photo_touch(text, text, text, text, text, boolean, boolean) to service_role;
