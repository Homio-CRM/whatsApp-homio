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
| `ghl-send-message` | v57 | 2026-10-28 | telefone trocado no GHL vence o guardado (`PHONE_FROM_GHL`); `#numero` tolerante (10–15 dígitos, DDI e 9) |
| `evolution-receive-message` | v57 | 2026-10-28 | adoção pelo `homio_id` grava o telefone novo; `x-retry-of` (só service role) reaproveita a linha; 502 de contato/conversa grava `failed` |
| `retry-failed-messages` | v8 | 2026-10-28 | veredito pelo status da linha, não pelo HTTP; só regrava eventos de até 30 min (mais velho vira `dead_letter`, para não disparar automação atrasada); backoff 2/5/10 min |
| `instances-maintenance` | — | 2026-10-28 | sem `MESSAGES_SET` na lista de eventos do `migrate-webhooks`. **JWT ligado**: deploy sem `--no-verify-jwt` |

`oauth-callback` (v12) e `instance-restriction-watch` (v2) não usam `_shared/` e estão em `supabase/functions/`.
