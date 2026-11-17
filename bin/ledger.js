#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseFile } = require('../lib/parse.js');
const { analyze, round } = require('../lib/analyze.js');

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[36m'
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function c(code, s) {
  return useColor ? code + s + C.reset : String(s);
}

function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const wide = cp >= 0x1100 && (
      cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    );
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s, w, align) {
  const str = String(s);
  const diff = w - strWidth(str);
  if (diff <= 0) return str;
  if (align === 'right') return ' '.repeat(diff) + str;
  return str + ' '.repeat(diff);
}

function pct(x, d) {
  return (x * 100).toFixed(d === undefined ? 1 : d) + '%';
}

function usd(x) {
  return '$' + Number(x).toFixed(4);
}

function bar(ratio, width) {
  const w = width || 20;
  const filled = Math.max(0, Math.min(w, Math.round(ratio * w)));
  return '█'.repeat(filled) + '·'.repeat(w - filled);
}

function section(title) {
  const line = '─'.repeat(Math.max(4, 64 - strWidth(title)));
  return '\n' + c(C.bold, title) + ' ' + c(C.dim, line) + '\n';
}

function kv(label, value, note) {
  return '  ' + pad(label, 22) + pad(value, 18) + (note ? c(C.dim, note) : '');
}

function renderOverview(a) {
  const t = a.totals;
  const lines = [];
  lines.push(section('概览'));
  lines.push(kv('任务数', String(t.runs), `${t.events} 条事件 / ${t.steps} 步`));
  lines.push(kv('任务成功率', pct(t.successRate), `${t.successRuns} 成功 / ${t.failedRuns} 失败`));
  lines.push(kv('单步成功率', pct(t.stepSuccessRate), `${t.stepsOk} / ${t.steps} 步`));
  lines.push(kv('总成本', usd(t.usd), `${t.modelCalls} 次模型调用 / ${t.toolCalls} 次工具调用`));
  lines.push(kv('总耗时', (t.wallMs / 60000).toFixed(1) + ' 分钟'));
  lines.push(kv('tokens', `${t.tokensIn} 入 / ${t.tokensOut} 出`));
  return lines.join('\n');
}

function renderCompound(a) {
  const cp = a.compound;
  const lines = [];
  lines.push(section('复合成功率：单步能不能推出任务'));
  lines.push(kv('平均步数', String(cp.avgSteps)));
  lines.push(kv('单步成功率', pct(cp.stepSuccessRate)));
  lines.push(kv('理论任务成功率', pct(cp.theoretical), '假设每步独立：p^k'));
  lines.push(kv('实测任务成功率', pct(cp.actual), `95% 置信区间 ${pct(cp.ci.lo)} – ${pct(cp.ci.hi)}`));

  const gap = cp.actual - cp.theoretical;
  const gapTxt = (gap >= 0 ? '+' : '') + (gap * 100).toFixed(1) + 'pt';
  lines.push(kv('偏差', gapTxt, gap >= 0 ? '实测优于独立假设，重试在起作用' : '实测差于独立假设，错误会聚集'));

  lines.push('');
  if (cp.ci.hi - cp.ci.lo > 0.4) {
    lines.push('  ' + c(C.yellow, '注意') + '：置信区间宽度 ' + pct(cp.ci.hi - cp.ci.lo) + '，样本量不足以支撑结论。');
    lines.push('  ' + c(C.dim, `  ${a.totals.runs} 个任务算出来的成功率，误差范围比结论本身还大。`));
  } else {
    lines.push('  ' + c(C.dim, '  区间较窄，这个成功率可以当基线用。'));
  }
  return lines.join('\n');
}

function renderCost(a) {
  const k = a.cost;
  const lines = [];
  lines.push(section('成本：钱花在哪'));
  lines.push(kv('总成本', usd(k.total), `平均每任务 ${usd(k.perRunAvg)}`));

  lines.push(kv('失败任务消耗', usd(k.failedUsd), pct(k.failedShare) + ' 的钱花在最终没成的任务上'));
  lines.push(kv('名义单任务成本', usd(k.nominalPerSuccess), '总成本 / 成功任务数'));
  lines.push(kv('有效成本倍数', 'x' + k.effectiveMultiple, '把失败成本摊进去之后'));
  lines.push('');
  lines.push('  ' + pad('按失败/成功拆分', 22) + bar(k.failedShare) + '  ' + pct(k.failedShare) + ' 失败');
  lines.push('');
  lines.push('  ' + c(C.bold, '模型成本分布'));
  const mw = Math.max(14, ...k.byModel.map((m) => strWidth(m.model) + 2));
  lines.push('  ' + pad('模型', mw) + pad('调用', 8, 'right') + pad('成本', 12, 'right') + pad('占比', 10, 'right') + '  调用占比');
  for (const m of k.byModel) {
    lines.push('  ' + pad(m.model, mw) + pad(m.calls, 8, 'right') + pad(usd(m.usd), 12, 'right') +
      pad(pct(m.share), 10, 'right') + '  ' + pct(m.callShare));
  }
  lines.push('');
  lines.push('  ' + c(C.bold, `最贵的 ${k.pareto.topN} 个任务`) +
    c(C.dim, `  占 ${pct(k.pareto.share)} 总成本（${usd(k.pareto.topUsd)}）`));
  for (const t of k.byTask.slice(0, k.pareto.topN)) {
    const mark = t.success ? c(C.green, 'OK ') : c(C.red, 'FAIL');
    lines.push('  ' + mark + '  ' + pad(t.task, 20) + pad(usd(t.usd), 12, 'right') + pad(t.steps + ' 步', 8, 'right'));
  }
  return lines.join('\n');
}

