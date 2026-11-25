-- Aplicada em 2026-11-16 17:23 BRT pelo MCP (version 20261116202301).
-- Foto do WhatsApp no contato da GHL (wiki: projetos/whatsapp_homio_foto_contato.md). 2026-11-16.
--
-- A evolution-receive-message so chama contact_photo_touch() (uma linha por mensagem, sem esperar);
-- o trabalho fica na EF contact-photo-sync (cron a cada 2 min), que pode falhar sozinha.
-- Decidido com o Luan em 2026-11-03: so contato NOVO (conversa criada pela receive depois da ativacao),
-- conferencia so quando o contato interage (no maximo 1 a cada 24 h), foto removida no WhatsApp nao
-- remove na GHL, foto posta por outra via (`manual`) nunca e tocada.
--
-- Mudanca contra o desenho de 03/11: a imagem NAO vai para a Media Library. O token do app WhatsApp Homio
-- (client 66e869224b888a3b0923a502) nao tem escopo medias.* (conferido no JWT em 2026-11-16; por isso
-- nenhuma das 41 instancias tem instance_folder_id). Vai pelo upload de conversa
-- (POST /conversations/messages/upload, o mesmo dos anexos da receive): link permanente da GHL, fora
-- da Media Library do cliente.
--
-- Interruptor: contact_photo_config.mode ('off' | 'pilot' | 'on') + location_settings.contact_photo
-- (null = segue o modo; true = liga no piloto; false = desliga mesmo com 'on'). No banco e nao em
-- secret porque `supabase secrets set` republica todas as EFs do projeto.

create table if not exists public.contact_photo_config (
  id            int primary key default 1 check (id = 1),
  mode          text not null default 'pilot' check (mode in ('off', 'pilot', 'on')),
  per_instance  int  not null default 20,   -- fotos por instancia por rodada (nao martelar um numero)
  recheck_hours int  not null default 24,   -- intervalo minimo entre conferencias do mesmo contato
  updated_at    timestamptz not null default now()
);
insert into public.contact_photo_config (id) values (1) on conflict (id) do nothing;

alter table public.location_settings add column if not exists contact_photo boolean;
comment on column public.location_settings.contact_photo is
  'Foto do WhatsApp no contato: null segue contact_photo_config.mode; true liga (inclusive no piloto); false desliga';

create table if not exists public.contact_photos (
  id              bigserial primary key,
  location_id     text not null,
  contact_id      text not null,                 -- contato na GHL
  conversation_id text,                          -- conversa na GHL (homio_id): o upload e por conversa
  jid             text not null,                 -- telefone (55...), LID (...@lid) ou grupo (...@g.us)
  instance_name   text not null,                 -- instancia que busca a foto (a ultima que viu o contato)
  is_group        boolean not null default false,
  status          text not null default 'pendente'
                  check (status in ('pendente', 'ok', 'sem_foto', 'manual', 'erro')),
  wa_photo_path   text,                          -- caminho da URL do WhatsApp = identidade da foto
  ghl_url         text,                          -- o link que NOS gravamos no profilePhoto
  checked_at      timestamptz,
  next_check_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),  -- ultima mensagem do/para o contato
  claimed_until   timestamptz,                   -- trava da rodada do cron
  tentativas      int not null default 0,
  erro            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (location_id, contact_id)
);
create index if not exists contact_photos_devidas on public.contact_photos (next_check_at) where status <> 'manual';

alter table public.contact_photo_config enable row level security;
alter table public.contact_photos       enable row level security;
revoke all on public.contact_photo_config, public.contact_photos from anon, authenticated;
grant select, insert, update, delete on public.contact_photo_config, public.contact_photos to service_role;
revoke all on sequence public.contact_photos_id_seq from anon, authenticated;
grant usage, select on sequence public.contact_photos_id_seq to service_role;

-- A subconta esta ligada?
create or replace function public.contact_photo_enabled(p_location_id text)
returns boolean language sql stable set search_path = public as $$
  select case
    when c.mode is null or c.mode = 'off' then false
    when ls.contact_photo is false then false
    when c.mode = 'on' then true
    else coalesce(ls.contact_photo, false)          -- pilot: so quem tem true
  end
  from (select 1) x
  left join public.contact_photo_config c on c.id = 1
  left join public.location_settings ls on ls.location_id = p_location_id
$$;

-- Chamada pela receive a cada mensagem processada. p_is_new = a conversa nasceu nesta invocacao.
-- Contato que ja existia (sem linha aqui) nao entra: so os novos a partir da ativacao.
create or replace function public.contact_photo_touch(
  p_location_id text, p_contact_id text, p_conversation_id text, p_jid text,
  p_instance_name text, p_is_group boolean, p_is_new boolean
) returns text language plpgsql set search_path = public as $$
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
  return case when found then 'touched' else 'noop' end;
end $$;

-- Rodada do cron: pega as linhas devidas, no maximo p_per_instance por instancia (so instancia `open`)
-- e trava por 5 min. Devida = passou o next_check_at E (nunca conferida, ou erro com tentativa sobrando,
-- ou o contato interagiu depois da ultima conferencia).
create or replace function public.contact_photo_claim(p_per_instance int, p_total int)
returns setof public.contact_photos language sql set search_path = public as $$
  with devidas as (
    select cp.id, row_number() over (partition by cp.instance_name order by cp.next_check_at, cp.id) as rn
      from public.contact_photos cp
      join public.instances i on i.evolution_name = cp.instance_name and i.status::text = 'open'
     where cp.status <> 'manual'
       and cp.next_check_at <= now()
       and (cp.claimed_until is null or cp.claimed_until < now())
       and (cp.status = 'pendente'
            or (cp.status = 'erro' and cp.tentativas < 5)
            or cp.last_seen_at > coalesce(cp.checked_at, '-infinity'::timestamptz))
       and public.contact_photo_enabled(cp.location_id)
  ), escolhidas as (
    select id from devidas where rn <= p_per_instance order by id limit p_total
  )
  update public.contact_photos cp
     set claimed_until = now() + interval '5 minutes'
    from escolhidas e
   where cp.id = e.id and (cp.claimed_until is null or cp.claimed_until < now())
  returning cp.*;
$$;

revoke execute on function public.contact_photo_enabled(text) from public, anon, authenticated;
revoke execute on function public.contact_photo_touch(text, text, text, text, text, boolean, boolean) from public, anon, authenticated;
revoke execute on function public.contact_photo_claim(int, int) from public, anon, authenticated;
grant execute on function public.contact_photo_enabled(text) to service_role;
grant execute on function public.contact_photo_touch(text, text, text, text, text, boolean, boolean) to service_role;
grant execute on function public.contact_photo_claim(int, int) to service_role;

-- Piloto: so a Internal Testing (instancia d8voPwkhJK7k7S5xjHcA-1, numero do Luan).
update public.location_settings set contact_photo = true, updated_at = now() where location_id = 'd8voPwkhJK7k7S5xjHcA';
