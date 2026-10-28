// whatsapp-custom-js/script.js — Custom JS consolidado da agencia Homio (nucleo window.Homio +
// blocos 0, 2, 3, 4, 5, 6, 7, 8 e 11), servido pela EF whatsapp-custom-js como
//   ;(homioCustomJs.toString())();
// Montado em 2026-10-21 a partir do campo Agency Settings → Company → Custom JavaScript
// (copia em luan 2/raw/whatsapp_homio_custom_js_2026-10-21.js). Daqui em diante ESTE arquivo e a
// fonte: editar, deploy da EF, Ctrl+Shift+R na GHL. As tags <script src> externas (blocos 9 e 10,
// whatsapp-alerta, message-reactions) continuam no campo da agencia.
export function homioCustomJs() {
/* ═══════════════════════════════════════════════════════════════════════════
   0. NÚCLEO COMPARTILHADO  ·  window.Homio
   ═══════════════════════════════════════════════════════════════════════════
   Precisa vir antes de todos os outros blocos.

   POR QUE ELE EXISTE

   A versão anterior tinha quatro MutationObservers permanentes em
   document.body com subtree, e três setInterval que nunca paravam, em 500ms,
   500ms e 1500ms. Cada bloco vigiava a página por conta própria.

   O GHL é uma aplicação Vue: a árvore do DOM muda o tempo todo. Com quatro
   observers sem espera, qualquer digitação disparava quatro varreduras. A
   própria documentação da plataforma pede para não usar "código que degrade
   a performance ou bloqueie a thread principal".

   Aqui existe UM observer com espera curta e UM intervalo de segurança. Os
   blocos se inscrevem e são chamados juntos.

   O QUE ELE OFERECE

     Homio.contas              mapa de subcontas com nome legível
     Homio.locationId()        id da subconta atual, ou null
     Homio.naConta(nome)       true se estamos na subconta nomeada
     Homio.naRota(trecho)      true se o caminho contém o trecho
     Homio.aoNavegar(fn)       chama fn quando a URL muda
     Homio.aoMudarDom(fn)      chama fn quando o DOM muda, com espera
     Homio.quandoPronto(fn)    chama fn com o documento pronto
     Homio.cantos              alturas reservadas no canto inferior direito
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  if (window.Homio) return;

  /* ── Mapa de subcontas ───────────────────────────────────────────────────
     Todo identificador de subconta usado neste arquivo mora aqui. Antes eles
     estavam espalhados por cinco blocos, e o mesmo id aparecia em dois
     lugares diferentes sem nenhuma indicação de que eram a mesma conta.

     A plataforma não oferece campo de código por subconta, só por agência.
     É por isso que precisamos filtrar por id na mão: estamos simulando um
     recurso que não existe. */
  var CONTAS = {
    // Usa SMS de verdade. Não renomear nem esconder o canal.
    smsReal: 'wsldse1ZJdG8zWI8OILI',
    // Não recebe o botão de gravar áudio.
    semAudio: 'JBQS1sEvw4LWXtYyBHR3',
    // Funil com cores por estágio.
    funilColorido: 'BkYLtZ36yRtOBPE0lWpg',
    // Recebem o widget de suporte.
    suporteA: 'A4UXfh6CvpRSIZGt4x9U',
    suporteB: 'BInYnMNoxD2wRvqFpcCQ'
  };

  /* ── Canto inferior direito ──────────────────────────────────────────────
     Três widgets disputam esse canto: o assistente da documentação, o de
     suporte e o de agente de IA. Na versão anterior o de documentação ficava
     em bottom 4% e o de suporte em bottom 0 com 80px de altura, e os dois se
     sobrepunham numa faixa de 32px nas subcontas que têm suporte.

     As alturas ficam aqui para que a sobreposição seja uma decisão visível,
     e não um acidente. Cada bloco lê o seu valor. */
  var CANTOS = {
    suporte: 0,    // widget de suporte, 80px de altura
    docs: 96,      // assistente da documentação, acima do de suporte
    margemLateral: 16
  };

  var ESPERA_DOM = 150;   // ms de espera antes de reagir a mudanças no DOM
  var RONDA_URL = 1000;   // ms da rede de segurança de navegação

  var ouvintesDom = [];
  var ouvintesNav = [];
  var agendado = null;
  var ultimoCaminho = location.pathname;

  function locationId() {
    var m = location.pathname.match(/\/location\/([^\/]+)/);
    return m ? m[1] : null;
  }

  function naConta(nome) {
    var id = CONTAS[nome];
    return !!id && locationId() === id;
  }

  function naRota(trecho) {
    return location.pathname.indexOf(trecho) !== -1;
  }

  /* Um ouvinte que estoura não pode derrubar os outros. */
  function disparar(lista) {
    for (var i = 0; i < lista.length; i++) {
      try {
        lista[i]();
      } catch (e) {
        console.error('[Homio] ouvinte falhou:', e);
      }
    }
  }

  /* Compara pathname e não href de propósito: a plataforma troca parâmetros
     de consulta o tempo todo, como ?tab=summary, e nenhum bloco daqui depende
     deles. Comparar a URL inteira fazia tudo rodar de novo à toa. */
  function verificarNavegacao() {
    if (location.pathname === ultimoCaminho) return;
    ultimoCaminho = location.pathname;
    disparar(ouvintesNav);
  }

  /* A espera é o que torna um observer global aceitável: uma rajada de
     mutações vira uma única chamada. */
  var pendenteEnquantoOculta = false;

  function agendarDom() {
    /* Aba em segundo plano não recebe trabalho. O painel fica aberto o dia
       inteiro em aba parada, e continuar varrendo o DOM ali é gasto puro.
       A marca abaixo garante que, ao voltar, tudo se atualize uma vez. */
    if (document.hidden) {
      pendenteEnquantoOculta = true;
      return;
    }
    if (agendado) return;
    agendado = setTimeout(function () {
      agendado = null;
      verificarNavegacao();
      disparar(ouvintesDom);
    }, ESPERA_DOM);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !pendenteEnquantoOculta) return;
    pendenteEnquantoOculta = false;
    agendarDom();
  });

  var observador = new MutationObserver(agendarDom);

  function ligarObservador() {
    if (document.body) {
      observador.observe(document.body, { childList: true, subtree: true });
    }
  }

  /* A navegação do GHL passa por pushState e replaceState. Interceptamos os
     dois em um lugar só; antes um dos blocos fazia isso por conta própria. */
  var pushOriginal = history.pushState;
  history.pushState = function () {
    pushOriginal.apply(this, arguments);
    verificarNavegacao();
  };

  var replaceOriginal = history.replaceState;
  history.replaceState = function () {
    replaceOriginal.apply(this, arguments);
    verificarNavegacao();
  };

  window.addEventListener('popstate', verificarNavegacao);

  /* Rede de segurança, para navegação que não passe por nenhum dos caminhos
     acima. Um intervalo lento no lugar dos três que existiam. */
  setInterval(function () {
    if (!document.hidden) verificarNavegacao();
  }, RONDA_URL);

  function quandoPronto(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  window.Homio = {
    contas: CONTAS,
    cantos: CANTOS,
    locationId: locationId,
    naConta: naConta,
    naRota: naRota,
    quandoPronto: quandoPronto,

    /* Chamado quando a URL muda. Use para ligar e desligar recursos por
       página. O ouvinte também roda uma vez agora, para cobrir o caso de a
       página já ter carregado no destino certo. */
    aoNavegar: function (fn) {
      ouvintesNav.push(fn);
      quandoPronto(fn);
    },

    /* Chamado quando o DOM muda, com espera. Use para reagir a telas que a
       plataforma monta de forma assíncrona. Mantenha a função barata: ela
       roda para qualquer mudança em qualquer lugar do painel. */
    aoMudarDom: function (fn) {
      ouvintesDom.push(fn);
    }
  };

  quandoPronto(ligarObservador);
})();

