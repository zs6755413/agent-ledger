'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(x, d) {
  return (x * 100).toFixed(d === undefined ? 1 : d) + '%';
}

function usd(x) {
  return '$' + Number(x).toFixed(4);
}

function bar(ratio, color) {
  const w = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return `<div class="bar"><span style="width:${w}%;background:${color || '#378ADD'}"></span></div>`;
}

function renderHtml(a, meta) {
  const t = a.totals;
  const k = a.cost;
  const p = a.policy;
  const cp = a.compound;

  const card = (label, value, note, tone) => `
    <div class="card">
      <div class="card-label">${esc(label)}</div>
      <div class="card-value ${tone || ''}">${esc(value)}</div>
      <div class="card-note">${esc(note || '')}</div>
    </div>`;

  const modelRows = k.byModel.map((m) => `
    <tr>
      <td>${esc(m.model)}</td>
      <td class="num">${m.calls}</td>
      <td class="num">${usd(m.usd)}</td>
      <td class="num">${pct(m.share)}</td>
      <td class="num">${pct(m.callShare)}</td>
    </tr>`).join('');

  const taskRows = k.byTask.map((x) => `
    <tr>
      <td>${x.success ? '<span class="ok">成功</span>' : '<span class="fail">失败</span>'}</td>
      <td>${esc(x.task)}</td>
      <td class="num">${x.steps}</td>
      <td class="num">${usd(x.usd)}</td>
      <td class="num">${pct(x.share)}</td>
    </tr>`).join('');

  const errRows = a.failures.failedByError.map((x) => `
    <tr>
      <td>${esc(x.error)}</td>
      <td class="num">${x.count}</td>
      <td class="num">${usd(x.usd)}</td>
    </tr>`).join('');

  const posRows = a.failures.byPosition.map((x) => `
    <tr>
      <td>${esc(x.label)}</td>
      <td class="num">${x.failed} / ${x.total}</td>
      <td>${bar(x.rate, x.rate > 0.15 ? '#E24B4A' : '#888780')}</td>
      <td class="num">${pct(x.rate)}</td>
    </tr>`).join('');

  const verdict = [];
  if (k.failedShare > 0.3) {
    verdict.push(`钱有 ${pct(k.failedShare)} 花在最终失败的任务上，有效成本是名义成本的 ${k.effectiveMultiple} 倍。先压失败率，比压 token 单价更划算。`);
  }
  if (cp.ci.hi - cp.ci.lo > 0.4) {
    verdict.push(`样本只有 ${t.runs} 个任务，成功率置信区间跨度 ${pct(cp.ci.hi - cp.ci.lo)}，现在的数字只能当趋势看。`);
  }
  if (p.hasPolicy && p.unused.length) {
    verdict.push(`有 ${p.unused.length} 个授予的工具从未被调用：${p.unused.join('、')}。这些是 prompt injection 的现成入口。`);
  }
  if (p.hasPolicy && p.conflicts.length) {
    verdict.push(`policy 里 ${p.conflicts.join('、')} 同时出现在 allow 与 deny，先修配置。`);
  }
  if (k.byModel.length && k.byModel[0].share > 0.6) {
    verdict.push(`${k.byModel[0].model} 吃掉 ${pct(k.byModel[0].share)} 成本，调用次数只占 ${pct(k.byModel[0].callShare)}。`);
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-ledger 运行报告</title>
<style>
  :root {
    --bg: #ffffff; --soft: #f7f7f5; --line: #e4e3df;
    --text: #1f1f1d; --text2: #6b6a65; --text3: #9a998f;
    --blue: #378ADD; --red: #E24B4A; --green: #639922; --amber: #BA7517;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.65 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 44px 22px 70px; }
  h1 { font-size: 21px; font-weight: 600; margin: 0 0 4px; }
  .sub { color: var(--text3); font-size: 13px; margin-bottom: 30px; }
  h2 { font-size: 14px; font-weight: 600; margin: 38px 0 14px; padding-bottom: 8px;
    border-bottom: 1px solid var(--line); color: var(--text); }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  @media (max-width: 720px) { .cards { grid-template-columns: repeat(2, 1fr); } }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 14px 15px; background: var(--bg); }
  .card-label { font-size: 12px; color: var(--text3); margin-bottom: 6px; }
  .card-value { font-size: 22px; font-weight: 600; letter-spacing: -.3px; }
  .card-value.warn { color: var(--red); }
  .card-value.good { color: var(--green); }
  .card-note { font-size: 11px; color: var(--text3); margin-top: 5px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 500; color: var(--text2); font-size: 12px;
    padding: 7px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 8px; border-bottom: 1px solid #f2f1ee; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
  .ok { color: var(--green); font-size: 12px; }
  .fail { color: var(--red); font-size: 12px; }
  .bar { width: 100%; height: 6px; background: var(--soft); border-radius: 3px; overflow: hidden; min-width: 90px; }
  .bar span { display: block; height: 100%; border-radius: 3px; }
  .split { display: grid; grid-template-columns: 170px 1fr 90px; gap: 12px; align-items: center;
    font-size: 13px; padding: 6px 0; }
  .split .num { text-align: right; }
  ol.verdict { padding-left: 20px; margin: 0; }
  ol.verdict li { margin-bottom: 9px; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; color: var(--text2); }
  footer { margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--line);
    font-size: 12px; color: var(--text3); }
</style>
</head>
<body>
<div class="wrap">
  <h1>agent-ledger 运行报告</h1>
  <div class="sub">${esc(meta.file)}${meta.policy ? '  ·  policy: ' + esc(meta.policy) : ''}  ·  ${t.events} 条事件 / ${t.runs} 个任务 / ${t.steps} 步</div>

  <div class="cards">
    ${card('任务成功率', pct(t.successRate), `${t.successRuns} 成功 / ${t.failedRuns} 失败`, t.successRate >= 0.8 ? 'good' : 'warn')}
    ${card('总成本', usd(k.total), `平均每任务 ${usd(k.perRunAvg)}`)}
    ${card('失败消耗占比', pct(k.failedShare), `有效成本 ×${k.effectiveMultiple}`, k.failedShare > 0.3 ? 'warn' : '')}
    ${card('过度授权率', p.hasPolicy ? pct(p.overGrantRate) : '—', p.hasPolicy ? `${p.unused.length} 个工具从未使用` : '未提供 policy', p.hasPolicy && p.overGrantRate > 0.3 ? 'warn' : '')}
  </div>

  <h2>复合成功率：单步能不能推出任务</h2>
  <div class="split"><span>单步成功率</span>${bar(cp.stepSuccessRate, '#378ADD')}<span class="num">${pct(cp.stepSuccessRate)}</span></div>
  <div class="split"><span>理论任务成功率 (p^${cp.avgSteps})</span>${bar(cp.theoretical, '#85B7EB')}<span class="num">${pct(cp.theoretical)}</span></div>
  <div class="split"><span>实测任务成功率</span>${bar(cp.actual, '#378ADD')}<span class="num">${pct(cp.actual)}</span></div>
  <p class="mono">平均 ${cp.avgSteps} 步；实测 95% 置信区间 ${pct(cp.ci.lo)} – ${pct(cp.ci.hi)}；偏差 ${cp.gap >= 0 ? '+' : ''}${(cp.gap * 100).toFixed(1)}pt</p>

  <h2>成本</h2>
  <div class="split"><span>失败任务</span>${bar(k.failedShare, '#E24B4A')}<span class="num">${usd(k.failedUsd)}</span></div>
  <div class="split"><span>成功任务</span>${bar(1 - k.failedShare, '#639922')}<span class="num">${usd(k.okUsd)}</span></div>
  <table>
    <thead><tr><th>模型</th><th class="num">调用</th><th class="num">成本</th><th class="num">成本占比</th><th class="num">调用占比</th></tr></thead>
    <tbody>${modelRows}</tbody>
  </table>

  <h2>任务明细</h2>
  <table>
    <thead><tr><th>结果</th><th>任务</th><th class="num">步数</th><th class="num">成本</th><th class="num">占比</th></tr></thead>
    <tbody>${taskRows}</tbody>
  </table>

  <h2>失败模式</h2>
  <table>
    <thead><tr><th>错误</th><th class="num">次数</th><th class="num">成本</th></tr></thead>
    <tbody>${errRows || '<tr><td colspan="3">没有失败事件</td></tr>'}</tbody>
  </table>
  <table style="margin-top:14px">
    <thead><tr><th>位置</th><th class="num">失败 / 总数</th><th>比例</th><th class="num">失败率</th></tr></thead>
    <tbody>${posRows}</tbody>
  </table>
  <p class="mono">重试 ${a.failures.retryCount} 次，烧掉 ${usd(a.failures.retryUsd)}</p>

  ${p.hasPolicy ? `<h2>权限审计</h2>
  <table>
    <thead><tr><th>类别</th><th>工具</th></tr></thead>
    <tbody>
      <tr><td>授予</td><td>${esc(p.declared.join('、')) || '—'}</td></tr>
      <tr><td>实际使用</td><td>${esc(p.used.join('、')) || '—'}</td></tr>
      <tr><td>从未使用</td><td>${esc(p.unused.join('、')) || '无'}</td></tr>
      ${p.conflicts.length ? `<tr><td>配置矛盾</td><td><span class="fail">${esc(p.conflicts.join('、'))}</span> 同时在 allow 和 deny</td></tr>` : ''}
      <tr><td>越权尝试</td><td>${p.violations} 次（被 policy 拦下）</td></tr>
    </tbody>
  </table>` : ''}

  <h2>结论</h2>
  <ol class="verdict">
    ${verdict.map((v) => `<li>${esc(v)}</li>`).join('') || '<li>没有触发需要提醒的阈值。</li>'}
  </ol>

  <footer>
    由 agent-ledger 生成 · 所有统计基于输入的事件流，未做任何推断补齐 · 样本量小的结论在正文里已标注置信区间
  </footer>
</div>
</body>
</html>`;
}

module.exports = { renderHtml };
