'use strict';

const fs = require('fs');

const REQUIRED = ['ts', 'run', 'step', 'type', 'ok'];
const KINDS = new Set(['model', 'tool', 'plan', 'note']);

function parseLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (e) {
    return { error: 'JSON 解析失败: ' + e.message };
  }
  for (const k of REQUIRED) {
    if (obj[k] === undefined || obj[k] === null) return { error: `缺少字段 ${k}` };
  }
  if (!KINDS.has(obj.type)) return { error: `未知类型 ${obj.type}` };
  if (typeof obj.step !== 'number') return { error: 'step 必须是数字' };
  if (obj.type === 'model' && !obj.model) return { error: 'model 事件缺少 model 字段' };
  if (obj.type === 'tool' && !obj.tool) return { error: 'tool 事件缺少 tool 字段' };

  return {
    event: {
      ts: String(obj.ts),
      run: String(obj.run),
      task: obj.task ? String(obj.task) : String(obj.run),
      repo: obj.repo || '',
      step: obj.step,
      type: obj.type,
      model: obj.model || '',
      tool: obj.tool || '',
      tokensIn: Number(obj.in || 0),
      tokensOut: Number(obj.out || 0),
      usd: Number(obj.usd || 0),
      ms: Number(obj.ms || 0),
      ok: obj.ok === true,
      retry: Number(obj.retry || 0),
      error: obj.error || ''
    }
  };
}

function parseText(text) {
  const events = [];
  const problems = [];
  const lines = text.split(/\r?\n/);
  let seen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    seen++;
    const res = parseLine(line);
    if (res.error) {
      problems.push({ line: i + 1, error: res.error, raw: line.slice(0, 120) });
      continue;
    }
    events.push(res.event);
  }

  events.sort((a, b) => {
    if (a.ts === b.ts) return a.step - b.step;
    return a.ts < b.ts ? -1 : 1;
  });

  return { events, problems, linesSeen: seen };
}

function parseFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return parseText(text);
}

module.exports = { parseText, parseFile, parseLine };