/* ═══════════════════════════════════════════════════════════════════════════
   2. BOTÃO VISITAR EM CAMPOS DE URL
   ═══════════════════════════════════════════════════════════════════════════
   Na ficha do contato, campos de texto que contenham uma URL válida ganham um
   botão ao lado que abre o endereço em nova aba.

   MUDANÇA NESTA VERSÃO: o bloco praticamente não rodava. A versão anterior
   chamava a rotina uma única vez, no carregamento, e desistia se a URL não
   fosse de ficha de contato. Como o GHL é aplicação de página única, quem
   entrava pelo painel e navegava até um contato nunca disparava o script:
   ele só funcionava abrindo o endereço do contato direto na barra.

   Agora o bloco se inscreve na navegação e na mudança do DOM pelo núcleo.
   Também saíram os console.log, que escreviam a cada segundo.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var ROTA = '/contacts/detail/';
  var MARCA = 'homio-campo-url';

  function ehUrl(texto) {
    try {
      var u = new URL(texto);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch (e) {
      return false;
    }
  }

  function transformar(input) {
    if (!input || !input.value) return;
    if (input.closest('.' + MARCA)) return;          // já transformado
    if (!input.closest('.hl-text-input-container')) return;
    if (!ehUrl(input.value)) return;

    var wrapper = document.createElement('div');
    wrapper.className = 'flex gap-2 items-center ' + MARCA;

    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    input.style.flex = '1';

    var botao = document.createElement('a');
    botao.href = input.value;
    botao.target = '_blank';
    botao.rel = 'noopener noreferrer';
    botao.className = 'flex-shrink-0 px-3 py-2 text-white rounded hover:text-white text-sm';
    botao.textContent = 'Visitar →';
    botao.style.minWidth = '70px';
    botao.style.textAlign = 'center';
    botao.style.backgroundColor = '#af4afd';
    botao.addEventListener('mouseenter', function () { botao.style.backgroundColor = '#560099'; });
    botao.addEventListener('mouseleave', function () { botao.style.backgroundColor = '#af4afd'; });

    wrapper.appendChild(botao);

    input.addEventListener('input', function (e) {
      if (ehUrl(e.target.value)) {
        botao.href = e.target.value;
        botao.style.display = 'block';
      } else {
        botao.style.display = 'none';
      }
    });
  }

  function varrer() {
    if (!window.Homio.naRota(ROTA)) return;
    var campos = document.querySelectorAll('input[type="text"]');
    for (var i = 0; i < campos.length; i++) {
      if (campos[i].value && ehUrl(campos[i].value)) transformar(campos[i]);
    }
  }

  window.Homio.aoNavegar(varrer);
  window.Homio.aoMudarDom(varrer);
})();

/* ═══════════════════════════════════════════════════════════════════════════
   3. CANAIS DE ENVIO  ·  renomear SMS, rotular pelo número e filtrar instâncias
   ═══════════════════════════════════════════════════════════════════════════
   No seletor de canal da tela de conversas e no chip do compositor:

     renomear   o rótulo "SMS" vira "WhatsApp Homio"
     rotular    cada canal WhatsApp Homio / WA Homio n mostra o número
                conectado e o nome do perfil: "(27) 99299-8039 · Dara"
     esconder   o canal "sms" real sai da lista
     filtrar    das instâncias WA Homio, só aparecem as conectadas

   O nome ORIGINAL do provider fica em data-homio-provider no elemento do
   rótulo. É por ele que o filtro decide e que o bloco 6 (áudio) sabe qual
   canal mandar para a ghl-send-audio: o texto visível deixou de ser chave.

   A lista vem da evolution-get-instances (providerName, number e name por
   instância), por subconta, com validade de 5 minutos. Ela é buscada ao
   abrir uma conversa, e não só ao abrir o seletor, para o chip do compositor
   já vir rotulado.

   A subconta contas.smsReal usa SMS de verdade e fica de fora de tudo.

   MUDANÇA NESTA VERSÃO (2026-10-21): rótulo com número e perfil; "WA Homio 4"
   (5º slot) reconhecido por padrão (/^WA Homio( \d+)?$/) em vez de lista
   fixa. Mantido da versão anterior: a marca de "já busquei" só liga quando a
   resposta chega, então falha de rede deixa o filtro sem efeito em vez de
   esconder todos os canais.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var SELETOR_POPOVER = '.hr-popover__content';
  var SELETOR_CHIP = '#conv-channel-bar-provider-trigger span.text-primary-600';
  var SELETOR_CABECALHO = 'span.text-sm.font-medium.text-gray-700';
  var ENDPOINT = 'https://mlntilbkenjjejksevdx.supabase.co/functions/v1/evolution-get-instances';
  var EH_WA = /^WA Homio( \d+)?$/;
  var VALIDADE_MS = 5 * 60 * 1000;
  var MAX_NOME = 22;

  var porProvider = {};      // nome do canal -> { number, name, open }
  var conectadas = [];       // nomes de canal com instância open
  var buscou = false;
  var buscouEm = 0;
  var buscando = null;
  var ultimaConta = null;
  var observadorConteudo = null;

  /* A subconta que usa SMS de verdade não passa por renomear, rotular nem esconder. */
  function deveMexer() {
    return !window.Homio.naConta('smsReal');
  }

  /* 'Whats Homio' (slot 1) é o canal SMS da GHL, que renomeamos para
     'WhatsApp Homio'. Os outros chegam com o mesmo nome que o dropdown mostra. */
  function nomeNoDropdown(providerName) {
    var n = (providerName || '').trim();
    if (n === 'Whats Homio' || n === 'WhatsApp Homio' || n === 'SMS') return 'WhatsApp Homio';
    return n;
  }

  /* 5527992998039 -> "(27) 99299-8039"; 552732056999 -> "(27) 3205-6999".
     Fora do Brasil fica "+351934466732", sem adivinhar máscara. */
  function formatarNumero(digitos) {
    var d = String(digitos || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.slice(0, 2) === '55' && (d.length === 12 || d.length === 13)) {
      var ddd = d.slice(2, 4);
      var resto = d.slice(4);
      var corte = resto.length - 4;
      return '(' + ddd + ') ' + resto.slice(0, corte) + '-' + resto.slice(corte);
    }
    return '+' + d;
  }

  function encurtar(nome) {
    var n = (nome || '').trim();
    if (n.length <= MAX_NOME) return n;
    return n.slice(0, MAX_NOME - 1).replace(/\s+$/, '') + '…';
  }

  /* Rótulo visível de um canal, ou null quando não há número para mostrar
     (instância sem pareamento, ou provider sem instância nesta subconta). */
  function rotuloDe(nome) {
    var inst = porProvider[nome];
    if (!inst || !inst.number) return null;
    var num = formatarNumero(inst.number);
    var perfil = encurtar(inst.name);
    return perfil ? num + ' · ' + perfil : num;
  }

  function buscarInstancias(locationId) {
    if (buscando) return buscando;
    buscando = fetch(ENDPOINT + '?locationId=' + encodeURIComponent(locationId))
      .then(function (r) { return r.json(); })
      .then(function (json) {
        var mapa = {};
        var abertas = [];
        (json.instances || []).forEach(function (i) {
          var nome = nomeNoDropdown(i.providerName);
          if (!nome) return;
          var aberta = i.connectionStatus === 'open';
          /* duas instâncias no mesmo canal: a aberta ganha */
          if (mapa[nome] && mapa[nome].open && !aberta) return;
          mapa[nome] = { number: i.number || '', name: i.name || '', open: aberta };
          if (aberta && abertas.indexOf(nome) === -1) abertas.push(nome);
        });
        porProvider = mapa;
        conectadas = abertas;
        buscou = true;   // só aqui: uma falha não pode marcar como buscado
        buscouEm = Date.now();
        return true;
      })
      .catch(function () {
        return false;
      })
      .then(function (ok) {
        buscando = null;
        return ok;
      });
    return buscando;
  }

  /* Garante a lista da subconta atual, com validade. Resolve quando há lista
     (ou quando a busca falhou, caso em que nada é escondido nem rotulado). */
  function garantirInstancias() {
    var conta = window.Homio.locationId();
    if (!conta) return Promise.resolve(false);
    if (conta !== ultimaConta) {
      buscou = false;
      porProvider = {};
      conectadas = [];
      ultimaConta = conta;
    }
    if (buscou && Date.now() - buscouEm < VALIDADE_MS) return Promise.resolve(true);
    return buscarInstancias(conta);
  }

  /* Sobe no DOM até o item clicável que envolve o rótulo. */
  function itemDoProvedor(div) {
    var atual = div;
    while (atual && atual.parentElement) {
      var clicavel = atual.classList.contains('cursor-pointer');
      var emLinha = atual.classList.contains('flex') &&
        atual.classList.contains('items-center') &&
        atual.classList.contains('justify-between');
      if (clicavel || emLinha) return atual;
      atual = atual.parentElement;
    }
    return null;
  }

  function renomear(popover) {
    if (!popover || !deveMexer()) return;

    var divs = Array.prototype.slice.call(popover.querySelectorAll('div'));
    divs.forEach(function (div) {
      if (div.dataset.originalText) return;
      var walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, null, false);
      var no;
      while ((no = walker.nextNode())) {
        if (no.textContent.trim() === 'SMS') {
          no.textContent = no.textContent.replace(/SMS/g, 'WhatsApp Homio');
          div.dataset.originalText = 'SMS';
          break;
        }
      }
    });
  }

  /* Texto cru de um canal nosso -> nome do canal; qualquer outro texto -> null. */
  function canalDoTexto(texto) {
    if (texto === 'SMS' || texto === 'WhatsApp Homio') return 'WhatsApp Homio';
    if (EH_WA.test(texto)) return texto;
    return null;
  }

  /* Troca o texto cru pelo rótulo com número e guarda o nome original em
     data-homio-provider no elemento pai do texto. Idempotente: um rótulo já
     aplicado não é nome de canal, então não casa de novo. Se a plataforma
     repintar o texto cru por cima, o rótulo volta no próximo ciclo. */
  function rotularTextos(raiz) {
    if (!raiz || !buscou || !deveMexer()) return;
    var walker = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT, null, false);
    var nos = [];
    var no;
    while ((no = walker.nextNode())) nos.push(no);
    nos.forEach(function (n) {
      var el = n.parentElement;
      if (!el) return;
      var texto = n.textContent.trim();
      var nome = canalDoTexto(texto);
      if (!nome) return;
      el.dataset.homioProvider = nome;
      var rotulo = rotuloDe(nome);
      if (rotulo) n.textContent = n.textContent.replace(texto, rotulo);
    });
  }

  /* Chip do canal escolhido e cabeçalhos do compositor: mesma rotulagem. */
  function rotularChip() {
    if (!buscou || !deveMexer()) return;
    var chip = document.querySelector(SELETOR_CHIP);
    if (chip) rotularTextos(chip);
    var cabecalhos = document.querySelectorAll(SELETOR_CABECALHO);
    for (var i = 0; i < cabecalhos.length; i++) rotularTextos(cabecalhos[i]);
  }

  function esconderSms(popover) {
    if (!popover || !deveMexer()) return;

    Array.prototype.slice.call(popover.querySelectorAll('div')).forEach(function (div) {
      if (div.textContent.trim() === 'sms') {
        var item = itemDoProvedor(div);
        if (item) item.style.display = 'none';
      }
    });
  }

  /* Garante que canais essenciais nunca somem, mesmo que outra rotina os
     tenha escondido por engano. */
  function garantirVisiveis(popover) {
    if (!popover) return;
    var rotuloSms = rotuloDe('WhatsApp Homio');

    Array.prototype.slice.call(popover.querySelectorAll('div')).forEach(function (div) {
      var original = div.dataset.originalText;
      var texto = div.textContent.trim();
      var visivel =
        texto === 'SMS' || original === 'SMS' ||
        texto === 'WhatsApp Homio' ||
        div.dataset.homioProvider === 'WhatsApp Homio' ||
        (rotuloSms && texto === rotuloSms) ||
        (texto === 'WhatsApp' && texto.indexOf('Homio') === -1) ||
        texto === 'Comentário Interno';

      if (!visivel) {
        var walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, null, false);
        var no;
        while ((no = walker.nextNode())) {
          var t = no.textContent.trim();
          if (t === 'E-mail' || t.toLowerCase() === 'email') { visivel = true; break; }
        }
      }

      if (visivel) {
        var item = itemDoProvedor(div);
        if (item) item.style.display = '';
      }
    });
  }

  /* Sem lista carregada, não escondemos nada: é melhor mostrar uma instância
     desconectada do que esconder todas por causa de uma falha de rede. */
  function filtrarWa(popover) {
    if (!popover || !buscou) return;

    /* elementos já rotulados: decide pelo nome original */
    Array.prototype.slice.call(popover.querySelectorAll('[data-homio-provider]')).forEach(function (el) {
      var nome = el.dataset.homioProvider;
      if (!EH_WA.test(nome)) return;
      var item = itemDoProvedor(el);
      if (item) item.style.display = conectadas.indexOf(nome) !== -1 ? '' : 'none';
    });

    /* texto cru ainda não rotulado (subconta smsReal, ou instância sem número) */
    Array.prototype.slice.call(popover.querySelectorAll('div')).forEach(function (div) {
      var texto = div.textContent.trim();
      if (!EH_WA.test(texto)) return;
      var item = itemDoProvedor(div);
      if (item) item.style.display = conectadas.indexOf(texto) !== -1 ? '' : 'none';
    });
  }

  function aplicarTudo(popover) {
    renomear(popover);
    rotularTextos(popover);
    filtrarWa(popover);
    garantirVisiveis(popover);
    esconderSms(popover);
  }

  /* Observer curto, restrito ao popover aberto. Não é o observer global do
     núcleo porque aqui precisamos de characterData, que é caro demais para
     valer no documento inteiro. */
  function observarConteudo(popover) {
    if (observadorConteudo) observadorConteudo.disconnect();
    observadorConteudo = new MutationObserver(function () {
      if (popover && popover.isConnected) aplicarTudo(popover);
    });
    observadorConteudo.observe(popover, { childList: true, subtree: true, characterData: true });
  }

  function tratarPopover(popover) {
    if (!popover) return;
    renomear(popover);
    garantirInstancias().then(function () {
      if (!popover.isConnected) return;
      aplicarTudo(popover);
      observarConteudo(popover);
    });
  }

  function procurarPopover() {
    var popover = document.querySelector(SELETOR_POPOVER);
    if (popover) tratarPopover(popover);
  }

  function temCompositor() {
    return window.Homio.naRota('/conversations/conversations/') ||
      window.Homio.naRota('/contacts/detail/');
  }

  function ciclo() {
    if (temCompositor() && deveMexer()) garantirInstancias().then(rotularChip);
    procurarPopover();
  }

  window.Homio.aoMudarDom(ciclo);
  window.Homio.aoNavegar(ciclo);
})();


