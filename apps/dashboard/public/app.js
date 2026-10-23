const $ = (id) => document.getElementById(id);

const text = (value, fallback = '—') => {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
};

const fixed = (value, digits = 4) => {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : String(value);
};

const percent = (value, digits = 1) => {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(digits)}%` : String(value);
};

const clock = (value) => {
  if (!value) return '—';
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour12: false });
};

const cell = (value, className) => {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text(value);
  return td;
};

const pill = (value, prefix) => {
  const span = document.createElement('span');
  span.className = `pill pill--${prefix}${text(value, '')}`;
  span.textContent = text(value).toUpperCase();
  return span;
};

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function setTicker(message, danger = false) {
  const ticker = $('ticker');
  ticker.textContent = message;
  ticker.style.background = danger ? 'var(--vermillion)' : 'var(--ink)';
}

function renderRollout(metrics) {
  const executions = metrics?.executions ?? {};
  const orders = metrics?.orders ?? {};
  const costs = metrics?.costs ?? {};
  const inventory = metrics?.inventory ?? {};
  const transferTax = metrics?.transferTax ?? {};
  const risk = metrics?.risk ?? {};
  $('rollout-fill').textContent = percent(executions.fillRate);
  $('rollout-first-partial').textContent = percent(executions.firstLegPartialRate);
  $('rollout-second-failure').textContent = percent(executions.secondLegFailureRate);
  $('rollout-unknown').textContent = percent(orders.unknownOrderRate);
  $('rollout-query-errors').textContent = percent(orders.queryErrorRate);
  $('rollout-live-profit').textContent = fixed(costs.liveRealizedProfitUsd, 4);
  $('rollout-rebalance').textContent = fixed(costs.rebalanceCostUsd, 4);
  $('rollout-gas').textContent = fixed(costs.gasCostUsd, 4);
  $('rollout-inventory-drift').textContent =
    `${fixed(inventory.observedAbsoluteChangeUsd, 4)} / ${text(inventory.snapshotPairs, '0')}`;
  $('rollout-transfer-tax').textContent = `${fixed(transferTax.maxTransferTaxBps, 2)} bps`;
  $('rollout-risk').textContent = text(risk.events24h, '0');
  $('rollout-operator').textContent = text(risk.operatorInterventions24h, '0');
}

async function refreshSummary() {
  const [summary, health, metrics] = await Promise.all([
    getJson('/api/summary'),
    getJson('/health'),
    getJson('/api/metrics'),
  ]);
  $('metric-valid').textContent = text(summary.opportunity_counts?.valid, '0');
  $('metric-paper').textContent = text(summary.paper_trades?.closed_count, '0');
  $('metric-profit').textContent = fixed(summary.paper_trades?.net_profit, 2);
  const unresolved =
    Number(summary.recovery?.unresolvedLegs ?? 0) + Number(summary.recovery?.openExecutions ?? 0);
  $('metric-recovery').textContent = String(unresolved);
  $('kill-state').textContent = summary.kill_switch ? 'ENGAGED' : 'OPEN';
  $('kill-state').style.color = summary.kill_switch ? 'var(--acid)' : 'var(--vermillion)';
  $('live-state').textContent = summary.live_enabled ? 'ENABLED' : 'DISABLED';
  renderRollout(metrics);
  $('footer-state').textContent = health.timestamp
    ? `SYNC ${new Date(health.timestamp).toLocaleTimeString([], { hour12: false })}`
    : '—';
  setTicker(
    `${summary.kill_switch ? 'KILL SWITCH ENGAGED' : 'KILL SWITCH OPEN'}  /  LIVE EXECUTION ${summary.live_enabled ? 'ENABLED' : 'DISABLED'}  /  ${unresolved} UNRESOLVED ORDER(S)  /  ${text(summary.opportunity_counts?.total, '0')} SAMPLES`,
    summary.kill_switch || unresolved > 0,
  );
}

function renderVenues(rows) {
  const body = $('venues-body');
  body.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = cell('No venue health samples yet.', 'empty');
    td.colSpan = 6;
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.append(
      cell(row.venue_id),
      cell(row.tier),
      (() => {
        const td = document.createElement('td');
        td.append(pill(row.health_state ?? 'D', row.health_state ?? 'D'));
        return td;
      })(),
      cell(row.success_rate === null ? '—' : `${(Number(row.success_rate) * 100).toFixed(1)}%`),
      cell(row.p95_latency_ms === null ? '—' : `${row.p95_latency_ms} ms`),
      cell(row.rate_limit_events ?? '—'),
    );
    body.append(tr);
  }
}

function renderOpportunities(rows) {
  const body = $('opportunities-body');
  body.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = cell('No opportunities persisted yet.', 'empty');
    td.colSpan = 8;
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.append(
      cell(clock(row.sampled_at)),
      cell(row.strategy),
      cell(`${row.venue_buy} → ${row.venue_sell}`),
      cell(fixed(row.requested_notional, 2)),
      cell(fixed(row.depth_net_profit, 4)),
      cell(fixed(row.conservative_net_profit, 4)),
      cell(fixed(row.net_profit_bps, 1)),
      (() => {
        const td = document.createElement('td');
        td.append(pill(row.valid ? 'valid' : 'reject', row.valid ? 'valid' : 'reject'));
        return td;
      })(),
    );
    body.append(tr);
  }
}

function renderEpisodes(rows) {
  const list = $('episodes-list');
  list.replaceChildren();
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No episodes recorded.';
    list.append(p);
    return;
  }
  for (const row of rows.slice(0, 12)) {
    const item = document.createElement('div');
    item.className = 'episode';
    const title = document.createElement('strong');
    title.textContent = `${row.strategy} / ${row.direction}`;
    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = `${row.sample_count} samples · ${Math.round(Number(row.duration_ms) / 1000)}s · median ${fixed(row.median_profit, 4)} USDT · ${row.status}`;
    item.append(title, detail);
    list.append(item);
  }
}

function renderInventory(rows) {
  const body = $('inventory-body');
  body.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = cell('No inventory snapshots yet.', 'empty');
    td.colSpan = 7;
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.append(
      cell(row.venue_name ?? row.venue_id),
      cell(row.asset),
      cell(fixed(row.free, 6)),
      cell(fixed(row.used, 6)),
      cell(fixed(row.total, 6)),
      cell(fixed(row.usd_value, 2)),
      cell(clock(row.captured_at)),
    );
    body.append(tr);
  }
}

function renderRisks(rows) {
  const list = $('risk-list');
  list.replaceChildren();
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No risk events recorded.';
    list.append(p);
    return;
  }
  for (const row of rows.slice(0, 12)) {
    const item = document.createElement('div');
    item.className = `risk risk--${row.severity}`;
    const title = document.createElement('strong');
    title.textContent = `${String(row.severity).toUpperCase()} / ${row.rule}`;
    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = `${clock(row.created_at)} · ${row.message}`;
    item.append(title, detail);
    list.append(item);
  }
}

async function refreshTables() {
  const [venues, opportunities, episodes, inventory, risks] = await Promise.all([
    getJson('/api/venues'),
    getJson('/api/opportunities?limit=40'),
    getJson('/api/episodes?limit=20'),
    getJson('/api/inventory'),
    getJson('/api/risk-events'),
  ]);
  renderVenues(venues);
  renderOpportunities(opportunities);
  renderEpisodes(episodes);
  renderInventory(inventory);
  renderRisks(risks);
}

async function refresh() {
  try {
    await Promise.all([refreshSummary(), refreshTables()]);
  } catch (error) {
    setTicker(`LOCAL API UNAVAILABLE / ${String(error)}`, true);
  }
}

$('kill-toggle').addEventListener('click', async () => {
  const current = $('kill-state').textContent === 'ENGAGED';
  const reason = window.prompt(
    current ? 'Reason for releasing the kill switch:' : 'Reason for engaging the kill switch:',
  );
  if (reason === null) return;
  try {
    await getJson('/api/kill-switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: !current, reason }),
    });
    await refresh();
  } catch (error) {
    setTicker(`KILL SWITCH UPDATE FAILED / ${String(error)}`, true);
  }
});

setInterval(() => {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
}, 1000);
$('clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
refresh();
setInterval(refresh, 5000);
