'use strict';

function wilson(successes, n, z) {
  const zz = z || 1.96;
  if (!n) return { lo: 0, hi: 0, p: 0 };
  const p = successes / n;
  const denom = 1 + (zz * zz) / n;
  const center = (p + (zz * zz) / (2 * n)) / denom;
  const margin = (zz * Math.sqrt((p * (1 - p)) / n + (zz * zz) / (4 * n * n))) / denom;
  return {
    p,
    lo: Math.max(0, center - margin),
    hi: Math.min(1, center + margin)
  };
}

function round(x, d) {
  const f = Math.pow(10, d === undefined ? 2 : d);
  return Math.round(x * f) / f;
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function buildRuns(events) {
  const runs = new Map();

  for (const e of events) {
    if (!runs.has(e.run)) {
      runs.set(e.run, {
        run: e.run,
        task: e.task,
        repo: e.repo,
        events: [],
        steps: new Map()
      });
    }
    const r = runs.get(e.run);
    r.events.push(e);
    if (!r.steps.has(e.step)) r.steps.set(e.step, []);
    r.steps.get(e.step).push(e);
  }

  const out = [];

  for (const r of runs.values()) {
    const stepList = [];
    let usd = 0;
    let ms = 0;
    let retries = 0;

    const stepNos = Array.from(r.steps.keys()).sort((a, b) => a - b);

    for (const no of stepNos) {
      const evs = r.steps.get(no);
      const final = evs[evs.length - 1];
      const retried = evs.length > 1;
      if (retried) retries += evs.filter((x) => !x.ok).length;
      stepList.push({
        step: no,
        type: final.type,
        ok: final.ok,
        retried,
        attempts: evs.length,
        error: final.error,
        model: final.model,
        tool: final.tool,
        usd: evs.reduce((s, x) => s + x.usd, 0),
        ms: evs.reduce((s, x) => s + x.ms, 0)
      });
    }

    for (const e of r.events) {
      usd += e.usd;
      ms += e.ms;
    }

    let started = 0;
    let ended = 0;
    for (const e of r.events) {
      const t = Date.parse(e.ts);
      if (!Number.isNaN(t)) {
        if (!started || t < started) started = t;
        if (t > ended) ended = t;
      }
    }

    const failedSteps = stepList.filter((s) => !s.ok);
    const success = failedSteps.length === 0;

    out.push({
      run: r.run,
      task: r.task,
      repo: r.repo,
      success,
      stepCount: stepList.length,
      steps: stepList,
      failedSteps: failedSteps.map((s) => s.step),
      retries,
      usd,
      wallMs: ended > started ? ended - started : ms,
      firstTs: started ? new Date(started).toISOString() : '',
      models: Array.from(new Set(r.events.filter((e) => e.type === 'model').map((e) => e.model))),
      tools: Array.from(new Set(r.events.filter((e) => e.type === 'tool').map((e) => e.tool)))
    });
  }

  out.sort((a, b) => (a.firstTs < b.firstTs ? -1 : 1));
  return out;
}

function analyze(events, policy) {
  const runs = buildRuns(events);

  const stepsAll = runs.reduce((s, r) => s + r.stepCount, 0);
  const stepsOk = runs.reduce((s, r) => s + r.steps.filter((x) => x.ok).length, 0);
  const successRuns = runs.filter((r) => r.success).length;
  const totalUsd = runs.reduce((s, r) => s + r.usd, 0);
  const totalMs = runs.reduce((s, r) => s + r.wallMs, 0);

  const modelCalls = events.filter((e) => e.type === 'model');
  const toolCalls = events.filter((e) => e.type === 'tool');

  const stepRate = stepsAll ? stepsOk / stepsAll : 0;
  const avgSteps = runs.length ? stepsAll / runs.length : 0;
  const compound = {
    stepSuccessRate: round(stepRate, 4),
    avgSteps: round(avgSteps, 2),
    theoretical: runs.length ? round(Math.pow(stepRate, avgSteps), 4) : 0,
    actual: runs.length ? round(successRuns / runs.length, 4) : 0,
    ci: wilson(successRuns, runs.length)
  };
  compound.gap = round(compound.actual - compound.theoretical, 4);

  const byModel = [];
  const modelMap = new Map();
  for (const e of modelCalls) {
    if (!modelMap.has(e.model)) modelMap.set(e.model, { model: e.model, calls: 0, usd: 0, tokensIn: 0, tokensOut: 0, errors: 0 });
    const m = modelMap.get(e.model);
    m.calls++;
    m.usd += e.usd;
    m.tokensIn += e.tokensIn;
    m.tokensOut += e.tokensOut;
    if (!e.ok) m.errors++;
  }
  for (const m of modelMap.values()) {
    m.usd = round(m.usd, 4);
    m.share = totalUsd ? round(m.usd / totalUsd, 4) : 0;
    m.callShare = modelCalls.length ? round(m.calls / modelCalls.length, 4) : 0;
    byModel.push(m);
  }
  byModel.sort((a, b) => b.usd - a.usd);

  const byTool = [];
  const toolMap = new Map();
  for (const e of toolCalls) {
    if (!toolMap.has(e.tool)) toolMap.set(e.tool, { tool: e.tool, calls: 0, errors: 0, ms: 0 });
    const t = toolMap.get(e.tool);
    t.calls++;
    t.ms += e.ms;
    if (!e.ok) t.errors++;
  }
  for (const t of toolMap.values()) byTool.push(t);
  byTool.sort((a, b) => b.calls - a.calls);

  const failedRuns = runs.filter((r) => !r.success);
  const failedUsd = failedRuns.reduce((s, r) => s + r.usd, 0);
  const okUsd = totalUsd - failedUsd;

  const sortedRuns = runs.slice().sort((a, b) => b.usd - a.usd);
  const paretoN = Math.max(1, Math.ceil(sortedRuns.length * 0.2));
  const paretoUsd = sortedRuns.slice(0, paretoN).reduce((s, r) => s + r.usd, 0);

  const cost = {
    total: round(totalUsd, 4),
    perRunAvg: runs.length ? round(totalUsd / runs.length, 4) : 0,
    failedRuns: failedRuns.length,
    failedUsd: round(failedUsd, 4),
    failedShare: totalUsd ? round(failedUsd / totalUsd, 4) : 0,
    okUsd: round(okUsd, 4),
    nominalPerSuccess: successRuns ? round(totalUsd / successRuns, 4) : 0,
    effectivePerSuccess: successRuns ? round(totalUsd / successRuns, 4) : 0,
    effectiveMultiple: successRuns && okUsd ? round(totalUsd / okUsd, 2) : 1,
    pareto: {
      topN: paretoN,
      topUsd: round(paretoUsd, 4),
      share: totalUsd ? round(paretoUsd / totalUsd, 4) : 0
    },
    byModel,
    byTask: sortedRuns.map((r) => ({
      task: r.task,
      run: r.run,
      usd: round(r.usd, 4),
      success: r.success,
      steps: r.stepCount,
      share: totalUsd ? round(r.usd / totalUsd, 4) : 0
    }))
  };

  const retryEvents = events.filter((e) => e.retry > 0);
  const failedEvents = events.filter((e) => !e.ok);

  const errMap = new Map();
  for (const e of failedEvents) {
    const key = e.error || '(未记录原因)';
    if (!errMap.has(key)) errMap.set(key, { error: key, count: 0, usd: 0 });
    const x = errMap.get(key);
    x.count++;
    x.usd += e.usd;
  }

  const posBuckets = [
    { label: '开头 1/3', hit: 0, total: 0 },
    { label: '中间 1/3', hit: 0, total: 0 },
    { label: '结尾 1/3', hit: 0, total: 0 }
  ];
  for (const r of runs) {
    r.steps.forEach((s, idx) => {
      const pos = r.stepCount > 1 ? idx / (r.stepCount - 1) : 0;
      const b = pos < 1 / 3 ? 0 : pos < 2 / 3 ? 1 : 2;
      posBuckets[b].total++;
      if (!s.ok) posBuckets[b].hit++;
    });
  }

  const failures = {
    failedEvents: failedEvents.length,
    failedByError: Array.from(errMap.values())
      .map((x) => ({ ...x, usd: round(x.usd, 4) }))
      .sort((a, b) => b.count - a.count),
    retryCount: retryEvents.length,
    retryUsd: round(retryEvents.reduce((s, e) => s + e.usd, 0), 4),
    byPosition: posBuckets.map((b) => ({
      label: b.label,
      total: b.total,
      failed: b.hit,
      rate: b.total ? round(b.hit / b.total, 4) : 0
    }))
  };

  const declared = policy && Array.isArray(policy.allow) ? policy.allow.slice() : [];
  const denied = policy && Array.isArray(policy.deny) ? policy.deny.slice() : [];
  const used = Array.from(new Set(toolCalls.filter((e) => e.ok).map((e) => e.tool)));
  const usedAll = Array.from(new Set(toolCalls.map((e) => e.tool)));

  const violations = toolCalls.filter((e) => !e.ok && /policy_denied/.test(e.error));
  const unused = declared.filter((d) => used.indexOf(d) === -1);
  const undeclared = usedAll.filter((u) => declared.indexOf(u) === -1);
  const conflicts = declared.filter((d) => denied.indexOf(d) !== -1);

  const policyReport = {
    hasPolicy: !!policy,
    declared,
    denied,
    used,
    usedAll,
    unused,
    undeclared,
    conflicts,
    violations: violations.length,
    violationDetail: violations.map((v) => ({
      run: v.run,
      task: v.task,
      step: v.step,
      tool: v.tool,
      error: v.error
    })),
    overGrantRate: declared.length ? round(unused.length / declared.length, 4) : 0
  };

  return {
    totals: {
      runs: runs.length,
      events: events.length,
      steps: stepsAll,
      stepsOk,
      stepSuccessRate: round(stepRate, 4),
      successRuns,
      failedRuns: failedRuns.length,
      successRate: runs.length ? round(successRuns / runs.length, 4) : 0,
      usd: round(totalUsd, 4),
      wallMs: totalMs,
      modelCalls: modelCalls.length,
      toolCalls: toolCalls.length,
      tokensIn: modelCalls.reduce((s, e) => s + e.tokensIn, 0),
      tokensOut: modelCalls.reduce((s, e) => s + e.tokensOut, 0)
    },
    compound,
    cost,
    failures,
    policy: policyReport,
    runs
  };
}

module.exports = { analyze, buildRuns, wilson, round };