function renderFailures(a) {
  const f = a.failures;
  const lines = [];
  lines.push(section('失败长什么样'));

  if (!f.failedByError.length) {
    lines.push('  没有失败事件。');
    return lines.join('\n');
  }

  const ew = Math.max(18, ...f.failedByError.map((x) => strWidth(x.error) + 2));
  lines.push('  ' + pad('错误', Math.min(ew, 46)) + pad('次数', 8, 'right') + pad('成本', 12, 'right'));
  for (const x of f.failedByError) {
    const msg = x.error.length > 42 ? x.error.slice(0, 41) + '…' : x.error;
    lines.push('  ' + pad(msg, Math.min(ew, 46)) + pad(x.count, 8, 'right') + pad(usd(x.usd), 12, 'right'));
  }

  lines.push('');
  lines.push('  ' + c(C.bold, '失败在任务里的位置'));
  for (const p of f.byPosition) {
    if (!p.total) continue;
    lines.push('  ' + pad(p.label, 12) + bar(p.rate, 16) + '  ' + pct(p.rate) + c(C.dim, `  (${p.failed}/${p.total} 步)`));
  }

  lines.push('');
  lines.push(kv('重试次数', String(f.retryCount), `重试烧掉 ${usd(f.retryUsd)}`));
  return lines.join('\n');
}

function renderPolicy(a) {
  const p = a.policy;
  const lines = [];
  lines.push(section('权限：给了多少，用了多少'));

  if (!p.hasPolicy) {
    lines.push('  ' + c(C.dim, '没有提供 policy 文件，跳过这一节。加 --policy policy.json 就能看。'));
    return lines.join('\n');
  }

  lines.push(kv('授予工具', String(p.declared.length), p.declared.join(', ') || '(空)'));
  lines.push(kv('实际使用', String(p.used.length), p.used.join(', ') || '(空)'));
  lines.push(kv('从未使用', String(p.unused.length), p.unused.join(', ') || '(无)'));
  lines.push(kv('过度授权率', pct(p.overGrantRate), '授予了但一次没用过的比例'));

  if (p.conflicts.length) {
    lines.push('');
    lines.push('  ' + c(C.red, '配置矛盾') + '：' + p.conflicts.join(', ') +
      c(C.dim, ' 同时在 allow 和 deny 里，实际行为取决于实现，不应保留'));
  }

  if (p.violations) {
    lines.push('');
    lines.push('  ' + c(C.yellow, `越权尝试 ${p.violations} 次`) + c(C.dim, '（被 policy 拦下）'));
    for (const v of p.violationDetail) {
      lines.push('  ' + pad(v.task, 20) + pad('step ' + v.step, 10) + c(C.dim, v.tool + ' → ' + v.error));
    }
  }

  return lines.join('\n');
}

function renderVerdict(a) {
  const lines = [];
  const k = a.cost;
  const p = a.policy;
  const cp = a.compound;

  lines.push(section('结论'));
  const items = [];

  if (k.failedShare > 0.3) {
    items.push(
      c(C.red, '钱有 ' + pct(k.failedShare) + ' 花在没成的任务上') +
      `，有效成本是名义成本的 ${k.effectiveMultiple} 倍。` +
      '先压失败率，比压 token 单价更划算。'
    );
  } else {
    items.push('失败成本占比 ' + pct(k.failedShare) + '，在可接受范围内。');
  }

  if (cp.ci.hi - cp.ci.lo > 0.4) {
    items.push('样本只有 ' + a.totals.runs + ' 个任务，成功率区间跨度 ' + pct(cp.ci.hi - cp.ci.lo) + '，' +
      '现在的数字只能当趋势看，别拿去做承诺。');
  }

  if (p.hasPolicy && p.unused.length) {
    items.push('有 ' + p.unused.length + ' 个授予的工具从未被调用（' + p.unused.join('、') + '）。' +
      '这些就是 prompt injection 能用的现成入口，建议按任务收窄。');
  }

  if (p.hasPolicy && p.conflicts.length) {
    items.push('policy 里 ' + p.conflicts.join('、') + ' 同时出现在 allow 和 deny，先修配置再谈审计。');
  }

  const topModel = k.byModel[0];
  if (topModel && topModel.share > 0.6) {
    items.push(topModel.model + ' 一个模型吃掉 ' + pct(topModel.share) + ' 成本，但调用次数只占 ' +
      pct(topModel.callShare) + '。这里是最直接的降本位置。');
  }

  items.forEach((s, i) => {
    lines.push('  ' + (i + 1) + '. ' + s);
  });

  return lines.join('\n');
}

