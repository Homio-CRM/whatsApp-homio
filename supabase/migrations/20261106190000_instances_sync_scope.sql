-- 2026-11-06 — "Sincronizar só contatos cadastrados", por número (pedido da Elegant Stones).
-- all   = toda conversa do número entra no CRM (comportamento de sempre)
-- known = só entra conversa de quem já é contato da subconta, de lead de anúncio da Meta e de quem
--         recebeu mensagem pelo CRM; o resto não cria contato nem vai pro CRM
-- Lido pela evolution-receive-message; gravado pela instance-update-settings (página de conexão).
alter table public.instances
  add column if not exists sync_scope text not null default 'all';

alter table public.instances
  drop constraint if exists instances_sync_scope_check;
alter table public.instances
  add constraint instances_sync_scope_check check (sync_scope in ('all', 'known'));

comment on column public.instances.sync_scope is
  'all = sincroniza toda conversa; known = só contatos já cadastrados (+ lead de anúncio da Meta). Página de conexão.';
