const fs = require('fs');
const path = require('path');

const CHART_JS_PATH = path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
let chartJsCache = null;

function getChartJs() {
  if (!chartJsCache) {
    try {
      chartJsCache = fs.readFileSync(CHART_JS_PATH, 'utf8');
    } catch (err) {
      console.error('[coinflip-dashboard] Failed to load chart.js:', err.message);
      chartJsCache = '';
    }
  }
  return chartJsCache;
}

// The COINFLIP panel. Every tab reads the JSON the bot already serves
// (/api/coinflip/…) and renders the numbers exactly as returned — the panel
// computes nothing except the cumulative equity line, and a missing chart.js
// degrades to tables rather than a blank panel.
function getCoinflipDashboardJs() {
  return `(function () {
  'use strict';
  var currentTab = 'overview';
  var botsList = [];
  var selectedBot = null;
  var charts = {};
  var contentVersion = 0;
  function clearCharts () {
    Object.keys(charts).forEach(function (id) { charts[id].destroy(); });
    charts = {};
  }

  // The script is loaded from <head>, so the panel does not exist yet when it
  // runs. Resolving the elements here at run time is what left every tab blank
  // before — the lookups returned null and each renderer quietly returned.
  var cfkpi = null;
  var cfbotlist = null;
  var cftabs = null;
  var cfcontent = null;
  var cfclose = null;
  var coinflipbtn = null;
  var coinflippanel = null;
  function bindElements () {
    cfkpi = document.getElementById('cfkpi');
    cfbotlist = document.getElementById('cfbotlist');
    cftabs = document.getElementById('cftabs');
    cfcontent = document.getElementById('cfcontent');
    cfclose = document.getElementById('cfclose');
    coinflipbtn = document.getElementById('coinflipbtn');
    coinflippanel = document.getElementById('coinflippanel');
  }

  function esc (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function money (v) {
    if (v == null || !isFinite(v)) return '\\u2013';
    var n = Number(v), sign = n < 0 ? '-' : '';
    n = Math.abs(n);
    if (n >= 1e9) return sign + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return sign + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return sign + (n / 1e3).toFixed(1) + 'k';
    return sign + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  // The hover tooltips say the whole number: a chart that rounds is a chart
  // you have to go check elsewhere.
  function exact (v) {
    return v == null || !isFinite(v) ? '\\u2013' : String(Number(v));
  }
  function pct (v, d) {
    return v == null || !isFinite(v) ? '\\u2013' : (Number(v) * 100).toFixed(d == null ? 1 : d) + '%';
  }
  function fmtT (t) {
    return t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '\\u2013';
  }
  function kpi (label, value, cls) {
    var color = cls === 'good' ? 'var(--grn)' : cls === 'bad' ? 'var(--red)' : 'var(--txt)';
    return '<div class="kpi"><div style="color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px">' +
      esc(label) + '</div><div style="font-size:18px;color:' + color + '">' + esc(String(value)) + '</div></div>';
  }
  function empty (text) {
    return '<div style="color:var(--dim);padding:10px 0">' + esc(text) + '</div>';
  }
  function table (head, rows, emptyText) {
    return '<table style="border-collapse:collapse;width:100%;font-size:12px"><thead><tr>' +
      head.map(function (h) { return '<th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);color:var(--dim);font-weight:500;text-transform:uppercase;font-size:10px">' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      (rows.length ? rows.join('') : '<tr><td colspan="' + head.length + '" style="padding:8px;color:var(--dim)">' + esc(emptyText) + '</td></tr>') +
      '</tbody></table>';
  }
  function verdictColor (verdict) {
    if (verdict === 'suspicious') return 'var(--red)';
    if (verdict === 'watch') return 'var(--yel)';
    if (verdict === 'within-noise') return 'var(--grn)';
    return 'var(--dim)';
  }
  function streakText (streak) {
    if (!streak || !streak.length) return 'none yet';
    return streak.length + ' ' + (streak.kind || '') ;
  }

  // ── Charts (chart.js when present; tables always carry the numbers) ────────
  function drawChart (id, config) {
    if (!window.Chart) return;
    var canvas = document.getElementById(id);
    if (!canvas) return;
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    charts[id] = new window.Chart(canvas.getContext('2d'), config);
  }
  function lineOptions (unit) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            label: function (ctx) {
              return (unit || '') + exact(ctx.parsed.y);
            },
            afterLabel: function (ctx) {
              var extra = ctx.dataset && ctx.dataset.extra && ctx.dataset.extra[ctx.dataIndex];
              return extra || '';
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#5b6b7a', maxTicksLimit: 8 }, grid: { color: '#1d2836' } },
        y: { ticks: { color: '#5b6b7a', callback: function (v) { return money(v); } }, grid: { color: '#1d2836' } }
      }
    };
  }
  function equityOf (rows) {
    // Cumulative net over the resolved flips, oldest first. Unresolved flips
    // move no money, so they move the line not at all.
    var chronological = rows.slice().sort(function (a, b) { return Number(a.ts) - Number(b.ts); });
    var labels = [], data = [], extra = [], sum = 0, n = 0;
    chronological.forEach(function (r) {
      if (r.result !== 'won' && r.result !== 'lost') return;
      var delta = r.delta != null ? Number(r.delta) : (r.result === 'won' ? Number(r.wager) : -Number(r.wager));
      if (!isFinite(delta)) delta = 0;
      sum += delta;
      n += 1;
      labels.push(fmtT(r.ts));
      data.push(sum);
      extra.push('flip #' + n + ' \\u00b7 ' + esc(r.bot || '?') + ' \\u00b7 ' + (r.result === 'won' ? '+' : '') + exact(delta) + (r.opponent ? ' \\u00b7 vs ' + esc(r.opponent) : ''));
    });
    return { labels: labels, data: data, extra: extra, net: sum };
  }
  function drawEquity (id, rows, labelText) {
    var eq = equityOf(rows);
    drawChart(id, {
      type: 'line',
      data: {
        labels: eq.labels,
        datasets: [{
          label: labelText || 'net over displayed flips (recent window)',
          data: eq.data,
          extra: eq.extra,
          borderColor: '#2dd4bf',
          backgroundColor: 'rgba(45,212,191,0.12)',
          fill: true,
          tension: 0.2,
          pointRadius: 2
        }]
      },
      options: lineOptions('$')
    });
    return eq;
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  async function fetchJson (url) {
    var resp = await fetch(url, { credentials: 'same-origin' });
    return resp.json();
  }

  async function loadBots () {
    try {
      var data = await fetchJson('/api/coinflip/bots');
      botsList = Object.entries(data.bots || {}).map(function (pair) {
        return { id: pair[0], flips: pair[1].flips || 0, wins: pair[1].wins || 0, losses: pair[1].losses || 0, net: pair[1].net || 0, lastSeen: pair[1].lastSeen || 0 };
      }).sort(function (a, b) { return b.net - a.net; });
      renderBotList();
    } catch (err) {
      console.error('Failed to load bots:', err);
    }
  }

  function renderBotList () {
    if (!cfbotlist) return;
    cfbotlist.innerHTML = '';
    if (!botsList.length) {
      cfbotlist.innerHTML = '<div style="color:var(--dim);font-size:11px">no flips recorded yet</div>';
      return;
    }
    botsList.forEach(function (bot) {
      var div = document.createElement('div');
      div.className = 'bot-item';
      div.style = 'display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--line);cursor:pointer;' +
        (bot.id === selectedBot ? 'color:var(--acc);' : '');
      div.innerHTML = '<span>' + esc(bot.id) + '</span><span style="color:var(--dim)">' +
        bot.flips + ' flips \\u00b7 ' + pct(bot.wins + bot.losses ? bot.wins / (bot.wins + bot.losses) : null, 0) + '</span>';
      div.addEventListener('click', function () {
        selectedBot = bot.id;
        currentTab = 'perbot';
        renderBotList();
        updateTabContent();
      });
      cfbotlist.appendChild(div);
    });
  }

  function renderTabs () {
    if (!cftabs) return;
    var tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'perbot', label: 'Per Bot' },
      { id: 'fairness', label: 'Fairness' },
      { id: 'deep', label: 'Deep Stats' }
    ];
    cftabs.innerHTML = '';
    tabs.forEach(function (tab) {
      var button = document.createElement('button');
      button.className = 'cftab';
      button.dataset.tab = tab.id;
      button.textContent = tab.label;
      button.style = 'padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:' +
        (tab.id === currentTab ? 'var(--panel2);color:var(--acc)' : 'transparent;color:var(--dim)') + ';cursor:pointer;font-size:11px';
      if (tab.id === currentTab) button.classList.add('on');
      cftabs.appendChild(button);
    });
  }

  async function updateTabContent () {
    contentVersion += 1;
    clearCharts();
    renderTabs();
    switch (currentTab) {
      case 'overview': await loadOverview(); break;
      case 'perbot': await loadPerBot(); break;
      case 'fairness': await loadFairness(); break;
      case 'deep': await loadDeep(); break;
    }
  }

  // ── Overview ───────────────────────────────────────────────────────────────
  async function loadOverview () {
    var version = contentVersion;
    try {
      var summary = await fetchJson('/api/coinflip/summary?recent=500');
      if (version !== contentVersion || currentTab !== 'overview') return;
      var stats = summary.stats || {};
      var fair = summary.fairness || {};
      if (cfkpi) {
        cfkpi.innerHTML =
          kpi('total flips', exact(stats.flips || 0)) +
          kpi('resolved', exact(stats.resolved || 0)) +
          kpi('win rate', pct(stats.winRate, 1)) +
          kpi('net P&L', money(stats.net || 0), (stats.net || 0) >= 0 ? 'good' : 'bad') +
          kpi('wagered', money(stats.wagered || 0)) +
          kpi('tracked bots', exact((stats.bots || []).length)) +
          kpi('current streak', streakText(stats.currentStreak)) +
          kpi('best win / loss streak', (stats.longestWinStreak || 0) + ' / ' + (stats.longestLossStreak || 0)) +
          kpi('max drawdown', money(stats.maxDrawdown || 0), 'bad') +
          kpi('msg/balance mismatches', exact(stats.mismatches || 0), stats.mismatches ? 'bad' : '');
      }
      if (!cfcontent) return;
      var verdict = fair.verdict || 'insufficient-data';
      var banner =
        '<div style="border-left:3px solid ' + verdictColor(verdict) + ';padding:10px 12px;background:var(--panel2);border-radius:6px;margin-bottom:12px">' +
        '<b style="color:var(--txt)">Fairness verdict: ' + esc(verdict) + '</b>' +
        '<div style="color:var(--dim);font-size:11px;margin-top:6px">' +
        esc((stats.wins || 0) + 'W / ' + (stats.losses || 0) + 'L over ' + (fair.n || stats.resolved || 0) + ' resolved flip(s)') +
        (fair.p == null ? '' : ' \\u00b7 two-sided p = ' + esc(Number(fair.p).toExponential(2))) +
        (fair.ci ? ' \\u00b7 95% CI ' + pct(fair.ci.low) + '\\u2013' + pct(fair.ci.high) : '') +
        '</div>' +
        ((fair.flags || []).length ? '<ul style="margin:8px 0 0;padding-left:18px;color:var(--dim);font-size:11px">' +
          fair.flags.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' : '') +
        '</div>';
      cfcontent.innerHTML = banner +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px">' +
        '<div style="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px">' +
        '<div style="color:var(--dim);font-size:11px;margin-bottom:6px">Net over displayed recent flips (hover for the exact flip)</div>' +
        '<div style="height:220px"><canvas id="cfEquity"></canvas></div></div>' +
        '<div style="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px">' +
        '<div style="color:var(--dim);font-size:11px;margin-bottom:6px">Net by bot</div>' +
        '<div style="height:220px"><canvas id="cfBotNet"></canvas></div></div>' +
        '</div>';
      var eq = drawEquity('cfEquity', summary.recent || [], 'net over displayed recent flips');
      if (eq && eq.data.length) {
        var note = document.createElement('div');
        note.style = 'color:var(--dim);font-size:11px;margin-top:6px';
        note.textContent = eq.data.length + ' resolved flip(s) plotted \\u00b7 cumulative ' + exact(eq.net);
        cfcontent.querySelector('canvas#cfEquity').parentNode.parentNode.appendChild(note);
      } else if (window.Chart === undefined) {
        cfcontent.innerHTML += empty('chart.js is not installed (npm install) \\u2014 the numbers above are exact.');
      }
      var botStats = (stats.bots || []).slice().sort(function (a, b) { return b.net - a.net; });
      drawChart('cfBotNet', {
        type: 'bar',
        data: {
          labels: botStats.map(function (b) { return b.bot; }),
          datasets: [{
            label: 'net',
            data: botStats.map(function (b) { return b.net; }),
            extra: botStats.map(function (b) { return b.wins + 'W / ' + b.losses + 'L \\u00b7 wagered ' + exact(b.wagered); }),
            backgroundColor: botStats.map(function (b) { return b.net >= 0 ? 'rgba(74,222,128,0.6)' : 'rgba(248,113,113,0.6)'; })
          }]
        },
        options: lineOptions('$')
      });
    } catch (err) {
      console.error('Failed to load overview:', err);
      if (version !== contentVersion) return;
      if (cfcontent) cfcontent.innerHTML = empty('Could not load the coinflip summary: ' + err.message);
    }
  }

  // ── Per bot ────────────────────────────────────────────────────────────────
  async function loadPerBot () {
    var version = ++contentVersion;
    var requestedBot = selectedBot;
    clearCharts();
    if (!cfcontent) return;
    var rows = botsList.map(function (bot) {
      return '<tr data-bot="' + esc(bot.id) + '" style="cursor:pointer' + (bot.id === selectedBot ? ';background:var(--panel2)' : '') + '">' +
        '<td style="padding:4px 8px;border-bottom:1px solid var(--line)">' + esc(bot.id) + '</td>' +
        '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + bot.flips + '</td>' +
        '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + bot.wins + 'W / ' + bot.losses + 'L</td>' +
        '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + pct(bot.wins + bot.losses ? bot.wins / (bot.wins + bot.losses) : null, 1) + '</td>' +
        '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right;color:' + (bot.net >= 0 ? 'var(--grn)' : 'var(--red)') + '">' + money(bot.net) + '</td>' +
        '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right;color:var(--dim)">' + fmtT(bot.lastSeen) + '</td>' +
        '</tr>';
    });
    var listHtml = '<div style="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:12px">' +
      '<div style="color:var(--dim);font-size:11px;margin-bottom:6px">Every bot \\u2014 click a row for its detail</div>' +
      table(['bot', 'flips', 'W/L', 'rate', 'net', 'last flip'], rows, 'no flips recorded yet') + '</div>';
    cfcontent.innerHTML = listHtml + '<div id="cfbotdetail">' + empty(selectedBot ? 'Loading ' + selectedBot + '\\u2026' : 'Select a bot from the list or the table above.') + '</div>';
    Array.prototype.forEach.call(cfcontent.querySelectorAll('tr[data-bot]'), function (tr) {
      tr.addEventListener('click', function () {
        selectedBot = tr.getAttribute('data-bot');
        renderBotList();
        loadPerBot();
      });
    });
    if (!selectedBot) return;
    try {
      var detail = await fetchJson('/api/coinflip/bot?bot=' + encodeURIComponent(requestedBot));
      if (version !== contentVersion || currentTab !== 'perbot' || requestedBot !== selectedBot) return;
      var box = document.getElementById('cfbotdetail');
      if (!box) return;
      var s = (detail.summary && detail.summary.stats) || {};
      var mine = (s.bots || []).filter(function (b) { return b.bot === selectedBot; })[0] || {};
      var flipRows = (detail.rows || []).slice(-25).reverse().map(function (r) {
        return '<tr>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line);color:var(--dim)">' + fmtT(r.ts) + '</td>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line);color:' + (r.result === 'won' ? 'var(--grn)' : r.result === 'lost' ? 'var(--red)' : 'var(--dim)') + '">' + esc(r.result) + '</td>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + money(r.wager) + '</td>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line)">' + esc(r.opponent || '\\u2013') + '</td>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right;color:' + ((r.delta || 0) >= 0 ? 'var(--grn)' : 'var(--red)') + '">' + money(r.delta) + '</td>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line);color:var(--dim)">' + esc(r.method) + (r.mismatched ? ' \\u26a0' : '') + '</td>' +
          '</tr>';
      });
      box.innerHTML =
        '<div style="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px">' +
        '<div style="color:var(--dim);font-size:11px;margin-bottom:8px">' + esc(selectedBot) + ' \\u2014 hover the curve for the exact flip</div>' +
        '<div style="height:200px"><canvas id="cfBotEquity"></canvas></div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:10px">' +
        kpi('flips', exact(mine.flips || 0)) +
        kpi('W / L', (mine.wins || 0) + ' / ' + (mine.losses || 0)) +
        kpi('win rate', pct(mine.wins + mine.losses ? mine.wins / (mine.wins + mine.losses) : null, 1)) +
        kpi('net', money(mine.net || 0), (mine.net || 0) >= 0 ? 'good' : 'bad') +
        kpi('wagered', money(mine.wagered || 0)) +
        '</div>' +
        '<div style="color:var(--dim);font-size:11px;margin:12px 0 6px">Last ' + Math.min(25, (detail.rows || []).length) + ' flip(s)</div>' +
        table(['when', 'result', 'wager', 'opponent', '\\u0394 balance', 'detected by'], flipRows, 'no flips for this bot yet') +
        '</div>';
      drawEquity('cfBotEquity', detail.rows || [], 'net \\u2014 ' + selectedBot);
    } catch (err) {
      console.error('Failed to load bot detail:', err);
    }
  }

  // ── Fairness ───────────────────────────────────────────────────────────────
  async function loadFairness () {
    var version = contentVersion;
    try {
      var fair = await fetchJson('/api/coinflip/fairness');
      if (version !== contentVersion || currentTab !== 'fairness') return;
      if (!cfcontent) return;
      if (fair == null || (fair.n == null && fair.verdict == null)) {
        cfcontent.innerHTML = empty('No fairness data yet \\u2014 run /bot-coinflip run and the tests fill in here.');
        return;
      }
      var verdict = fair.verdict || 'insufficient-data';
      var runs = fair.runs || {};
      var bar =
        '<div style="position:relative;width:100%;max-width:420px;height:18px;background:var(--panel2);border:1px solid var(--line);border-radius:4px;margin:10px 0 4px">' +
        '<div style="position:absolute;left:0;top:0;bottom:0;width:' + Math.max(0, Math.min(100, (fair.winRate || 0) * 100)).toFixed(1) + '%;background:linear-gradient(90deg,rgba(45,212,191,.35),var(--acc))"></div>' +
        (fair.ci ? '<div style="position:absolute;top:0;bottom:0;left:' + (Math.max(0, Math.min(1, fair.ci.low)) * 100).toFixed(1) + '%;width:' +
          ((Math.min(1, fair.ci.high) - Math.max(0, fair.ci.low)) * 100).toFixed(1) + '%;border-left:1px solid #e8f0f6;border-right:1px solid #e8f0f6;opacity:.55"></div>' : '') +
        '<div style="position:absolute;top:0;bottom:0;left:50%;border-left:1px dashed var(--red)"></div>' +
        '</div>' +
        '<div style="color:var(--dim);font-size:11px">The bar is the observed win rate; the red line is the 50% a fair coin gives; the white markers are the 95% confidence interval.</div>';
      var perBot = fair.perBot || {};
      var perBotRows = Object.keys(perBot).sort().map(function (name) {
        var b = perBot[name] || {};
        var v = b.verdict || 'insufficient-data';
        return '<tr>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line)">' + esc(name) + '</td>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + (b.n || 0) + '</td>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + (b.wins || 0) + 'W / ' + (b.losses || 0) + 'L</td>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + pct(b.winRate, 1) + '</td>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + (b.p == null ? '\\u2013' : Number(b.p).toExponential(2)) + '</td>' +
          '<td style="padding:4px 8px;border-bottom:1px solid var(--line);color:' + verdictColor(v) + '">' + esc(v) + '</td>' +
          '</tr>';
      });
      cfcontent.innerHTML =
        '<div style="border-left:3px solid ' + verdictColor(verdict) + ';padding:10px 12px;background:var(--panel2);border-radius:6px;margin-bottom:12px">' +
        '<b style="color:var(--txt)">Fleet verdict: ' + esc(verdict) + '</b>' +
        '<div style="color:var(--dim);font-size:11px;margin-top:6px">' +
        esc((fair.wins || 0) + 'W / ' + (fair.losses || 0) + 'L over ' + (fair.n || 0) + ' resolved flip(s)') +
        (fair.p == null ? '' : ' \\u00b7 z = ' + (fair.z == null ? '\\u2013' : fair.z.toFixed(2)) + ' \\u00b7 p = ' + Number(fair.p).toExponential(2)) +
        (fair.ci ? ' \\u00b7 win rate 95% CI ' + pct(fair.ci.low, 1) + '\\u2013' + pct(fair.ci.high, 1) : '') +
        '</div>' +
        '<div style="color:var(--dim);font-size:11px;margin-top:4px">' +
        (runs.p == null ? '' : 'Runs test: ' + runs.runs + ' runs vs ' + exact(runs.expected) + ' expected (p = ' + Number(runs.p).toFixed(4) + ')') +
        (fair.netPerFlip == null ? '' : ' \\u00b7 net per flip ' + money(fair.netPerFlip) +
          (fair.netCi ? ' (95% CI ' + money(fair.netCi.low) + '\\u2013' + money(fair.netCi.high) + ')' : '')) +
        '</div>' +
        ((fair.flags || []).length ? '<ul style="margin:8px 0 0;padding-left:18px;color:var(--dim);font-size:11px">' +
          fair.flags.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' : '') +
        '</div>' +
        bar +
        '<div style="color:var(--dim);font-size:11px;margin:14px 0 6px">Per bot \\u2014 each bot gets its own binomial test against 50%</div>' +
        table(['bot', 'n', 'W/L', 'rate', 'p', 'verdict'], perBotRows, 'no resolved flips yet');
    } catch (err) {
      console.error('Failed to load fairness:', err);
      if (version !== contentVersion) return;
      if (cfcontent) cfcontent.innerHTML = empty('Could not load the fairness analysis: ' + err.message);
    }
  }

  // ── Deep stats ─────────────────────────────────────────────────────────────
  async function loadDeep () {
    var version = contentVersion;
    try {
      var deep = await fetchJson('/api/coinflip/deep');
      if (version !== contentVersion || currentTab !== 'deep') return;
      if (!cfcontent) return;
      if (!deep || !deep.resolved) {
        cfcontent.innerHTML = empty('No resolved coinflips recorded yet \\u2014 run /bot-coinflip run and every dissection fills in here.');
        return;
      }
      var lag1 = (deep.autocorrelation && deep.autocorrelation[0] && deep.autocorrelation[0].r != null)
        ? Number(deep.autocorrelation[0].r).toFixed(4) : '\\u2013';
      var kpis =
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px">' +
        kpi('resolved flips', exact(deep.resolved)) +
        kpi('win rate', pct(deep.winRate, 2)) +
        kpi('statistical tests', exact(deep.tests || 0)) +
        kpi('FDR level', String(deep.q)) +
        kpi('P(win | win)', pct(deep.markov && deep.markov.pWinAfterWin, 2)) +
        kpi('P(win | loss)', pct(deep.markov && deep.markov.pWinAfterLoss, 2)) +
        kpi('lag-1 correlation', lag1) +
        kpi('hour clock', String(deep.hourSource || 'none')) +
        kpi('deepest drawdown', money((deep.curve || {}).maxDrawdown || 0), 'bad') +
        kpi('longest below a high', ((deep.curve || {}).longestDrawdown || 0) + ' flips') +
        '</div>';
      var takeaways = '<div style="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px">' +
        '<div style="color:var(--acc);font-size:11px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">What the numbers say</div>' +
        '<ul style="margin:0;padding-left:18px;color:var(--txt);font-size:12px;line-height:1.7">' +
        (deep.takeaways || []).map(function (line) { return '<li>' + esc(line) + '</li>'; }).join('') +
        '</ul>' +
        '<div style="color:var(--dim);font-size:11px;margin-top:8px">' + (deep.tests || 0) + ' bucket(s) and trend(s) tested; q is the p-value after the Benjamini\\u2013Hochberg correction. A bucket under ' + (deep.minBucket || 0) + ' flips is marked low n.</div>' +
        '</div>';
      var sections = (deep.sections || []).filter(function (s) { return (s.rows && s.rows.length) || s.summary; }).map(function (s) {
        var rows = (s.rows || []).map(function (r) {
          var flag = r.significant ? '<span style="color:var(--grn)">survives</span>'
            : r.lowSample ? '<span style="color:var(--dim)">low n</span>' : '';
          return '<tr' + (r.significant ? ' style="background:rgba(74,222,128,.07)"' : '') + '>' +
            '<td style="padding:4px 8px;border-bottom:1px solid var(--line)">' + esc(r.label) + '</td>' +
            '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + (r.n == null ? '\\u2013' : r.n) + '</td>' +
            '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + (r.rate == null ? esc(r.note || '\\u2013') : r.wins + 'W/' + r.losses + 'L') + '</td>' +
            '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + pct(r.rate, 1) + '</td>' +
            '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + (r.ci == null ? '\\u2013' : pct(r.ci.low, 1) + '\\u2013' + pct(r.ci.high, 1)) + '</td>' +
            '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + (r.p == null ? '\\u2013' : Number(r.p).toExponential(1)) + '</td>' +
            '<td style="padding:4px 8px;border-bottom:1px solid var(--line);text-align:right">' + (r.q == null ? '\\u2013' : Number(r.q).toExponential(1)) + '</td>' +
            '<td style="padding:4px 8px;border-bottom:1px solid var(--line)">' + flag + '</td>' +
            '</tr>';
        });
        return '<div style="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px">' +
          '<div style="color:var(--acc);font-size:11px;text-transform:uppercase;letter-spacing:.6px">' + esc(s.title) + '</div>' +
          (s.question ? '<div style="color:var(--dim);font-size:11px;margin:4px 0 8px">' + esc(s.question) + '</div>' : '') +
          (rows.length ? table(['bucket', 'n', 'W/L', 'rate', '95% CI', 'p', 'q', ''], rows, 'no data') : '') +
          (s.summary ? '<div style="color:var(--dim);font-size:11px;margin-top:8px">' + esc(s.summary) + '</div>' : '') +
          '</div>';
      }).join('');
      cfcontent.innerHTML = kpis + takeaways + sections;
    } catch (err) {
      console.error('Failed to load deep analysis:', err);
      if (version !== contentVersion) return;
      if (cfcontent) cfcontent.innerHTML = empty('Could not load the deep analysis: ' + err.message);
    }
  }

  async function init () {
    bindElements();
    if (!cfcontent) return;
    await loadBots();
    renderTabs();
    loadOverview();

    if (coinflipbtn) coinflipbtn.onclick = function () { coinflippanel.hidden = false; updateTabContent(); };
    if (cfclose) cfclose.onclick = function () { coinflippanel.hidden = true; };

    if (cftabs) cftabs.addEventListener('click', function (e) {
      if (e.target.classList.contains('cftab')) {
        currentTab = e.target.dataset.tab;
        updateTabContent();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;
}

function handleChartJs(req, res) {
  const js = getChartJs();
  res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
  res.end(js);
}

function handleCoinflipDashboardJs(req, res) {
  const js = getCoinflipDashboardJs();
  res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
  res.end(js);
}

module.exports = { getChartJs, getCoinflipDashboardJs, handleChartJs, handleCoinflipDashboardJs };
