'use strict';

const fs = require('fs');
const { parseFile } = require('./parse.js');
const { analyze } = require('./analyze.js');

const PROTOCOL_FALLBACK = '2025-06-18';
const SERVER_INFO = { name: 'agent-ledger', version: '1.0.0' };

function pct(x, d) {
  return (x * 100).toFixed(d === undefined ? 1 : d) + '%';
}

function usd(x) {
  return '$' + Number(x).toFixed(4);
}

function load(file, policyPath) {
  const parsed = parseFile(file);
  let policy = null;
  if (policyPath) {
    try { policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')); } catch (_) { policy = null; }
  }
  return { parsed, result: analyze(parsed.events, policy) };
}

const TOOLS = [
  {
    name: 'ledger_summary',
    description: '读取 agent 运行事件流，返回任务成功率、单步成功率、总成本、失败消耗占比。用于在开始一轮工作前了解基线。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'JSONL 事件文件路径' },
        policy: { type: 'string', description: '权限声明 JSON 路径，可选' }
      },
      required: ['file']
    }
  },
  {
    name: 'ledger_task',
    description: '查看单个任务（run）的逐步明细：每步类型、是否成功、耗时、成本、失败原因。任务名支持子串匹配。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'JSONL 事件文件路径' },
        task: { type: 'string', description: '任务名或 run id，支持子串匹配' }
      },
      required: ['file', 'task']
    }
  },
  {
    name: 'ledger_risks',
    description: '返回当前运行数据的风险清单：成本集中度、失败成本占比、过度授权、policy 配置矛盾。适合在执行高风险操作前自查。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'JSONL 事件文件路径' },
        policy: { type: 'string', description: '权限声明 JSON 路径，可选' }
      },
      required: ['file']
    }
  }
];

function text(s) {
  return { content: [{ type: 'text', text: s }], isError: false };
}

