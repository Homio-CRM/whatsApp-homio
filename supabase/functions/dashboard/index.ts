import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Homio — Painel de Métricas</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --accent: #3b82f6;
      --success: #22c55e;
      --danger: #ef4444;
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --border: #334155;
      --radius: 12px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
    }

    .container { max-width: 1280px; margin: 0 auto; padding: 24px 16px; }

    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    h1 span { color: var(--accent); }

    /* Config bar */
    .config-bar {
      background: var(--card);
      border-radius: var(--radius);
      padding: 16px 20px;
      margin-bottom: 24px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: end;
    }
    .config-bar .field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 200px; }
    .config-bar label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    .config-bar input {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 14px;
      color: var(--text);
      font-size: 0.875rem;
      outline: none;
      transition: border-color 0.2s;
    }
    .config-bar input:focus { border-color: var(--accent); }
    .config-bar input::placeholder { color: var(--text-muted); }

    .btn {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 10px 24px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
      white-space: nowrap;
      height: 42px;
    }
    .btn:hover { opacity: 0.85; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* KPI Cards */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: var(--card);
      border-radius: var(--radius);
      padding: 20px;
      border-left: 4px solid var(--accent);
    }
    .kpi-card .label { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; font-weight: 600; }
    .kpi-card .value { font-size: 2rem; font-weight: 700; }
    .kpi-card.danger { border-left-color: var(--danger); }
    .kpi-card.danger .value { color: var(--danger); }
    .kpi-card.success { border-left-color: var(--success); }
    .kpi-card.success .value { color: var(--success); }

    /* Charts */
    .chart-section {
      background: var(--card);
      border-radius: var(--radius);
      padding: 20px;
      margin-bottom: 24px;
    }
    .chart-section h2 { font-size: 1.1rem; margin-bottom: 16px; font-weight: 600; }
    .chart-wrap { position: relative; width: 100%; max-height: 360px; }

    /* Tables */
    .table-section {
      background: var(--card);
      border-radius: var(--radius);
      padding: 20px;
      margin-bottom: 24px;
      overflow-x: auto;
    }
    .table-section h2 { font-size: 1.1rem; margin-bottom: 16px; font-weight: 600; }

    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    thead th {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 2px solid var(--border);
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    tbody td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    tbody tr:hover { background: rgba(59, 130, 246, 0.05); }

    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-green { background: rgba(34, 197, 94, 0.15); color: var(--success); }
    .badge-red { background: rgba(239, 68, 68, 0.15); color: var(--danger); }

    /* Collapsible failed events */
    .collapsible-header {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      user-select: none;
    }
    .collapsible-header .arrow { transition: transform 0.2s; display: inline-block; }
    .collapsible-header.open .arrow { transform: rotate(90deg); }
    .collapsible-body { display: none; margin-top: 16px; }
    .collapsible-body.open { display: block; }

    .failed-header { color: var(--danger); }
    .failed-count {
      background: var(--danger);
      color: #fff;
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 9999px;
      font-weight: 700;
    }

    /* Footer */
    .footer {
      text-align: center;
      padding: 24px 0;
      color: var(--text-muted);
      font-size: 0.8rem;
      border-top: 1px solid var(--border);
      margin-top: 16px;
    }
    .footer p + p { margin-top: 4px; }

    /* Loading & Error */
    .loading-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.7);
      z-index: 999;
      justify-content: center;
      align-items: center;
    }
    .loading-overlay.active { display: flex; }
    .spinner {
      width: 48px; height: 48px;
      border: 4px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .error-msg {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid var(--danger);
      border-radius: var(--radius);
      padding: 16px 20px;
      color: var(--danger);
      margin-bottom: 24px;
      display: none;
    }

    .placeholder-msg {
      color: var(--text-muted);
      text-align: center;
      padding: 40px 20px;
      font-size: 0.95rem;
    }

    @media (max-width: 640px) {
      .kpi-card .value { font-size: 1.5rem; }
      h1 { font-size: 1.3rem; }
    }
  </style>
</head>
<body>
  <div class="loading-overlay" id="loading"><div class="spinner"></div></div>

  <div class="container">
    <h1><span>WhatsApp Homio</span> Painel de Métricas</h1>

    <!-- Config Bar -->
    <div class="config-bar">
      <div class="field" style="flex: 3;">
        <label>URL da API</label>
        <input type="url" id="apiUrl" placeholder="https://...supabase.co/functions/v1/metrics-dashboard">
      </div>
      <div class="field" style="flex: 1;">
        <label>API Key (opcional)</label>
        <input type="password" id="apiKey" placeholder="Bearer token ou anon key">
      </div>
      <button class="btn" id="btnLoad" onclick="loadDashboard()">Carregar</button>
    </div>

    <div class="error-msg" id="errorMsg"></div>

    <!-- Dashboard content (hidden until data loads) -->
    <div id="dashboardContent" style="display:none;">

      <!-- KPI Cards -->
      <div class="kpi-grid">
        <div class="kpi-card" id="kpiMsgsToday">
          <div class="label">Mensagens Hoje</div>
          <div class="value" id="valMsgsToday">—</div>
        </div>
        <div class="kpi-card" id="kpiMsgsWeek">
          <div class="label">Mensagens esta Semana</div>
          <div class="value" id="valMsgsWeek">—</div>
        </div>
        <div class="kpi-card" id="kpiFailRate">
          <div class="label">Taxa de Falha</div>
          <div class="value" id="valFailRate">—</div>
        </div>
        <div class="kpi-card" id="kpiInstances">
          <div class="label">Instâncias Online</div>
          <div class="value" id="valInstances">—</div>
        </div>
        <div class="kpi-card" id="kpiAudios">
          <div class="label">Áudios Transcritos Hoje</div>
          <div class="value" id="valAudios">—</div>
        </div>
      </div>

      <!-- Chart: Messages per Day -->
      <div class="chart-section">
        <h2>Mensagens por Dia (últimos 14 dias)</h2>
        <div class="chart-wrap"><canvas id="chartDaily"></canvas></div>
      </div>

      <!-- Chart: Volume per Hour -->
      <div class="chart-section">
        <h2>Volume por Hora (últimas 48h)</h2>
        <div class="chart-wrap"><canvas id="chartHourly"></canvas></div>
      </div>

      <!-- Table: Instances -->
      <div class="table-section">
        <h2>Instâncias</h2>
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Número</th>
              <th>Location</th>
              <th>Status</th>
              <th>Msgs Hoje</th>
              <th>Msgs Semana</th>
              <th>Msgs Mês</th>
              <th>Falhas Semana</th>
            </tr>
          </thead>
          <tbody id="tbodyInstances"></tbody>
        </table>
      </div>

      <!-- Table: Failed Events (collapsible) -->
      <div class="table-section" id="failedSection" style="display:none;">
        <div class="collapsible-header" id="failedToggle" onclick="toggleFailed()">
          <span class="arrow">&#9654;</span>
          <h2 class="failed-header">Eventos Falhados</h2>
          <span class="failed-count" id="failedCount">0</span>
        </div>
        <div class="collapsible-body" id="failedBody">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Tipo</th>
                <th>Instância</th>
                <th>Erro</th>
                <th>Tentativas</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody id="tbodyFailed"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Placeholder when no data -->
    <div id="placeholder">
      <div class="placeholder-msg">Configure a URL da API acima e clique em <strong>Carregar</strong> para visualizar as métricas.</div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <p id="footerTimestamp">Dados gerados em: —</p>
      <p>WhatsApp Homio — Painel de Métricas</p>
    </div>
  </div>

  <script>
    // ---- State ----
    let chartDaily = null;
    let chartHourly = null;

    // ---- Init ----
    (function init() {
      const savedUrl = localStorage.getItem('wh_api_url');
      const savedKey = localStorage.getItem('wh_api_key');
      if (savedUrl) document.getElementById('apiUrl').value = savedUrl;
      if (savedKey) document.getElementById('apiKey').value = savedKey;

      // Default URL
      if (!savedUrl) {
        document.getElementById('apiUrl').value = 'https://mlntilbkenjjejksevdx.supabase.co/functions/v1/metrics-dashboard';
      }
    })();

    // ---- Toggle Failed Events ----
    function toggleFailed() {
      const header = document.getElementById('failedToggle');
      const body = document.getElementById('failedBody');
      header.classList.toggle('open');
      body.classList.toggle('open');
    }

    // ---- Load Dashboard ----
    async function loadDashboard() {
      const url = document.getElementById('apiUrl').value.trim();
      const key = document.getElementById('apiKey').value.trim();

      if (!url) {
        showError('Informe a URL da API.');
        return;
      }

      // Save to localStorage
      localStorage.setItem('wh_api_url', url);
      localStorage.setItem('wh_api_key', key);

      // UI
      hideError();
      showLoading(true);
      document.getElementById('btnLoad').disabled = true;

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (key) {
          headers['Authorization'] = key.startsWith('Bearer ') ? key : \`Bearer \${key}\`;
          headers['apikey'] = key.replace(/^Bearer\\s+/, '');
        }

        const resp = await fetch(url, { headers });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(\`HTTP \${resp.status}: \${text.slice(0, 300)}\`);
        }

        const data = await resp.json();
        renderDashboard(data);
      } catch (err) {
        showError(\`Erro ao carregar dados: \${err.message}\`);
      } finally {
        showLoading(false);
        document.getElementById('btnLoad').disabled = false;
      }
    }

    // ---- Render ----
    function renderDashboard(data) {
      document.getElementById('dashboardContent').style.display = 'block';
      document.getElementById('placeholder').style.display = 'none';

      renderKPIs(data);
      renderDailyChart(data);
      renderHourlyChart(data);
      renderInstancesTable(data);
      renderFailedEvents(data);
      renderFooter(data);
    }

    function renderKPIs(data) {
      const kpi = data.kpis || data.summary || data;

      // Messages today
      const msgsToday = kpi.messages_today ?? kpi.msgs_today ?? kpi.mensagens_hoje ?? 0;
      document.getElementById('valMsgsToday').textContent = fmtNum(msgsToday);

      // Messages this week
      const msgsWeek = kpi.messages_week ?? kpi.msgs_week ?? kpi.mensagens_semana ?? 0;
      document.getElementById('valMsgsWeek').textContent = fmtNum(msgsWeek);

      // Fail rate
      const failRate = kpi.fail_rate ?? kpi.failure_rate ?? kpi.taxa_falha ?? 0;
      const failPct = typeof failRate === 'number' && failRate <= 1 ? failRate * 100 : failRate;
      document.getElementById('valFailRate').textContent = failPct.toFixed(1) + '%';
      const kpiFailCard = document.getElementById('kpiFailRate');
      kpiFailCard.className = 'kpi-card' + (failPct > 5 ? ' danger' : '');

      // Instances online
      const online = kpi.instances_online ?? kpi.online ?? 0;
      const total = kpi.instances_total ?? kpi.total_instances ?? kpi.total ?? 0;
      document.getElementById('valInstances').textContent = \`\${online}/\${total}\`;
      const kpiInstCard = document.getElementById('kpiInstances');
      kpiInstCard.className = 'kpi-card' + (online === total && total > 0 ? ' success' : (online < total ? ' danger' : ''));

      // Audios transcribed today
      const audios = kpi.audios_today ?? kpi.audios_transcritos_hoje ?? kpi.transcriptions_today ?? 0;
      document.getElementById('valAudios').textContent = fmtNum(audios);
    }

    function renderDailyChart(data) {
      const daily = data.daily_metrics || data.daily || data.messages_per_day || [];
      if (!daily.length) return;

      const labels = daily.map(d => {
        const dt = new Date(d.date || d.day || d.dia);
        return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      });
      const received = daily.map(d => d.messages_received ?? d.received ?? d.mensagens ?? d.total ?? 0);
      const failed = daily.map(d => d.failed ?? d.failures ?? d.falhas ?? 0);

      const ctx = document.getElementById('chartDaily').getContext('2d');
      if (chartDaily) chartDaily.destroy();

      chartDaily = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Mensagens Recebidas',
              data: received,
              backgroundColor: 'rgba(59, 130, 246, 0.6)',
              borderColor: '#3b82f6',
              borderWidth: 1,
              borderRadius: 4,
              order: 2
            },
            {
              label: 'Falhas',
              data: failed,
              type: 'line',
              borderColor: '#ef4444',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              borderWidth: 2,
              pointRadius: 4,
              pointBackgroundColor: '#ef4444',
              tension: 0.3,
              fill: false,
              order: 1
            }
          ]
        },
        options: chartOptions('Mensagens')
      });
    }

    function renderHourlyChart(data) {
      const hourly = data.hourly_metrics || data.hourly || data.volume_per_hour || [];
      if (!hourly.length) return;

      const labels = hourly.map(h => {
        const dt = new Date(h.hour || h.timestamp || h.hora);
        return dt.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      });
      const volumes = hourly.map(h => h.count ?? h.volume ?? h.messages ?? h.total ?? 0);

      const ctx = document.getElementById('chartHourly').getContext('2d');
      if (chartHourly) chartHourly.destroy();

      chartHourly = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Volume',
            data: volumes,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            borderWidth: 2,
            pointRadius: 2,
            pointBackgroundColor: '#3b82f6',
            tension: 0.3,
            fill: true
          }]
        },
        options: chartOptions('Mensagens')
      });
    }

    function chartOptions(yLabel) {
      return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#94a3b8', font: { size: 12 } } }
        },
        scales: {
          x: {
            ticks: { color: '#94a3b8', maxRotation: 45, font: { size: 11 } },
            grid: { color: 'rgba(51,65,85,0.4)' }
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#94a3b8', font: { size: 11 } },
            grid: { color: 'rgba(51,65,85,0.4)' },
            title: { display: true, text: yLabel, color: '#94a3b8' }
          }
        }
      };
    }

    function renderInstancesTable(data) {
      const instances = data.instances || data.instancias || [];
      const tbody = document.getElementById('tbodyInstances');
      tbody.innerHTML = '';

      instances.forEach(inst => {
        const name = inst.name ?? inst.nome ?? inst.instance_name ?? '—';
        const number = inst.number ?? inst.numero ?? inst.phone ?? '—';
        const location = inst.location ?? inst.location_name ?? '—';
        const status = inst.status ?? inst.state ?? 'unknown';
        const isOpen = status.toLowerCase() === 'open';
        const msgsToday = inst.messages_today ?? inst.msgs_today ?? 0;
        const msgsWeek = inst.messages_week ?? inst.msgs_week ?? 0;
        const msgsMonth = inst.messages_month ?? inst.msgs_month ?? 0;
        const failsWeek = inst.failures_week ?? inst.fails_week ?? inst.falhas_semana ?? 0;

        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>\${esc(name)}</td>
          <td>\${esc(String(number))}</td>
          <td>\${esc(String(location))}</td>
          <td><span class="badge \${isOpen ? 'badge-green' : 'badge-red'}">\${esc(status)}</span></td>
          <td>\${fmtNum(msgsToday)}</td>
          <td>\${fmtNum(msgsWeek)}</td>
          <td>\${fmtNum(msgsMonth)}</td>
          <td>\${fmtNum(failsWeek)}</td>
        \`;
        tbody.appendChild(tr);
      });
    }

    function renderFailedEvents(data) {
      const events = data.failed_events || data.eventos_falhados || [];
      const section = document.getElementById('failedSection');

      if (!events.length) {
        section.style.display = 'none';
        return;
      }

      section.style.display = 'block';
      document.getElementById('failedCount').textContent = events.length;

      const tbody = document.getElementById('tbodyFailed');
      tbody.innerHTML = '';

      events.forEach(ev => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>\${esc(String(ev.id ?? '—'))}</td>
          <td>\${esc(ev.type ?? ev.tipo ?? ev.event_type ?? '—')}</td>
          <td>\${esc(ev.instance ?? ev.instancia ?? ev.instance_name ?? '—')}</td>
          <td title="\${esc(ev.error ?? ev.erro ?? '')}">\${esc((ev.error ?? ev.erro ?? '—').slice(0, 80))}</td>
          <td>\${ev.retries ?? ev.tentativas ?? ev.retry_count ?? 0}</td>
          <td>\${fmtDate(ev.date ?? ev.data ?? ev.created_at)}</td>
        \`;
        tbody.appendChild(tr);
      });
    }

    function renderFooter(data) {
      const ts = data.generated_at || data.timestamp || data.gerado_em || new Date().toISOString();
      document.getElementById('footerTimestamp').textContent = \`Dados gerados em: \${fmtDate(ts)}\`;
    }

    // ---- Helpers ----
    function fmtNum(n) {
      return Number(n).toLocaleString('pt-BR');
    }

    function fmtDate(d) {
      if (!d) return '—';
      try {
        return new Date(d).toLocaleString('pt-BR');
      } catch {
        return String(d);
      }
    }

    function esc(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function showError(msg) {
      const el = document.getElementById('errorMsg');
      el.textContent = msg;
      el.style.display = 'block';
    }

    function hideError() {
      document.getElementById('errorMsg').style.display = 'none';
    }

    function showLoading(show) {
      document.getElementById('loading').classList.toggle('active', show);
    }
  </script>
</body>
</html>
`;

Deno.serve(async (_req: Request) => {
  return new Response(HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Connection': 'keep-alive',
    },
  });
});