function printReport(a, meta) {
  const out = [];
  out.push(c(C.dim, `agent-ledger  ·  ${meta.file}  ·  ${meta.events} 条事件  ·  ${meta.runs} 个任务`));
  if (meta.problems.length) {
    out.push(c(C.yellow, `  跳过 ${meta.problems.length} 行无法解析的输入`));
    for (const p of meta.problems.slice(0, 3)) {
      out.push(c(C.dim, `    第 ${p.line} 行：${p.error}`));
    }
  }
  out.push(renderOverview(a));
  out.push(renderCompound(a));
  out.push(renderCost(a));
  out.push(renderFailures(a));
  out.push(renderPolicy(a));
  out.push(renderVerdict(a));
  out.push('\n');
  process.stdout.write(out.join('\n') + '\n');
}

function help() {
  console.log(`agent-ledger —— agent 运行账本

用法
  node bin/ledger.js <runs.jsonl> [选项]

选项
  --policy <file>   权限声明，用来算过度授权与越权尝试
  --json            输出完整分析结果
  --html <file>     生成单文件 HTML 报告
  --mcp             以 MCP server 方式运行（JSON-RPC over stdio）
  --no-color        关闭颜色
  -h, --help        显示帮助

输入格式
  每行一个 JSON 事件，必填 ts / run / step / type / ok：

  {"ts":"2026-11-17T09:12:03Z","run":"r1","task":"add-pagination","step":1,
   "type":"model","model":"gpt-6.1-terra","in":11240,"out":780,"usd":0.0151,"ms":3120,"ok":true}

  {"ts":"...","run":"r1","step":2,"type":"tool","tool":"read_file","ms":8,"ok":true}

  type: model | tool | plan | note
  可选字段：task repo in out usd ms retry error

示例
  node bin/ledger.js data/sample-runs.jsonl --policy policy.json
  node bin/ledger.js data/sample-runs.jsonl --html report.html`);
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { file: '', policy: '', json: false, html: '', mcp: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--policy') opts.policy = argv[++i] || '';
    else if (a === '--json') opts.json = true;
    else if (a === '--html') opts.html = argv[++i] || '';
    else if (a === '--mcp') opts.mcp = true;
    else if (a === '--no-color') process.env.NO_COLOR = '1';
    else if (a === '-h' || a === '--help') { help(); return 0; }
    else opts.file = a;
  }

  if (opts.mcp) {
    require('../lib/mcp.js').start({ defaultFile: opts.file, policy: opts.policy });
    return null;
  }

  if (!opts.file) {
    help();
    return 2;
  }

  const parsed = parseFile(opts.file);
  if (!parsed.events.length) {
    process.stderr.write('没有可分析的事件。检查文件格式是否每行一个 JSON。\n');
    return 2;
  }

  let policy = null;
  if (opts.policy) {
    try {
      policy = JSON.parse(fs.readFileSync(opts.policy, 'utf8'));
    } catch (e) {
      process.stderr.write(`policy 读取失败：${e.message}\n`);
      return 2;
    }
  }

  const result = analyze(parsed.events, policy);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      file: path.resolve(opts.file),
      problems: parsed.problems,
      analysis: result
    }, null, 2) + '\n');
    return 0;
  }

  printReport(result, {
    file: path.relative(process.cwd(), opts.file) || opts.file,
    events: parsed.events.length,
    runs: result.totals.runs,
    problems: parsed.problems
  });

  if (opts.html) {
    const { renderHtml } = require('../lib/html.js');
    fs.writeFileSync(opts.html, renderHtml(result, {
      file: opts.file,
      policy: policy ? policy.name : ''
    }), 'utf8');
    process.stdout.write('HTML 报告已写入 ' + opts.html + '\n');
  }

  return 0;
}

// MCP 模式下 main 返回 null，进程交给 stdio 监听维持，不能在这里退出
const exitCode = main();
if (exitCode !== null) process.exit(exitCode);