/* ═══════════════════════════════════════════════════════════════════════════
   4. TRADUÇÃO DA TELA DE CONVERSAS
   ═══════════════════════════════════════════════════════════════════════════
   Troca rótulos que a plataforma deixa em inglês na caixa de entrada.

   POR QUE ELE EXISTE, e não remova sem testar. A tradução da plataforma para
   português é incompleta: mesmo com o idioma configurado, estes rótulos
   continuam em inglês, e isso era ponto de dificuldade para os clientes.
   Este bloco cobre a lacuna. Conferido em agosto de 2026.

   Se um dia a plataforma completar a tradução, ele vira redundante. Para
   descobrir: comente o bloco, recarregue a tela de conversas em janela
   anônima e veja se os rótulos continuam em português. Se continuarem, pode
   sair, e some junto o segundo trecho mais caro do arquivo.

   Para acrescentar um rótulo novo, basta uma linha em TRADUCOES. A chave é o
   texto exato em inglês, incluindo maiúsculas.

   MUDANÇA NESTA VERSÃO: era o bloco mais caro do arquivo. Rodava a cada
   mutação do DOM, sem espera, varrendo TODOS os elementos span do documento,
   e a tela de conversas tem centenas. Agora usa o observer com espera do
   núcleo e sai cedo quando não está na tela certa.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var ROTA = '/conversations/conversations/';

  var TRADUCOES = {
    'New': 'Novo',
    'Team Inbox': 'Caixa da Equipe',
    'Unread': 'Não Lidos',
    'Recents': 'Recentes',
    'Starred': 'Favoritos',
    'All': 'Todos',
    'My Inbox': 'Minha Caixa',
    'Assigned to me': 'Atribuído a mim',
    'Internal Chat': 'Chat Interno',
    'Internal Comment': 'Comentário Interno',
    'Type a message': 'Digite uma mensagem',
    'Send': 'Enviar',
    'Clear': 'Limpar'
  };

  function traduzir() {
    if (!window.Homio.naRota(ROTA)) return;
    if (window.Homio.naConta('smsReal')) return;

    var spans = document.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      var texto = spans[i].textContent.trim();
      if (TRADUCOES[texto]) spans[i].textContent = TRADUCOES[texto];
    }

    var comPlaceholder = document.querySelectorAll('[placeholder]');
    for (var j = 0; j < comPlaceholder.length; j++) {
      var ph = (comPlaceholder[j].getAttribute('placeholder') || '').trim();
      if (TRADUCOES[ph]) comPlaceholder[j].setAttribute('placeholder', TRADUCOES[ph]);
    }
  }

  window.Homio.aoMudarDom(traduzir);
  window.Homio.aoNavegar(traduzir);
})();


/* ═══════════════════════════════════════════════════════════════════════════
   5. CORES DOS ESTÁGIOS DO FUNIL
   ═══════════════════════════════════════════════════════════════════════════
   Pinta a borda superior dos cartões de estágio, por palavra-chave do nome.
   Vale só na subconta contas.funilColorido.

   CÓDIGO DE UM CLIENTE SÓ, morando no JS global da agência. Se um dia essa
   conta sair, este bloco pode ser removido inteiro.

   MUDANÇA NESTA VERSÃO: a regra do verde testava se o nome continha "pi",
   duas letras soltas, e vinha ANTES da regra do azul. Qualquer estágio com
   "pipeline" no nome ficaria verde sem explicação. Agora "pi" é procurado
   como palavra inteira, então "Aguardando PI" casa e "Pipeline" não.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var ROTA = '/opportunities/list';
  var LARGURA_BORDA = '5px';

  var CORES = {
    roxo: '#C4B5FD',
    laranja: '#FFA500',
    verde: '#16a34a',
    azul: '#2563eb'
  };

  function naTela() {
    return window.Homio.naConta('funilColorido') && window.Homio.naRota(ROTA);
  }

  function corDoEstagio(nome) {
    if (nome.indexOf('novo lead') !== -1) return CORES.roxo;
    if (nome.indexOf('negocia') !== -1 || nome.indexOf('aberto') !== -1) return CORES.laranja;
    // \bpi\b: "aguardando pi" casa, "pipeline" não
    if (nome.indexOf('aguardando') !== -1 || /\bpi\b/.test(nome)) return CORES.verde;
    if (nome.indexOf('aprovado') !== -1 || nome.indexOf('conclu') !== -1) return CORES.azul;
    return null;
  }

  function pintar() {
    if (!naTela()) return;

    var cartoes = document.querySelectorAll('div[class*="opportunitiesCard"]');
    for (var i = 0; i < cartoes.length; i++) {
      var cartao = cartoes[i];
      var rotulo = cartao.querySelector('[id^="data-stage-name"]');
      var nome = ((rotulo && rotulo.textContent) || '').trim().toLowerCase();
      if (!nome) continue;

      var cor = corDoEstagio(nome);
      if (!cor) continue;

      cartao.style.setProperty('border-top-color', cor, 'important');
      cartao.style.setProperty('border-top-style', 'solid', 'important');
      cartao.style.setProperty('border-top-width', LARGURA_BORDA, 'important');
    }
  }

  window.Homio.aoMudarDom(pintar);
  window.Homio.aoNavegar(pintar);
})();

/* ═══════════════════════════════════════════════════════════════════════════
   6. GRAVAR E ENVIAR ÁUDIO
   ═══════════════════════════════════════════════════════════════════════════
   Acrescenta um botão de microfone na barra do compositor de mensagens.
   Abre um modal que grava pelo navegador e envia para uma função no Supabase.

   Só aparece quando o canal escolhido é um dos de PROVEDORES_OK. Repare que
   essa lista depende do bloco 3: é ele quem transforma "SMS" em
   "WhatsApp Homio". Os dois blocos combinam por texto, então mexer no nome
   em um exige mexer no outro.

   A subconta contas.semAudio não recebe o botão.

   MUDANÇA (2026-10-21): o canal passou a ser identificado pelo nome original
   guardado em data-homio-provider pelo bloco 3 (o texto do chip agora é o
   número conectado), e "WA Homio 4" (5º slot) ganhou o botão. Qualquer
   "WA Homio n" é aceito por padrão, não por lista.

   MUDANÇA NESTA VERSÃO (2026-09-03): o envio passou a ler o corpo da resposta
   da ghl-send-audio (v2). Quando o áudio NÃO sai, a função responde 422 com
   {ok:false, message} e o modal mostra o motivo. Antes só se olhava r.ok, e o
   200 com success:false da v1 virava "Áudio enviado!" sem nada ter saído.

   Versão anterior: era o bloco mais pesado do arquivo. Tinha observer
   próprio em document.body sem espera, intervalo de 1500ms e ainda
   interceptava pushState e replaceState por conta própria. Tudo isso agora
   vem do núcleo, e a função de manutenção roda com espera.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var PROVEDORES_OK = ['SMS', 'WhatsApp Homio'];
  var EH_WA = /^WA Homio( \d+)?$/;

  function provedorAceito(nome) {
    return PROVEDORES_OK.indexOf(nome) !== -1 || EH_WA.test(nome);
  }
  var ID_BOTAO = 'homio-audio-button';
  var MARCA_RENOMEADO = 'homioRenamed';
  var ENDPOINT = 'https://mlntilbkenjjejksevdx.supabase.co/functions/v1/ghl-send-audio';
  var ROXO = 'linear-gradient(135deg, #af4afd 0%, #560099 100%)';

  function bloqueada() {
    return window.Homio.naConta('semAudio');
  }

  function gatilhoDoProvedor() {
    return document.querySelector('#conv-channel-bar-provider-trigger span.text-primary-600');
  }

  /* Nome ORIGINAL do canal. O bloco 3 troca o texto do chip pelo número
     conectado e guarda o nome em data-homio-provider; é esse nome que vai
     para a ghl-send-audio e que decide se o botão aparece. Sem a marca
     (lista ainda não buscada), vale o texto. */
  function provedorAtual() {
    var span = gatilhoDoProvedor();
    if (!span) return null;
    return span.dataset.homioProvider || span.textContent.trim();
  }

  /* Renomeia os rótulos do compositor. É o mesmo trabalho do bloco 3, porém
     em outros elementos: aqui é a barra do compositor, lá é a lista suspensa. */
  function renomearRotulos() {
    if (bloqueada()) return;

    var gatilho = gatilhoDoProvedor();
    if (gatilho && !gatilho.dataset[MARCA_RENOMEADO] && gatilho.textContent.trim() === 'SMS') {
      gatilho.textContent = 'WhatsApp Homio';
      gatilho.dataset[MARCA_RENOMEADO] = '1';
      gatilho.dataset.homioOriginal = 'SMS';
    }

    var cabecalhos = document.querySelectorAll('span.text-sm.font-medium.text-gray-700');
    for (var i = 0; i < cabecalhos.length; i++) {
      var span = cabecalhos[i];
      if (span.dataset[MARCA_RENOMEADO]) continue;
      if (span.textContent.trim() === 'SMS') {
        span.textContent = 'WhatsApp Homio';
        span.dataset[MARCA_RENOMEADO] = '1';
        span.dataset.homioOriginal = 'SMS';
      }
    }
  }

  /* O valor do input vem em formato nacional, ex.: "(27) 99500-8068", sem o
     +55. A ghl-send-audio (v2) usa esse número SÓ para localizar o contato; o
     número de envio vem do cadastro do GHL, em E.164. */
  function telefoneDoContato() {
    var candidatos = [
      'input[type="tel"].hr-input__input-el',
      'input[type="tel"][name*="phone" i]',
      'input[type="tel"]'
    ];
    for (var i = 0; i < candidatos.length; i++) {
      var el = document.querySelector(candidatos[i]);
      if (el && el.value && el.value.trim()) return el.value.trim();
    }
    return '';
  }

  function garantirAnimacoes() {
    if (document.getElementById('homio-audio-modal-styles')) return;
    var style = document.createElement('style');
    style.id = 'homio-audio-modal-styles';
    style.textContent =
      '@keyframes fadeIn{from{opacity:0}to{opacity:1}}' +
      '@keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}' +
      '@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}' +
      '@keyframes recordingPulse{0%,100%{background:linear-gradient(135deg,#ef4444 0%,#dc2626 100%);box-shadow:0 0 0 0 rgba(239,68,68,.7)}50%{background:linear-gradient(135deg,#dc2626 0%,#b91c1c 100%);box-shadow:0 0 0 15px rgba(239,68,68,0)}}';
    document.head.appendChild(style);
  }

  var SVG_MIC = '<svg width="48" height="48" viewBox="0 0 24 24" fill="white"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>';
  var SVG_CHECK = '<svg width="48" height="48" viewBox="0 0 24 24" fill="white"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
  var SVG_PARAR = '<svg width="48" height="48" viewBox="0 0 24 24" fill="white"><circle cx="12" cy="12" r="8"/></svg>';

  var ESTILO_BOTAO = {
    deletar: {
      ligado: 'background:transparent;color:#ef4444;border:2px solid #ef4444;padding:14px 16px;border-radius:8px;font-size:15px;font-weight:500;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:6px;flex:1;min-height:48px;cursor:pointer;',
      desligado: 'background:transparent;color:#6b7280;border:2px solid #e5e7eb;padding:14px 16px;border-radius:8px;font-size:15px;font-weight:500;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:6px;flex:1;min-height:48px;cursor:not-allowed;'
    },
    enviar: {
      ligado: 'background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);color:#fff;border:none;padding:14px 16px;border-radius:8px;font-size:15px;font-weight:600;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:6px;flex:1;box-shadow:0 2px 8px rgba(59,130,246,.3);min-height:48px;cursor:pointer;',
      desligado: 'background:#f3f4f6;color:#6b7280;border:none;padding:14px 16px;border-radius:8px;font-size:15px;font-weight:600;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:6px;flex:1;min-height:48px;cursor:not-allowed;'
    }
  };

  var BOTAO_REDONDO_VERDE = 'width:120px;height:120px;border-radius:50%;background:linear-gradient(135deg,#10b981 0%,#059669 100%);margin:0 auto 16px;display:flex;align-items:center;justify-content:center;transition:all .3s ease;border:none;cursor:pointer;box-shadow:0 4px 16px rgba(16,185,129,.3);';

  function abrirModal() {
    garantirAnimacoes();

    var fundo = document.createElement('div');
    fundo.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;justify-content:center;align-items:center;z-index:10000;animation:fadeIn .3s ease-out;padding:16px;';

    var modal = document.createElement('div');
    modal.style.cssText = 'background:#fff;border-radius:16px;box-shadow:0 20px 40px rgba(0,0,0,.15);max-width:420px;width:100%;max-height:90vh;overflow-y:auto;padding:0;text-align:center;animation:slideUp .3s ease-out;position:relative;';

    var cabecalho = document.createElement('div');
    cabecalho.style.cssText = 'background:' + ROXO + ';color:#fff;padding:20px;margin:0;position:relative;';

    var titulo = document.createElement('h2');
    titulo.style.cssText = 'margin:0;font-size:18px;font-weight:600;letter-spacing:-.5px;display:flex;color:#fff;align-items:center;justify-content:center;gap:8px;';
    titulo.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg> Gravar áudio';

    var fechar = document.createElement('button');
    fechar.style.cssText = 'position:absolute;top:50%;right:16px;transform:translateY(-50%);background:rgba(255,255,255,.2);border:none;border-radius:50%;width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;color:#fff;min-height:44px;min-width:44px;';
    fechar.setAttribute('aria-label', 'Fechar');
    fechar.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

    cabecalho.appendChild(titulo);
    cabecalho.appendChild(fechar);

    var corpo = document.createElement('div');
    corpo.style.cssText = 'padding:24px 20px 20px;';

    var status = document.createElement('div');
    status.style.cssText = 'margin:0 0 20px 0;font-size:15px;color:#6b7280;min-height:22px;font-weight:500;line-height:1.4;display:flex;align-items:center;justify-content:center;gap:8px;';
    status.textContent = 'Clique no botão abaixo para começar';

    var botaoGravar = document.createElement('button');
    botaoGravar.style.cssText = BOTAO_REDONDO_VERDE;

    var iconeMic = document.createElement('div');
    iconeMic.innerHTML = SVG_MIC;
    botaoGravar.appendChild(iconeMic);

    var rotulo = document.createElement('div');
    rotulo.style.cssText = 'font-size:15px;color:#6b7280;font-weight:500;margin-bottom:20px;line-height:1.3;';
    rotulo.textContent = 'Clique para gravar';

    var player = document.createElement('audio');
    player.controls = true;
    player.style.cssText = 'display:none;width:100%;margin:16px 0;border-radius:8px;height:40px;';

    var acoes = document.createElement('div');
    acoes.style.cssText = 'display:flex;gap:12px;margin-top:20px;justify-content:center;align-items:center;';

    var botaoDeletar = document.createElement('button');
    botaoDeletar.disabled = true;
    botaoDeletar.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg> Deletar';
    botaoDeletar.style.cssText = ESTILO_BOTAO.deletar.desligado;

    var botaoEnviar = document.createElement('button');
    botaoEnviar.disabled = true;
    botaoEnviar.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg> Enviar';
    botaoEnviar.style.cssText = ESTILO_BOTAO.enviar.desligado;

    function estado(botao, ligado, estilos) {
      botao.disabled = !ligado;
      botao.style.cssText = ligado ? estilos.ligado : estilos.desligado;
    }

    corpo.appendChild(status);
    corpo.appendChild(botaoGravar);
    corpo.appendChild(rotulo);
    corpo.appendChild(player);
    corpo.appendChild(acoes);
    acoes.appendChild(botaoDeletar);
    acoes.appendChild(botaoEnviar);
    modal.appendChild(cabecalho);
    modal.appendChild(corpo);
    fundo.appendChild(modal);
    document.body.appendChild(fundo);

    var gravador = null;
    var pedacos = [];
    var gravando = false;
    var audio = null;
    var fluxo = null;

    function pararFluxo() {
      if (!fluxo) return;
      try { fluxo.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* já parado */ }
      fluxo = null;
    }

    function comecar() {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        fluxo = s;
        gravador = new MediaRecorder(s);
        pedacos = [];

        gravador.ondataavailable = function (e) { if (e.data.size > 0) pedacos.push(e.data); };

        gravador.onstop = function () {
          audio = new Blob(pedacos, { type: 'audio/webm; codecs=opus' });
          player.src = URL.createObjectURL(audio);
          player.style.display = 'block';

          status.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Gravação finalizada! Ouça o áudio abaixo';
          status.style.color = '#059669';

          estado(botaoEnviar, true, ESTILO_BOTAO.enviar);
          estado(botaoDeletar, true, ESTILO_BOTAO.deletar);

          botaoGravar.style.cssText = BOTAO_REDONDO_VERDE + 'animation:pulse 2s infinite;';
          iconeMic.innerHTML = SVG_CHECK;
          rotulo.textContent = 'Gravação concluída';
          rotulo.style.color = '#059669';

          pararFluxo();
        };

        gravador.start();
        gravando = true;

        botaoGravar.style.cssText = 'width:120px;height:120px;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;transition:all .3s ease;border:none;cursor:pointer;animation:recordingPulse 1.5s infinite;';
        iconeMic.innerHTML = SVG_PARAR;
        status.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg> Gravando... Clique para parar';
        status.style.color = '#ef4444';
        rotulo.textContent = 'Clique para parar';
        rotulo.style.color = '#ef4444';
        estado(botaoEnviar, false, ESTILO_BOTAO.enviar);
        estado(botaoDeletar, false, ESTILO_BOTAO.deletar);
      }).catch(function (err) {
        console.error('[Homio áudio] microfone indisponível:', err);
        status.textContent = 'Erro ao acessar o microfone';
        status.style.color = '#ef4444';
      });
    }

    function parar() {
      if (!gravador || !gravando) return;
      gravador.stop();
      gravando = false;
      status.textContent = 'Processando áudio...';
      status.style.color = '#6b7280';
      rotulo.textContent = 'Processando...';
      rotulo.style.color = '#6b7280';
    }

    botaoGravar.addEventListener('click', function () { gravando ? parar() : comecar(); });

    botaoDeletar.addEventListener('click', function () {
      pedacos = [];
      audio = null;
      player.src = '';
      player.style.display = 'none';
      status.textContent = 'Gravação deletada';
      status.style.color = '#ef4444';
      estado(botaoEnviar, false, ESTILO_BOTAO.enviar);
      estado(botaoDeletar, false, ESTILO_BOTAO.deletar);
      botaoGravar.style.cssText = BOTAO_REDONDO_VERDE;
      iconeMic.innerHTML = SVG_MIC;
      rotulo.textContent = 'Clique para gravar';
      rotulo.style.color = '#6b7280';
      setTimeout(function () {
        status.textContent = 'Clique no botão abaixo para começar';
        status.style.color = '#6b7280';
      }, 2000);
    });

    botaoEnviar.addEventListener('click', function () {
      if (!audio) return;
      botaoEnviar.disabled = true;
      status.textContent = 'Enviando áudio...';
      status.style.color = '#6b7280';

      var dados = new FormData();
      dados.append('audioFile', audio, 'gravacao.webm');
      dados.append('pageUrl', window.location.href);

      renomearRotulos();
      dados.append('conversationProvider', provedorAtual() || 'WhatsApp Homio');

      var emContatoOuConversa =
        window.Homio.naRota('contacts/detail/') || window.Homio.naRota('conversations/conversations/');
      if (emContatoOuConversa) {
        var tel = telefoneDoContato();
        if (tel) dados.append('phoneNumber', tel);
      }

      fetch(ENDPOINT, { method: 'POST', body: dados }).then(function (r) {
        /* A ghl-send-audio v2 (2026-09-03) responde 422 + {ok:false, message} quando o
           áudio NÃO saiu. Ler o corpo: sem isso, o modal dizia "Áudio enviado!" para
           envio que nunca chegou (a v1 devolvia 200 com success:false). */
        return r.json().catch(function () { return null; }).then(function (corpo) {
          if (!r.ok || !corpo || corpo.ok === false || corpo.success === false) {
            var msg = (corpo && corpo.message) ? corpo.message
              : 'Falha ao enviar (status ' + r.status + '). Tente novamente.';
            throw new Error(msg);
          }
          status.textContent = 'Áudio enviado!';
          status.style.color = '#059669';
          setTimeout(function () { try { document.body.removeChild(fundo); } catch (e) { /* já fechado */ } }, 1500);
        });
      }).catch(function (err) {
        console.error('[Homio áudio] falha no envio:', err);
        status.textContent = 'Erro ao enviar áudio: ' + err.message;
        status.style.color = '#ef4444';
        status.style.whiteSpace = 'normal';
        botaoEnviar.disabled = false;
      });
    });

    function fecharModal() {
      if (gravando && gravador) { try { gravador.stop(); } catch (e) { /* já parado */ } }
      pararFluxo();
      fundo.style.animation = 'fadeIn .3s ease-out reverse';
      setTimeout(function () { try { document.body.removeChild(fundo); } catch (e) { /* já fechado */ } }, 300);
    }

    fechar.addEventListener('click', fecharModal);
    fundo.addEventListener('click', function (e) { if (e.target === fundo) fecharModal(); });
    modal.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  function criarBotao(barra) {
    if (barra.querySelector('#' + ID_BOTAO)) return;
    var btn = document.createElement('button');
    btn.id = ID_BOTAO;
    btn.type = 'button';
    btn.title = 'Gravar áudio (WhatsApp Homio)';
    btn.style.cssText = 'background:' + ROXO + ';color:#fff;border:none;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(86,0,153,.25);cursor:pointer;transition:all .2s;flex-shrink:0;margin-left:4px;padding:0;';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>';
    btn.addEventListener('mouseenter', function () { btn.style.background = 'linear-gradient(135deg,#560099 0%,#af4afd 100%)'; });
    btn.addEventListener('mouseleave', function () { btn.style.background = ROXO; });
    btn.addEventListener('click', abrirModal);
    barra.appendChild(btn);
  }

  /* Reconciliador: olha o estado da tela e decide se o botão deve existir.
     Barato de propósito, porque roda a cada ciclo do observer do núcleo. */
  /* O compositor só existe nestas duas telas. Sem esta guarda, manter()
     fazia três consultas ao DOM em toda página do painel, a cada ciclo do
     observer, para no fim não encontrar nada. */
  function temCompositor() {
    return window.Homio.naRota('/conversations/conversations/') ||
      window.Homio.naRota('/contacts/detail/');
  }

  function manter() {
    if (!temCompositor()) {
      var orfao = document.getElementById(ID_BOTAO);
      if (orfao) orfao.remove();
      return;
    }

    if (bloqueada()) {
      var existentes = document.querySelectorAll('#' + ID_BOTAO);
      for (var i = 0; i < existentes.length; i++) existentes[i].remove();
      return;
    }

    renomearRotulos();

    var barra = document.querySelector('#conv-composer-toolbar');
    var provedor = provedorAtual();
    var atual = document.querySelector('#' + ID_BOTAO);

    var pode = barra && provedor && provedorAceito(provedor);
    if (!pode) {
      if (atual) atual.remove();
      return;
    }
    if (!atual) criarBotao(barra);
  }

  window.Homio.aoMudarDom(manter);
  window.Homio.aoNavegar(manter);
})(); 

  /* ═══════════════════════════════════════════════════════════════════════════
   7. WIDGET DE SUPORTE
   ═══════════════════════════════════════════════════════════════════════════
   Iframe do homio-suporte.vercel.app, só nas subcontas contas.suporteA e
   contas.suporteB. Ele mesmo se redimensiona por mensagens postMessage.

   MUDANÇA NESTA VERSÃO: adicionada alça de arraste externa ao iframe. O
   usuário pode reposicionar o widget horizontalmente ao longo da parte
   inferior da tela. A posição é salva em localStorage e restaurada ao
   carregar. O clique normal no widget continua abrindo/fechando o suporte.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var ID = 'homio-suporte-widget';
  var BASE = 'https://homio-suporte.vercel.app/widget';
  var STORAGE_KEY = 'homio-suporte-pos';
  var DRAG_THRESHOLD = 3;

  if (document.getElementById(ID)) return;

  var conta = window.Homio.locationId();
  var liberadas = [window.Homio.contas.suporteA, window.Homio.contas.suporteB];
  if (!conta || liberadas.indexOf(conta) === -1) return;

  function nomeDaSubconta() {
    var seletores = [
      '.location-switcher-name',
      '[data-test-id="location-name"]',
      '.hl-text-sm.font-medium.truncate'
    ];
    for (var i = 0; i < seletores.length; i++) {
      var el = document.querySelector(seletores[i]);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return '';
  }

  var url = BASE + '?subAccountId=' + encodeURIComponent(conta);
  var nome = nomeDaSubconta();
  if (nome) url += '&subAccountName=' + encodeURIComponent(nome);

  var base = window.Homio.cantos.suporte;

  /* ── Tamanhos ──────────────────────────────────────────────────────────── */
  var CLOSED_W = 80;
  var CLOSED_H = 80;
  var OPEN_W = 420;
  var OPEN_H = 650;
  var HANDLE_H = 14; /* altura da alça + margem */

  var aberto = false;

  /* ── Wrapper ───────────────────────────────────────────────────────────── */
  var wrapper = document.createElement('div');
  wrapper.id = ID;
  wrapper.style.position = 'fixed';
  wrapper.style.bottom = base + 'px';
  wrapper.style.zIndex = '999999';
  wrapper.style.transition = 'width .3s, height .3s';
  wrapper.style.width = CLOSED_W + 'px';

  /* ── Handle (alça de arraste) ──────────────────────────────────────────── */
  var handle = document.createElement('div');
  handle.style.cssText =
    'width:36px;height:6px;margin:0 auto 4px;border-radius:3px;' +
    'background:rgba(0,0,0,0.18);cursor:grab;transition:background .2s;' +
    'touch-action:none;';
  handle.title = 'Arraste para reposicionar';

  handle.addEventListener('mouseenter', function () { handle.style.background = 'rgba(0,0,0,0.35)'; });
  handle.addEventListener('mouseleave', function () { handle.style.background = 'rgba(0,0,0,0.18)'; });

  /* ── Iframe ────────────────────────────────────────────────────────────── */
  var iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.allow = 'microphone';
  iframe.title = 'Suporte Homio';
  iframe.style.width = CLOSED_W + 'px';
  iframe.style.height = CLOSED_H + 'px';
  iframe.style.border = 'none';
  iframe.style.background = 'transparent';
  iframe.style.transition = 'width .3s, height .3s';
  iframe.style.display = 'block';

  wrapper.appendChild(handle);
  wrapper.appendChild(iframe);

  /* ── Posição ───────────────────────────────────────────────────────────── */

  function currentW() { return aberto ? OPEN_W : CLOSED_W; }

  /** Limita left para ficar dentro da viewport. */
  function clampLeft(left, w) {
    var maxLeft = window.innerWidth - w;
    if (left < 0) return 0;
    if (left > maxLeft) return maxLeft;
    return left;
  }

  /** Aplica posição horizontal ao wrapper. Usa left e limpa right. */
  function setLeft(left) {
    var clamped = clampLeft(left, currentW());
    wrapper.style.left = clamped + 'px';
    wrapper.style.right = 'auto';
  }

  /** Posição default: canto inferior direito. */
  function defaultLeft() {
    return window.innerWidth - CLOSED_W;
  }

  function salvar(left) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: left })); } catch (e) { /* quota */ }
  }

  function restaurar() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (typeof data.left === 'number') return data.left;
      }
    } catch (e) { /* corrupto */ }
    return null;
  }

  /** Posição inicial: localStorage ou default (direita). */
  function posicaoInicial() {
    var saved = restaurar();
    if (saved !== null) return clampLeft(saved, CLOSED_W);
    return defaultLeft();
  }

  /* Aplica posição inicial. */
  setLeft(posicaoInicial());

  /* Recalcula ao redimensionar a janela. */
  window.addEventListener('resize', function () {
    setLeft(parseFloat(wrapper.style.left) || defaultLeft());
  });

  /* ── Drag ──────────────────────────────────────────────────────────────── */

  var dragging = false;
  var dragStartX = 0;
  var dragStartLeft = 0;
  var didDrag = false;

  function onDragStart(clientX) {
    dragging = true;
    didDrag = false;
    dragStartX = clientX;
    dragStartLeft = parseFloat(wrapper.style.left) || 0;
    wrapper.style.transition = 'none'; /* desativa transição durante drag */
    handle.style.cursor = 'grabbing';
  }

  function onDragMove(clientX) {
    if (!dragging) return;
    var dx = clientX - dragStartX;
    if (!didDrag && Math.abs(dx) < DRAG_THRESHOLD) return;
    didDrag = true;
    var newLeft = dragStartLeft + dx;
    setLeft(newLeft);
  }

  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    wrapper.style.transition = 'width .3s, height .3s';
    handle.style.cursor = 'grab';
    if (didDrag) {
      var left = parseFloat(wrapper.style.left) || 0;
      salvar(left);
    }
  }

  /* Mouse */
  handle.addEventListener('mousedown', function (e) {
    e.preventDefault();
    onDragStart(e.clientX);
  });
  window.addEventListener('mousemove', function (e) {
    if (dragging) { e.preventDefault(); onDragMove(e.clientX); }
  });
  window.addEventListener('mouseup', onDragEnd);

  /* Touch */
  handle.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    onDragStart(e.touches[0].clientX);
  }, { passive: false });
  window.addEventListener('touchmove', function (e) {
    if (!dragging) return;
    e.preventDefault();
    onDragMove(e.touches[0].clientX);
  }, { passive: false });
  window.addEventListener('touchend', onDragEnd);
  window.addEventListener('touchcancel', onDragEnd);

  /* ── Append ────────────────────────────────────────────────────────────── */

  window.Homio.quandoPronto(function () {
    if (document.getElementById(ID)) return;
    document.body.appendChild(wrapper);
  });

  /* ── postMessage ───────────────────────────────────────────────────────── */

  var ORIGEM = 'https://homio-suporte.vercel.app';

  window.addEventListener('message', function (evento) {
    if (evento.origin !== ORIGEM) return;

    if (evento.data === 'homio-widget-open') {
      aberto = true;
      iframe.style.width = OPEN_W + 'px';
      iframe.style.height = OPEN_H + 'px';
      wrapper.style.width = OPEN_W + 'px';
      /* Ajustar posição para não sair da viewport */
      setLeft(parseFloat(wrapper.style.left) || 0);
    }
    if (evento.data === 'homio-widget-close') {
      aberto = false;
      iframe.style.width = CLOSED_W + 'px';
      iframe.style.height = CLOSED_H + 'px';
      wrapper.style.width = CLOSED_W + 'px';
      /* Recalcular posição com tamanho fechado */
      setLeft(parseFloat(wrapper.style.left) || 0);
    }
    if (evento.data === 'homio-widget-move-left') {
      var leftPos = 0;
      setLeft(leftPos);
      salvar(leftPos);
    }
    if (evento.data === 'homio-widget-move-right') {
      var rightPos = window.innerWidth - currentW();
      setLeft(rightPos);
      salvar(rightPos);
    }
  });
})();

