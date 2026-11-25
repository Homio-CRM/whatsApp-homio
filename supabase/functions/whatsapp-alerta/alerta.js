// Aviso de WhatsApp desconectado, colado no Custom JS do app WhatsApp Homio (Marketplace GHL).
// A index.ts tambem serve esta funcao via toString(), para teste pelo console.
// Regras do validador da GHL (pagas em 2026-09-25): sem codigo ofuscado, sem acesso direto ao
// armazenamento do navegador (so AppUtils.Storage), e evitamos innerHTML/eval por precaucao.
export function alertaWhats() {
  if (window.__homioAlertaWhats) return;

  var EF = "https://mlntilbkenjjejksevdx.supabase.co/functions/v1/whatsapp-alerta";
  var PAGINA_CONEXAO = "684177492b181d5a294084ad"; // custom page link da pagina de conexao
  var TTL = 5 * 60 * 1000; // cache do status por location (em memoria)
  var ADIAR = 24 * 60 * 60 * 1000; // "lembrar amanha"
  var P = "homio-alerta-whats:";

  var estado = {
    versao: 2,
    locationId: null,
    admin: null,
    usuario: null,
    fora: null,
    erro: null,
    visivel: false,
  };
  window.__homioAlertaWhats = estado;

  // O AppUtils real da GHL agrupa as funcoes ({ Utilities, RouteHelper, Storage, StoreEvents }),
  // diferente de parte da doc, que mostra AppUtils.getCurrentUser() direto. Aceita os dois formatos.
  function funcaoAppUtils(nome, grupo) {
    var AU = window.AppUtils;
    if (!AU) return null;
    if (typeof AU[nome] === "function") return AU[nome].bind(AU);
    var G = AU[grupo];
    if (G && typeof G[nome] === "function") return G[nome].bind(G);
    return null;
  }

  // Guardar preferencia (dispensa, adiamento) so pelo AppUtils.Storage. Sem ele, so nao lembra.
  function guardar(chave, valor) {
    var set = funcaoAppUtils("setData", "Storage");
    if (!set) return Promise.resolve();
    return Promise.resolve().then(function () { return set(chave, valor); }).catch(function () {});
  }
  function ler(chave) {
    var get = funcaoAppUtils("getData", "Storage");
    if (!get) return Promise.resolve(null);
    return Promise.resolve().then(function () { return get(chave); }).catch(function () { return null; });
  }

  function locationDaUrl() {
    var m = location.pathname.match(/\/v2\/location\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }

  // So admin ve o aviso (decisao do Luan, 2026-09-25). Sem AppUtils nao da pra saber: nao mostra.
  function carregarUsuario() {
    if (estado.admin !== null) return Promise.resolve(estado.admin);
    var getUser = funcaoAppUtils("getCurrentUser", "Utilities");
    if (!getUser) {
      estado.erro = window.AppUtils ? "AppUtils sem getCurrentUser" : "sem AppUtils";
      return Promise.resolve(null);
    }
    estado.erro = null;
    return Promise.resolve()
      .then(function () { return getUser(); })
      .then(function (u) {
        estado.usuario = u ? { type: u.type, role: u.role, campos: Object.keys(u) } : null;
        estado.admin = !!(u && String(u.role).toLowerCase() === "admin");
        return estado.admin;
      })
      .catch(function (e) {
        estado.erro = "getCurrentUser: " + (e && e.message ? e.message : e);
        return null;
      });
  }

  var cache = {}; // locationId -> { em, fora }

  function buscarStatus(loc, forcar) {
    var c = cache[loc];
    if (!forcar && c && Date.now() - c.em < TTL) return Promise.resolve(c.fora);
    return fetch(EF + "?locationId=" + encodeURIComponent(loc))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ok) return null; // falhou: nao aparece
        cache[loc] = { em: Date.now(), fora: j.fora };
        return j.fora;
      })
      .catch(function () { return null; });
  }

  function chaveIncidente(loc, i) { return P + "x:" + loc + ":" + i.instancia + ":" + i.desde; }
  function chaveAdiar(loc) { return P + "ate:" + loc; }

  function pendentes(loc, fora) {
    if (!fora || !fora.length) return Promise.resolve([]);
    return ler(chaveAdiar(loc)).then(function (ate) {
      if (Number(ate || 0) > Date.now()) return [];
      return Promise.all(fora.map(function (i) { return ler(chaveIncidente(loc, i)); }))
        .then(function (dispensas) {
          return fora.filter(function (_i, n) { return !dispensas[n]; });
        });
    });
  }

  function quando(iso) {
    try {
      return new Date(iso).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      });
    } catch (e) { return ""; }
  }

  // Monta elemento com createElement; texto sempre via textContent (nada de HTML vindo do banco).
  function el(tag, classe, texto) {
    var e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }

  var CSS =
    ".c{box-sizing:border-box;display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border-radius:10px;" +
    "background:#fffbeb;border:1px solid #f59e0b;color:#78350f;font:14px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
    "box-shadow:0 8px 24px rgba(0,0,0,.12)}" +
    ".i{font-size:18px;line-height:1.2}.t{flex:1;min-width:0}.b{display:block;font-weight:700;margin-bottom:2px}" +
    ".a{display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap}" +
    "button{font:inherit;cursor:pointer;border-radius:6px}" +
    ".r{background:#d97706;color:#fff;border:0;padding:5px 12px;font-weight:600}.r:hover{background:#b45309}" +
    ".l{background:none;border:0;color:#92400e;text-decoration:underline;padding:0}" +
    ".x{background:none;border:0;color:#92400e;font-size:18px;line-height:1;padding:0 2px}";

  var host = null;

  function esconder() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    estado.visivel = false;
  }

  function irParaConexao(loc) {
    var path = "/v2/location/" + loc + "/custom-page-link/" + PAGINA_CONEXAO;
    try {
      var nav = funcaoAppUtils("navigate", "RouteHelper");
      if (nav) { nav({ path: path }); return; }
    } catch (e) { /* cai no href */ }
    location.href = path;
  }

  function mostrar(loc, lista) {
    esconder();
    if (!lista.length) return;

    var primeira = lista[0];
    var nome = primeira.nome || primeira.provedor || "Seu WhatsApp";
    var numero = primeira.numero ? " (final " + primeira.numero + ")" : "";
    var extra = lista.length > 1 ? " e mais " + (lista.length - 1) + " número(s)" : "";
    var desde = quando(primeira.desde);

    host = document.createElement("div");
    host.setAttribute("data-homio-alerta-whats", "");
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("top", "68px", "important");
    host.style.setProperty("left", "50%", "important");
    host.style.setProperty("transform", "translateX(-50%)", "important");
    host.style.setProperty("z-index", "2147483000", "important");
    host.style.setProperty("width", "min(560px, calc(100vw - 32px))", "important");

    var raiz = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    raiz.appendChild(el("style", null, CSS));

    var card = el("div", "c");
    card.setAttribute("role", "status");
    card.appendChild(el("div", "i", "⚠️"));

    var t = el("div", "t");
    t.appendChild(el("span", "b", "WhatsApp desconectado"));
    t.appendChild(document.createTextNode(
      nome + numero + extra + " está desconectado" + (desde ? " desde " + desde : "") +
      ". Enquanto isso, as mensagens por ele não são enviadas nem recebidas."
    ));

    var acoes = el("div", "a");
    var bReconectar = el("button", "r", "Reconectar");
    var bAdiar = el("button", "l", "Lembrar amanhã");
    acoes.appendChild(bReconectar);
    acoes.appendChild(bAdiar);
    t.appendChild(acoes);
    card.appendChild(t);

    var bFechar = el("button", "x", "×");
    bFechar.setAttribute("aria-label", "Dispensar este aviso");
    card.appendChild(bFechar);
    raiz.appendChild(card);

    bReconectar.addEventListener("click", function () { irParaConexao(loc); esconder(); });
    bAdiar.addEventListener("click", function () {
      guardar(chaveAdiar(loc), String(Date.now() + ADIAR));
      esconder();
    });
    // X dispensa so esta queda: se reconectar e cair de novo, o incidente e outro e o aviso volta.
    bFechar.addEventListener("click", function () {
      lista.forEach(function (i) { guardar(chaveIncidente(loc, i), "1"); });
      esconder();
    });

    document.body.appendChild(host);
    estado.visivel = true;
  }

  var ultimaBusca = 0;

  function verificar(forcar) {
    var loc = locationDaUrl();
    if (loc !== estado.locationId) {
      estado.locationId = loc;
      estado.fora = null;
      esconder();
      forcar = true;
    }
    if (!loc) return;
    if (!forcar && Date.now() - ultimaBusca < TTL) return;
    ultimaBusca = Date.now();

    carregarUsuario().then(function (admin) {
      if (admin === null) { ultimaBusca = 0; return; } // AppUtils ainda nao carregou: tenta no proximo tique
      if (!admin) return;
      return buscarStatus(loc).then(function (fora) {
        if (loc !== estado.locationId) return; // trocou de subconta no meio
        estado.fora = fora;
        if (fora === null) { esconder(); return; }
        return pendentes(loc, fora).then(function (lista) {
          if (loc !== estado.locationId) return;
          if (!lista.length) { esconder(); return; }
          if (!estado.visivel) mostrar(loc, lista);
        });
      });
    });
  }

  // Depuracao no console: __homioAlertaWhats.reset() desfaz dispensa/adiamento das quedas atuais.
  estado.reset = function () {
    var loc = locationDaUrl();
    var feitos = [guardar(chaveAdiar(loc), "")];
    (estado.fora || []).forEach(function (i) { feitos.push(guardar(chaveIncidente(loc, i), "")); });
    delete cache[loc];
    estado.admin = null;
    esconder();
    return Promise.all(feitos).then(function () { verificar(true); });
  };

  function boot() {
    verificar(true);
    // SPA: a URL muda sem recarregar. Checar a URL a cada 2 s e barato; a busca respeita o TTL.
    setInterval(function () { verificar(false); }, 2000);
    window.addEventListener("routeChangeEvent", function () { verificar(false); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") verificar(false);
    });
  }

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
}