function fail(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function callTool(name, args, ctx) {
  const file = args.file || ctx.defaultFile;
  if (!file) return fail('没有指定 file，也没有在启动时通过参数给默认文件。');
  if (!fs.existsSync(file)) return fail(`文件不存在：${file}`);

  let loaded;
  try {
    loaded = load(file, args.policy || ctx.policy);
  } catch (e) {
    return fail(`读取失败：${e.message}`);
  }

  const a = loaded.result;

  if (name === 'ledger_summary') {
    const t = a.totals;
    const k = a.cost;
    return text([
      `# 运行账本概览`,
      ``,
      `- 任务：${t.runs} 个（成功 ${t.successRuns} / 失败 ${t.failedRuns}），共 ${t.steps} 步`,
      `- 任务成功率：${pct(t.successRate)}（95% 区间 ${pct(a.compound.ci.lo)} – ${pct(a.compound.ci.hi)}）`,
      `- 单步成功率：${pct(t.stepSuccessRate)}`,
      `- 总成本：${usd(k.total)}，平均每任务 ${usd(k.perRunAvg)}`,
      `- 失败任务吃掉 ${pct(k.failedShare)} 成本，有效成本是名义成本的 ${k.effectiveMultiple} 倍`,
      ``,
      `成本最高的模型：${a.cost.byModel.map((m) => `${m.model} ${usd(m.usd)}（${pct(m.share)}）`).join('、') || '无'}`
    ].join('\n'));
  }

  if (name === 'ledger_task') {
    const q = String(args.task || '').toLowerCase();
    const runs = a.runs.filter((r) => r.run.toLowerCase().indexOf(q) !== -1 || r.task.toLowerCase().indexOf(q) !== -1);
    if (!runs.length) return fail(`没有匹配「${args.task}」的任务。可用任务：${a.runs.map((r) => r.task).join('、')}`);

    const blocks = runs.slice(0, 3).map((r) => {
      const head = `## ${r.task}（${r.run}）　${r.success ? '成功' : '失败'}　${r.stepCount} 步　${usd(r.usd)}`;
      const rows = r.steps.map((s) => {
        const what = s.type === 'model' ? s.model : s.type === 'tool' ? s.tool : s.type;
        const flag = s.ok ? 'ok' : `FAIL${s.error ? ' · ' + s.error : ''}`;
        return `| ${s.step} | ${what} | ${flag} | ${s.retried ? '有重试' : ''} | ${s.ms}ms |`;
      });
      return [head, '', '| 步 | 动作 | 结果 | 备注 | 耗时 |', '|---|---|---|---|---|'].concat(rows).join('\n');
    });

    return text(blocks.join('\n\n'));
  }

  if (name === 'ledger_risks') {
    const items = [];
    const k = a.cost;
    const p = a.policy;

    if (k.failedShare > 0.3) {
      items.push(`- **失败成本高**：${pct(k.failedShare)} 的成本由最终失败的任务消耗，有效成本 ×${k.effectiveMultiple}。`);
    }
    if (k.pareto.share > 0.5) {
      items.push(`- **成本集中**：最贵的 ${k.pareto.topN} 个任务占 ${pct(k.pareto.share)} 成本，先优化这几个。`);
    }
    if (k.byModel.length && k.byModel[0].share > 0.6) {
      items.push(`- **单模型依赖**：${k.byModel[0].model} 占 ${pct(k.byModel[0].share)} 成本、${pct(k.byModel[0].callShare)} 调用。`);
    }
    if (p.hasPolicy && p.unused.length) {
      items.push(`- **过度授权**：${p.unused.join('、')} 授予了但从未使用，是可被 prompt injection 利用的入口。`);
    }
    if (p.hasPolicy && p.conflicts.length) {
      items.push(`- **配置矛盾**：${p.conflicts.join('、')} 同时在 allow 与 deny 里，行为不确定。`);
    }
    if (p.hasPolicy && p.violations) {
      items.push(`- **越权尝试**：${p.violations} 次被 policy 拦下的工具调用，检查是否有任务在试探权限边界。`);
    }
    if (a.compound.ci.hi - a.compound.ci.lo > 0.4) {
      items.push(`- **样本不足**：${a.totals.runs} 个任务的置信区间跨度 ${pct(a.compound.ci.hi - a.compound.ci.lo)}，结论不可外推。`);
    }

    if (!items.length) return text('没有触发风险阈值。');
    return text(['# 风险清单', ''].concat(items).join('\n'));
  }

  return fail(`未知工具：${name}`);
}

function start(ctx) {
  const started = { defaultFile: ctx.defaultFile || '', policy: ctx.policy || '' };
  let buffer = '';

  function send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  function replyError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function handle(msg) {
    const hasId = msg.id !== undefined && msg.id !== null;

    if (msg.method === 'initialize') {
      const requested = msg.params && msg.params.protocolVersion;
      reply(msg.id, {
        protocolVersion: requested || PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      });
      return;
    }

    if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
      return;
    }

    if (msg.method === 'ping') {
      if (hasId) reply(msg.id, {});
      return;
    }

    if (msg.method === 'tools/list') {
      reply(msg.id, { tools: TOOLS });
      return;
    }

    if (msg.method === 'tools/call') {
      const params = msg.params || {};
      const name = params.name;
      const args = params.arguments || {};
      try {
        reply(msg.id, callTool(name, args, started));
      } catch (e) {
        reply(msg.id, fail(`工具执行异常：${e.message}`));
      }
      return;
    }

    if (msg.method && msg.method.indexOf('notifications/') === 0) return;

    if (hasId) replyError(msg.id, -32601, `未实现的方法：${msg.method}`);
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        process.stderr.write('无法解析的 JSON-RPC 行，已忽略\n');
        continue;
      }
      try {
        handle(msg);
      } catch (e) {
        process.stderr.write('处理消息出错：' + e.message + '\n');
      }
    }
  });

  process.stdin.on('end', () => process.exit(0));

  process.stderr.write(`agent-ledger MCP server 已启动（stdio，${TOOLS.length} 个工具）\n`);
}

module.exports = { start, TOOLS };
