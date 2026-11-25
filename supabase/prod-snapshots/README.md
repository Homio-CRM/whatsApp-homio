# Bundles de produção (snapshots)

Cópia **exata** do que está publicado em cada Edge Function do projeto `mlntilbkenjjejksevdx`,
com o `_shared/` que aquela função usa. Em produção o `_shared/` **difere entre funções**
(em 2026-10-28: `phone.ts` da send × receive com 57 linhas de diferença, `media.ts` com 378),
então o `supabase/functions/_shared/` da raiz não representa nenhuma delas por inteiro.

Publicar a partir daqui (cada pasta é um `--workdir` completo):

```bash
npx supabase functions deploy <funcao> --project-ref mlntilbkenjjejksevdx \
  --workdir supabase/prod-snapshots/<funcao> --no-verify-jwt
```

Antes de mexer numa função, baixe de novo (`supabase functions download <funcao> --workdir <pasta>`)
e compare: alguém pode ter publicado por outro caminho.

| Função | Versão | Data | O que mudou |
|---|---|---|---|
| `instances-maintenance` | v15 | 2026-11-18 | `cleanup-stale-instances` religado (cron job 4, 08:00 BRT): exclui só o que está fora há mais de 7 dias por `status_changed_at`, confere o estado ao vivo na Evolution (aberta ou desconhecida = pula), exclui pela `evolution-delete-instance` com confirmação, teto de 10 por rodada. **JWT ligado** |
| `evolution-receive-message` | v65 | 2026-11-25 | **fala de vídeo recebido vira texto** (`transcribeVideo`: mp4 inteiro no Groq, até ~20 MB, sem reserva no Gemini; trecho sem fala é descartado por densidade de texto e lista de frases inventadas); foto do contato só enfileira em mensagem **recebida**; `connection.update` com `refused` grava `close` (o enum não aceita `refused` e o PATCH dava 400) |
| `evolution-receive-message` | v64 | 2026-11-17 | enfileira a foto do contato a cada mensagem (`contact_photo_touch`), inclusive de contato antigo |
| `contact-photo-sync` | v1 | 2026-11-16 | **nova**: foto do WhatsApp no contato da GHL (fila `contact_photos`, cron 10 só quando há fila). Upload pela conversa (`/conversations/messages/upload`): o token do app não tem `medias.*`. `_shared` = o da receive v63. `verify_jwt=false` (header `x-watch-token`) |
| `ghl-send-message` | v57 | 2026-10-28 | telefone trocado no GHL vence o guardado (`PHONE_FROM_GHL`); `#numero` tolerante (10–15 dígitos, DDI e 9) |
| `evolution-receive-message` | v60 | 2026-11-06 | "só contatos cadastrados" (`instances.sync_scope = 'known'`): 1:1 sem conversa e sem contato não cria contato nem vai pro CRM, payload sem conteúdo; contato achado pela checagem de duplicado (lê na hora; o índice da busca atrasa 10–40 s); lead de anúncio da Meta passa |
| `evolution-receive-message` | v59 | 2026-11-03 | anexo acima de `MEDIA_MAX_MB` ou que falhou vira aviso na conversa |
| `evolution-receive-message` | v57 | 2026-10-28 | adoção pelo `homio_id` grava o telefone novo; `x-retry-of` (só service role) reaproveita a linha; 502 de contato/conversa grava `failed` |
| `retry-failed-messages` | v8 | 2026-10-28 | veredito pelo status da linha, não pelo HTTP; só regrava eventos de até 30 min (mais velho vira `dead_letter`, para não disparar automação atrasada); backoff 2/5/10 min |
| `instances-maintenance` | — | 2026-10-28 | sem `MESSAGES_SET` na lista de eventos do `migrate-webhooks`. **JWT ligado**: deploy sem `--no-verify-jwt` |

`oauth-callback` (v12) e `instance-restriction-watch` (v2) não usam `_shared/` e estão em `supabase/functions/`.
