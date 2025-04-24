# WhatsApp Comparison

Este projeto é uma aplicação Next.js que apresenta uma comparação entre diferentes opções de integração do WhatsApp (Homio e Meta), permitindo aos usuários visualizar as diferenças e conectar suas contas.

## Visão Geral

A aplicação consiste em uma página principal de comparação que exibe cards para cada provedor de WhatsApp (Homio e Meta), destacando suas características, vantagens e desvantagens. Os usuários podem navegar para páginas específicas de conexão para cada provedor.

## Estrutura do Projeto

```
├── app/                              # Diretório principal do App Router do Next.js
│   ├── globals.css                   # Estilos globais da aplicação
│   ├── layout.tsx                    # Layout principal da aplicação
│   ├── page.tsx                      # Página inicial que renderiza o componente WhatsAppComparison
│   ├── whatsapp-connect/             # Rota para conexão do WhatsApp Homio
│   │   └── page.tsx                  # Página de conexão do WhatsApp Homio
│   └── whatsapp-meta-connect/        # Rota para conexão do WhatsApp Meta
│       └── page.tsx                  # Página de conexão do WhatsApp Meta
├── components/                       # Componentes reutilizáveis
│   ├── action-button.tsx             # Botão de ação personalizado com animações
│   ├── feature-item.tsx              # Item de característica usado nos cards
│   ├── whatsapp-card.tsx             # Card de provedor do WhatsApp
│   └── connection/                   # Componentes específicos para páginas de conexão
│       ├── back-button.tsx           # Botão de voltar
│       ├── background-pattern.tsx    # Componente de fundo com padrão
│       ├── connection-card.tsx       # Card de conexão do WhatsApp
│       ├── connection-grid.tsx       # Grid de cards de conexão
│       ├── help-section.tsx          # Seção de ajuda
│       └── page-header.tsx           # Cabeçalho da página
├── data/                             # Dados estáticos da aplicação
│   ├── connections.ts                # Dados de conexões do WhatsApp
│   └── whatsapp-providers.ts         # Dados dos provedores do WhatsApp
├── public/                           # Arquivos públicos
│   ├── homio-logo.svg                # Logo da Homio
│   ├── meta-logo.png                 # Logo da Meta
│   └── whatsapp-pattern-new.png      # Imagem de fundo com padrão do WhatsApp
├── types/                            # Definições de tipos TypeScript
│   ├── connection.ts                 # Tipos relacionados às conexões
│   └── index.ts                      # Tipos principais da aplicação
├── whatsapp-comparison.tsx           # Componente principal de comparação
├── tailwind.config.js                # Configuração do Tailwind CSS
└── package.json                      # Dependências e scripts do projeto
```

## Componentes Principais

### WhatsAppComparison
Componente principal que exibe a comparação entre os provedores do WhatsApp.

### WhatsAppCard
Card que exibe informações sobre um provedor específico do WhatsApp, incluindo título, subtítulo, características e botões de ação.

### ActionButton
Botão personalizado com animações e estilos dinâmicos baseados em estados (hover, focus, pressed).

### Connection Components
Conjunto de componentes para gerenciar e exibir conexões do WhatsApp na página de conexão.

## Tecnologias Utilizadas

- **Next.js**: Framework React para renderização do lado do servidor
- **TypeScript**: Tipagem estática para JavaScript
- **Tailwind CSS**: Framework CSS utilitário
- **Lucide React**: Biblioteca de ícones
- **React Hooks**: useState, useEffect para gerenciamento de estado

## Instalação e Execução

1. Clone o repositório:
```bash
git clone [url-do-repositorio]
cd whatsapp-comparison