/* ═══════════════════════════════════════════════════════════════════════════
   11. TELEMETRIA DE USO OBSERVADO
   ═══════════════════════════════════════════════════════════════════════════
   Mede somente atividade observada no desktop web: aba visivel, janela em
   foco e interacao recente. Nao mede app movel, API nem automacoes em
   background. Nunca envia URL crua, texto de tela, contato, mensagem ou busca.

   A trava PILOTOS roda ANTES de qualquer fetch. A EF ainda aplica sua propria
   allowlist no banco. Janelas sao agregadas no navegador e enviadas em lote;
   nenhum MutationObserver desta secao faz chamada de rede.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  if (window.Homio.telemetria) return;

  var VERSION = '1.0.0';
  var ENDPOINT = 'https://mlntilbkenjjejksevdx.supabase.co/functions/v1/client-usage-ingest';
  var PILOTOS = {
    /* Internal Testing. Liberar outra conta exige deploy do script E enable no banco. */
    d8voPwkhJK7k7S5xjHcA: true
  };
  var TICK_MS = 15000;
  var MAX_FILA = 50;

  var estado = null;
  var inicializando = null;
  var ultimaInteracao = Date.now();
  var timer = null;
  var statusAtual = 'aguardando_rota';

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }

  function moduloAtual() {
    var p = location.pathname.toLowerCase();
    if (p.indexOf('/conversations') !== -1) return 'conversations';
    if (p.indexOf('/opportunities') !== -1) return 'opportunities';
    if (p.indexOf('/contacts') !== -1) return 'contacts';
    if (p.indexOf('/automation') !== -1 || p.indexOf('/workflow') !== -1) return 'automations';
    if (p.indexOf('/calendar') !== -1 || p.indexOf('/appointment') !== -1) return 'calendars';
    if (p.indexOf('/funnels') !== -1 || p.indexOf('/sites') !== -1 || p.indexOf('/memberships') !== -1) return 'sites';
    if (p.indexOf('/marketing') !== -1 || p.indexOf('/social') !== -1) return 'marketing';
    if (p.indexOf('/payment') !== -1 || p.indexOf('/invoice') !== -1) return 'payments';
    if (p.indexOf('/report') !== -1) return 'reporting';
    if (p.indexOf('/settings') !== -1) return 'settings';
    if (p.indexOf('/custom-page-link') !== -1) return 'apps';
    if (p.indexOf('/dashboard') !== -1) return 'dashboard';
    return 'other';
  }

  function storageKey(locationId, userId) {
    return 'homio_usage_queue_v1:' + locationId + ':' + userId;
  }

  function lerFila(chave) {
    try {
      var valor = sessionStorage.getItem(chave);
      var fila = valor ? JSON.parse(valor) : [];
      return Array.isArray(fila) ? fila.slice(-MAX_FILA) : [];
    } catch (_) {
      return [];
    }
  }

  function salvarFila(alvo) {
    alvo = alvo || estado;
    if (!alvo) return;
    try {
      sessionStorage.setItem(alvo.storageKey, JSON.stringify(alvo.fila.slice(-MAX_FILA)));
    } catch (_) {
      /* Telemetria nao pode afetar o CRM se storage estiver bloqueado. */
    }
  }

  function usuarioAtual(tentativa) {
    tentativa = tentativa || 0;
    var utils = window.AppUtils && window.AppUtils.Utilities;
    if (utils && typeof utils.getCurrentUser === 'function') {
      return Promise.resolve(utils.getCurrentUser()).then(function (u) {
        return u && u.id ? u : null;
      }).catch(function () { return null; });
    }
    if (tentativa >= 20) return Promise.resolve(null);
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(usuarioAtual(tentativa + 1)); }, 500);
    });
  }

  function configuracao(locationId) {
    return fetch(ENDPOINT + '?locationId=' + encodeURIComponent(locationId), {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) return null;
      return r.json();
    }).catch(function () { return null; });
  }

  function estaAtivo(agora) {
    return !document.hidden && document.hasFocus() &&
      agora - ultimaInteracao <= estado.idleSeconds * 1000;
  }

  function tick() {
    if (!estado || !estado.janela) return;
    var agora = Date.now();
    var delta = Math.max(0, Math.min(TICK_MS, agora - estado.ultimoTick));
    if (estaAtivo(agora)) estado.janela.activeSeconds += Math.floor(delta / 1000);
    estado.ultimoTick = agora;
  }

  function iniciarJanela(pageView) {
    if (!estado || document.hidden) return;
    var agora = Date.now();
    estado.janela = {
      eventId: uuid(),
      sessionId: estado.sessionId,
      module: moduloAtual(),
      startedAtMs: agora,
      activeSeconds: 0,
      pageViews: pageView ? 1 : 0
    };
    estado.ultimoTick = agora;
    estado.ultimoPath = location.pathname;
  }

  function fecharJanela() {
    if (!estado || !estado.janela) return;
    tick();
    var fim = Date.now();
    var j = estado.janela;
    estado.janela = null;
    if (!j.activeSeconds && !j.pageViews) return;
    estado.fila.push({
      eventId: j.eventId,
      sessionId: j.sessionId,
      module: j.module,
      startedAt: new Date(j.startedAtMs).toISOString(),
      endedAt: new Date(fim).toISOString(),
      activeSeconds: Math.min(j.activeSeconds, Math.ceil((fim - j.startedAtMs) / 1000)),
      pageViews: j.pageViews
    });
    if (estado.fila.length > MAX_FILA) estado.fila = estado.fila.slice(-MAX_FILA);
    salvarFila();
  }

  function payload(eventos, alvo) {
    return {
      version: VERSION,
      locationId: alvo.locationId,
      user: {
        id: String(alvo.user.id),
        name: String(alvo.user.name || [alvo.user.firstName, alvo.user.lastName].filter(Boolean).join(' ') || ''),
        role: String(alvo.user.role || ''),
        type: String(alvo.user.type || '')
      },
      events: eventos
    };
  }

  function removerEnviados(ids, alvo) {
    if (!alvo) return;
    var mapa = {};
    for (var i = 0; i < ids.length; i++) mapa[ids[i]] = true;
    alvo.fila = alvo.fila.filter(function (e) { return !mapa[e.eventId]; });
    salvarFila(alvo);
  }

  function enviar(beacon) {
    if (!estado || estado.enviando || !estado.fila.length) return;
    /* Captura o estado: a resposta pode chegar depois de trocar de subconta. */
    var alvo = estado;
    var eventos = alvo.fila.slice(0, alvo.maxBatchEvents);
    var corpo = JSON.stringify(payload(eventos, alvo));

    if (beacon && navigator.sendBeacon) {
      try {
        /* text/plain evita preflight no fechamento. IDs idempotentes toleram reenvio. */
        navigator.sendBeacon(ENDPOINT, new Blob([corpo], { type: 'text/plain;charset=UTF-8' }));
        return;
      } catch (_) {
        return;
      }
    }

    alvo.enviando = true;
    fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'omit',
      keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: corpo
    }).then(function (r) {
      if (r.ok) removerEnviados(eventos.map(function (e) { return e.eventId; }), alvo);
    }).catch(function () {
      /* Mantem a fila para a proxima janela/sessao. */
    }).finally(function () {
      alvo.enviando = false;
    });
  }

  function fecharEEnviar(beacon, reabrir) {
    fecharJanela();
    enviar(beacon);
    if (reabrir && estado && !document.hidden) iniciarJanela(false);
  }

  function tratarNavegacao() {
    var locationId = window.Homio.locationId();

    /* Trava antes de rede: fora do piloto, zero request e zero timer. */
    if (!locationId || !PILOTOS[locationId]) {
      if (estado) fecharEEnviar(true, false);
      estado = null;
      statusAtual = locationId ? 'fora_do_piloto' : 'fora_de_subconta';
      inicializando = null;
      return;
    }

    if (estado && estado.locationId === locationId) {
      if (estado.ultimoPath === location.pathname) return;
      var novoModulo = moduloAtual();
      if (estado.janela && estado.janela.module === novoModulo) {
        estado.janela.pageViews += 1;
        estado.ultimoPath = location.pathname;
      } else {
        fecharEEnviar(false, false);
        iniciarJanela(true);
      }
      return;
    }

    if (inicializando === locationId) return;
    if (estado) fecharEEnviar(true, false);
    estado = null;
    inicializando = locationId;
    statusAtual = 'carregando_config';

    Promise.all([configuracao(locationId), usuarioAtual()]).then(function (res) {
      if (window.Homio.locationId() !== locationId) return;
      inicializando = null;
      var cfg = res[0];
      var user = res[1];
      if (!cfg || !cfg.enabled) { statusAtual = 'desabilitada_no_servidor'; return; }
      if (!user || !user.id) { statusAtual = 'sem_usuario'; return; }

      var chave = storageKey(locationId, String(user.id));
      estado = {
        locationId: locationId,
        user: user,
        sessionId: uuid(),
        idleSeconds: Number(cfg.idleSeconds) || 120,
        batchSeconds: Number(cfg.batchSeconds) || 300,
        maxBatchEvents: Number(cfg.maxBatchEvents) || 25,
        storageKey: chave,
        fila: lerFila(chave),
        janela: null,
        ultimoTick: Date.now(),
        ultimoPath: location.pathname,
        enviando: false
      };
      statusAtual = 'ativa';
      ultimaInteracao = Date.now();
      iniciarJanela(true);
      enviar(false); /* retry idempotente do que restou da sessao anterior */

      if (!timer) {
        timer = setInterval(function () {
          if (!estado) return;
          tick();
          if (estado.janela && Date.now() - estado.janela.startedAtMs >= estado.batchSeconds * 1000) {
            fecharEEnviar(false, true);
          }
        }, TICK_MS);
      }
    }).catch(function () {
      inicializando = null;
      statusAtual = 'erro_inicializacao';
    });
  }

  function marcarInteracao() { ultimaInteracao = Date.now(); }
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(function (nome) {
    window.addEventListener(nome, marcarInteracao, { passive: true, capture: true });
  });

  document.addEventListener('visibilitychange', function () {
    if (!estado) return;
    if (document.hidden) fecharEEnviar(true, false);
    else {
      ultimaInteracao = Date.now();
      iniciarJanela(false);
    }
  });
  window.addEventListener('focus', function () {
    ultimaInteracao = Date.now();
    if (estado) estado.ultimoTick = Date.now();
  });
  window.addEventListener('blur', tick);
  window.addEventListener('pagehide', function () { fecharEEnviar(true, false); });

  window.Homio.telemetria = {
    version: VERSION,
    flush: function () { fecharEEnviar(false, true); },
    status: function () {
      return {
        status: statusAtual,
        locationId: estado ? estado.locationId : window.Homio.locationId(),
        queued: estado ? estado.fila.length : 0,
        module: estado && estado.janela ? estado.janela.module : null
      };
    }
  };

  window.Homio.aoNavegar(tratarNavegacao);
})();

/* ═══════════════════════════════════════════════════════════════════════════
   8. FAVICON
   ═══════════════════════════════════════════════════════════════════════════
   O símbolo da Homio, trocando de versão conforme o tema do navegador.

   PRIMEIRO, UMA CORREÇÃO DE PREMISSA: a reorganização do JavaScript não mexeu
   no favicon. Verifiquei três coisas na conta:

     nenhum dos 9 scripts embutidos da página menciona favicon ou link de ícone;
     o script externo do Supabase, o único código que eu ainda não tinha lido,
       também não menciona, conferido baixando os 19 kB dele;
     o favicon que estava valendo vinha de companyPhotos, o armazenamento de
       imagens da própria plataforma, e não de código nosso.

   Ele é definido nas configurações de marca branca do GoHighLevel. Se existir
   um campo de favicon por lá, o certo é usá-lo e apagar este bloco: ícone
   definido pela plataforma aparece antes e sobrevive a mudanças de estrutura.

   POR QUE DUAS IMAGENS. O repositório tem duas versões do símbolo, e medi as
   duas amostrando os pixels:

     simbolo-grafite   luminância 25    escuro, some em aba escura
     simbolo-off       luminância 246   claro, some em aba clara

   Nenhuma funciona sozinha. O site aponta hoje para a grafite, e é por isso
   que o ícone dele também desaparece para quem usa o navegador no tema
   escuro. Aqui a escolha é feita por tema, e refeita se o tema mudar com a
   aba aberta.

   Existe o atributo media em link de ícone, que faria isso sem JavaScript,
   mas o suporte é irregular entre navegadores. matchMedia é confiável em
   todos.

   COMPORTAMENTO VERIFICADO: a plataforma NÃO reescreve o favicon durante a
   navegação. Troquei o endereço na mão, naveguei para outra tela e ele
   permaneceu. A reaplicação ao navegar existe só como garantia barata.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var BASE = 'https://raw.githubusercontent.com/Homio-CRM/homio-doc/master/public/';

  /* Endereço direto do conteúdo, e não o da página do repositório com
     ?raw=true que o site usa: mesma imagem, sem um redirecionamento por
     carregamento. */
  var CLARO = BASE + 'simbolo-off.png';       /* para navegador em tema escuro */
  var ESCURO = BASE + 'simbolo-grafite.png';  /* para navegador em tema claro  */

  var MARCA = 'homioFavicon';
  var consulta = window.matchMedia('(prefers-color-scheme: dark)');

  function iconeAtual() {
    return consulta.matches ? CLARO : ESCURO;
  }

  function aplicar() {
    var desejado = iconeAtual();

    var existentes = document.querySelectorAll(
      'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
    );

    var jaCerto = false;
    for (var i = 0; i < existentes.length; i++) {
      var l = existentes[i];
      if (l.dataset[MARCA] && l.getAttribute('href') === desejado) { jaCerto = true; continue; }
      /* Substituir em vez de acrescentar: com dois links de ícone o navegador
         escolhe um deles, e nem sempre o que você quer. */
      l.remove();
    }
    if (jaCerto) return;

    [['icon', 'image/png'], ['apple-touch-icon', null]].forEach(function (par) {
      var link = document.createElement('link');
      link.rel = par[0];
      if (par[1]) link.type = par[1];
      link.href = desejado;
      link.dataset[MARCA] = '1';
      document.head.appendChild(link);
    });
  }

  /* Se a pessoa trocar o tema do sistema com a aba aberta, o ícone acompanha.
     addEventListener em MediaQueryList é o caminho atual; addListener fica
     como reserva para navegadores antigos. */
  if (consulta.addEventListener) consulta.addEventListener('change', aplicar);
  else if (consulta.addListener) consulta.addListener(aplicar);

  window.Homio.quandoPronto(aplicar);
  window.Homio.aoNavegar(aplicar);
})();
}
