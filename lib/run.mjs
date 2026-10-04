#!/usr/bin/env node
// consensus 编排驱动器 — 协调者（opencode 主会话）经 shell 调用
// 用法：
//   node run.mjs preflight [--workspace <dir>] [--deep] [--force]        # 席位预检（零 token；--deep 对 CLI 席加最小 prompt）
//   node run.mjs blind    --workspace <dir> --question-file <file>       # 阶段1：三席并行盲辩（自动预检，缓存感知）
//   node run.mjs round    --run <ts> --prompt-file <file> [--phase R2] [--divergences-file <f>]   # 阶段3：全体亮牌
//   node run.mjs vote     --run <ts> --draft-file <file> [--divergences-file <f>]                # 阶段4：全体表决
//   node run.mjs status   [--workspace <dir>] [--run <ts>]
// 产物目录：<workspace>/.consensus/runs/<ts>/（state.json=checkpoint / events.ndjson / reports/<seat>-<phase>.md）
//
// 架构（v1）：每次调用独立进程，ACP 会话不跨调用存活；多轮续聊 = 协调者上下文重放（SKILL_BODY §2）。
// 工程纪律（学自 agent-arena，设计依据见 README「协议设计依据」）：
//   - 席位预检（永不静默降级，降级必披露 channelFallback）
//   - 逐轮 checkpoint（rounds[] 累积：attempts/diagnosis/通道回落/cost）
//   - 失败三分类（launch-failure / budget-starved / structural，重试只做无损动作）

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, buildRoster, makeAcpSeat } from './investigators.mjs';
import { ocSpawn, dshHeadless, ompOnce } from './cli-client.mjs';
import { resolveAllBins, preflightSeats } from './preflight.mjs';
import { classify, policyFor } from './diagnose.mjs';
import { newRound, appendRound, accumulateCost } from './checkpoint.mjs';

function parseArgs(argv) {
  const cmd = argv[0];
  const a = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) a[k] = argv[++i];
      else a[k] = true;
    }
  }
  return { cmd, a };
}

function runsRoot(workspace) { return path.join(workspace, '.consensus', 'runs'); }
function runDir(workspace, ts) {
  const d = path.join(runsRoot(workspace), ts);
  fs.mkdirSync(path.join(d, 'reports'), { recursive: true });
  return d;
}
function readState(d) { return JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8')); }
function writeState(d, s) { fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(s, null, 2)); }

// 阵容快照（入 checkpoint）：不含 env/凭据/cmd——round/vote 经 buildRoster 现场重建
function rosterSnapshot(seats) {
  return {
    seats: seats.map((s) => ({ key: s.key, tool: s.tool, channel: s.channel, model: s.model ?? null, bin: s.bin })),
  };
}

// 组装阵容（bin 三级解析；binOverride 供 round/vote 复用 checkpoint 里仍存在的 bin）
function buildSeats(cfg, { binOverride = {} } = {}) {
  const bins = resolveAllBins(cfg);
  for (const tool of Object.keys(bins)) if (binOverride[tool]) bins[tool] = binOverride[tool];
  return buildRoster(cfg, { bins }).seats;
}

// ---- 单通道单次调用 ----
async function promptSeatOnce(seatDef, text, channel, timeoutMs, ctx) {
  if (channel === 'cli') {
    if (seatDef.tool === 'opencode') {
      const r = await ocSpawn({ bin: seatDef.bin, model: seatDef.model, question: text, cwd: ctx.cwd, timeoutMs });
      return { ...r, channel: 'cli' };
    }
    if (seatDef.tool === 'dsh') {
      const r = await dshHeadless({ bin: seatDef.bin, question: text, cwd: ctx.cwd, env: seatDef.env, timeoutMs });
      return { ...r, channel: 'cli' };
    }
    if (seatDef.tool === 'omp') {
      const r = await ompOnce({ bin: seatDef.bin, question: text, cwd: ctx.cwd, timeoutMs });
      return { ...r, channel: 'cli' };
    }
    return { stopReason: 'error', output: '', diagnostic: `无 ${seatDef.tool} 的 CLI 回落通道`, channel: 'cli' };
  }
  // ACP 通道：起进程 → 握手 → 新会话 → prompt → dispose（本调用内闭环）
  const m = await makeAcpSeat(seatDef, ctx);
  if (!m.ok) return { stopReason: 'error', output: '', diagnostic: `ACP 启动失败: ${m.diagnostic}`, channel: 'acp', stage: 'launch' };
  try {
    const r = await m.client.prompt(text, timeoutMs);
    return { ...r, usage: { ...m.client.usage }, channel: 'acp' };
  } finally {
    await m.client.dispose();
  }
}

// ---- 单席调用 + 三分类重试闭环（attempts ≤ 2；只做无损动作：重开进程/放宽预算/换通道并披露）----
async function promptSeat(seatDef, text, ctx) {
  const bump = ctx.budgetBumpFactor || 1.5;
  let channel = seatDef.channel;
  let timeoutMs = ctx.timeoutMs;
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = await promptSeatOnce(seatDef, text, channel, timeoutMs, ctx);
    if (last.stopReason === 'completed' && (last.output || '').trim()) {
      return { ...last, attempts: attempt, channelFallback: channel !== seatDef.channel, diagnosis: null };
    }
    if (last.stopReason === 'completed') {
      // 归一化：completed 但输出为空 → structural（不重试）
      last = { ...last, stopReason: 'error', diagnostic: 'completed 但输出为空' };
    }
    const cls = classify(last);
    if (!policyFor(cls).retry || attempt === 2) {
      return { ...last, attempts: attempt, channelFallback: channel !== seatDef.channel, diagnosis: cls };
    }
    const fallback = policyFor(cls).fallbackChannel && seatDef.channel === 'acp' && channel === 'acp';
    console.error(`[consensus] 席 ${seatDef.key} 第 ${attempt} 次尝试失败（${cls}）→ ${policyFor(cls).bumpBudget ? `放宽预算 ×${bump}` : fallback ? '回落 CLI 通道（将披露 channelFallback）' : '同通道'}重试`);
    if (policyFor(cls).bumpBudget) timeoutMs = Math.round(timeoutMs * bump);
    if (fallback) channel = 'cli';
  }
  return { ...last, attempts: 2, channelFallback: channel !== seatDef.channel, diagnosis: classify(last) };
}

async function promptAll(seats, text, ctx) {
  return Promise.all(seats.map(async (seatDef) => {
    const r = await promptSeat(seatDef, text, ctx);
    return { seat: seatDef.key, tool: seatDef.tool, model: seatDef.model, result: r };
  }));
}

// ---- 落盘：reports/ 文件 + checkpoint 轮次追加 + cost 累积 ----
function persistRound(d, state, results, phase, { divergences = [], startedAt, wallMs } = {}) {
  for (const r of results) {
    fs.writeFileSync(
      path.join(d, 'reports', `${r.seat}-${phase}.md`),
      r.result.output || `（失败 stopReason=${r.result.stopReason}: ${r.result.diagnostic || ''}；diagnosis=${r.result.diagnosis || 'n/a'}；attempts=${r.result.attempts || 1}；channel=${r.result.channel || 'n/a'}${r.result.channelFallback ? '（回落）' : ''}）`,
    );
  }
  appendRound(state, newRound(phase, results, { divergences, startedAt, wallMs }));
  accumulateCost(state, results);
  writeState(d, state);
  return {
    run: path.basename(d), phase: `${phase}-done`,
    reports: results.map((r) => ({ seat: r.seat, file: path.join(d, 'reports', `${r.seat}-${phase}.md`) })),
    summary: results.map((r) => ({
      seat: r.seat, stopReason: r.result.stopReason, attempts: r.result.attempts ?? 1,
      channel: r.result.channel ?? null, channelFallback: !!r.result.channelFallback,
      diagnosis: r.result.diagnosis ?? null, chars: (r.result.output || '').length, wallMs: r.result.wallMs ?? null,
    })),
  };
}

function readDivergences(a) {
  if (!a['divergences-file']) return [];
  return fs.readFileSync(a['divergences-file'], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
}

// ---- 命令 ----
async function cmdPreflight(a) {
  const workspace = path.resolve(a.workspace || process.cwd());
  const cfg = loadConfig(workspace);
  const seats = buildSeats(cfg);
  const results = await preflightSeats(seats, workspace, { deep: !!a.deep, force: !!a.force, cwd: workspace });
  const out = {
    workspace,
    cache: path.join(workspace, '.consensus', 'preflight.json'),
    seats: seats.map((s) => ({
      seat: s.key, ok: results[s.key]?.ok ?? false,
      bin: results[s.key]?.resolvedBin ?? s.bin ?? null, source: s.binSource,
      probe: results[s.key]?.probe ?? null, cached: results[s.key]?.cached || false,
      diagnostic: results[s.key]?.diagnostic || s.resolveError || null,
    })),
  };
  console.log(JSON.stringify(out, null, 2));
  const okCount = out.seats.filter((s) => s.ok).length;
  if (okCount === 0) { console.error('[consensus] 预检：全部席位不可用（见上方诊断）'); process.exit(1); }
  if (okCount < out.seats.length) console.error(`[consensus] 预检：${out.seats.length - okCount} 席不可用，将按部分参与降级运行`);
}

async function cmdBlind(a) {
  const workspace = path.resolve(a.workspace || process.cwd());
  const question = fs.readFileSync(a['question-file'], 'utf8');
  const cfg = loadConfig(workspace);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const d = runDir(workspace, ts);
  const seats = buildSeats(cfg);

  // 席位预检（缓存感知；失败席位缺席，如实标注——永不静默降级）
  const pf = await preflightSeats(seats, workspace, { cwd: workspace });
  const active = seats.filter((s) => pf[s.key]?.ok);
  const absent = seats.filter((s) => !pf[s.key]?.ok);
  if (active.length === 0) {
    console.error('[consensus] 预检：全部席位不可用，中止。诊断：');
    for (const s of seats) console.error(`  - ${s.key}: ${pf[s.key]?.diagnostic || s.resolveError || '未知'}`);
    process.exit(1);
  }
  if (absent.length > 0) console.error(`[consensus] 预检：${absent.map((s) => s.key).join(', ')} 缺席（部分参与降级）`);

  const taskBook = `${question}

【报告要求】严格按以下六字段输出，≤600 词：
1. 假设集：按可能性降序排列
2. 根因判断：一句话
3. 关键证据：每条必须带 file:line（或命令输出摘要）
4. 置信度：百分比数字
5. 修复方向草案：一到三句
6. 开放疑虑：没有就写"无"`;

  const state = {
    ts, workspace, question: question.slice(0, 500),
    roster: { ...rosterSnapshot(seats), preflight: pf },
    activeSeats: null, // 盲辩完成后按产出填写
    rounds: [], openDisagreements: [],
    cost: { calls: 0, tokens: null, wallMs: 0 },
  };
  writeState(d, state);

  const eventLog = fs.createWriteStream(path.join(d, 'events.ndjson'), { flags: 'a' });
  const onEvent = (ev) => eventLog.write(JSON.stringify(ev) + '\n');

  console.error(`[consensus] run=${ts} ${active.length} 席并行盲辩（workspace=${workspace}）…`);
  const t0 = Date.now();
  const results = await promptAll(active, taskBook, {
    cwd: workspace, timeoutMs: cfg.timeoutPerCallMs || 600000,
    budgetBumpFactor: cfg.budgetBumpFactor || 1.5, onEvent,
  });
  eventLog.end();
  const wallMs = Date.now() - t0;
  state.cost.wallMs += wallMs;
  state.activeSeats = results.filter((r) => r.result.stopReason === 'completed' && (r.result.output || '').trim()).map((r) => r.seat);

  const out = persistRound(d, state, results, 'R1-blind', { startedAt: new Date(t0).toISOString(), wallMs });
  out.preflight = seats.map((s) => ({ seat: s.key, ok: pf[s.key]?.ok ?? false, bin: pf[s.key]?.resolvedBin ?? null, cached: pf[s.key]?.cached || false, diagnostic: pf[s.key]?.diagnostic || s.resolveError || null }));
  out.activeSeats = state.activeSeats;
  out.cost = state.cost;
  console.log(JSON.stringify(out, null, 2));
  if (state.activeSeats.length === 0) { console.error('[consensus] 盲辩：全部席位失败（见 summary 诊断）'); process.exit(1); }
}

async function cmdRoundLike(a, phase) {
  const workspace = path.resolve(a.workspace || process.cwd());
  const d = runDir(workspace, a.run);
  const state = readState(d);
  const cfg = loadConfig(workspace);
  const text = fs.readFileSync(a['prompt-file'] || a['draft-file'], 'utf8');
  const divergences = readDivergences(a);

  // 重建阵容：bin 取自 checkpoint 快照（失效则重新三级解析）；env/凭据现场组装
  const binOverride = {};
  for (const s of state.roster?.seats || []) {
    if (s.bin && fs.existsSync(s.bin)) binOverride[s.tool] = { bin: s.bin, source: 'checkpoint' };
  }
  const seats = buildSeats(cfg, { binOverride });
  const activeKeys = new Set(state.activeSeats || (state.roster?.seats || []).map((s) => s.key));
  const active = seats.filter((s) => activeKeys.has(s.key) && s.cmd);
  if (active.length === 0) { console.error('[consensus] 无可用席位（checkpoint activeSeats 为空或 bin 均失效）'); process.exit(1); }

  const eventLog = fs.createWriteStream(path.join(d, 'events.ndjson'), { flags: 'a' });
  const onEvent = (ev) => eventLog.write(JSON.stringify(ev) + '\n');
  console.error(`[consensus] run=${a.run} ${active.length} 席 ${phase}${divergences.length ? `（分歧点 ${divergences.length} 条入 checkpoint）` : ''}…`);
  const t0 = Date.now();
  const results = await promptAll(active, text, {
    cwd: state.workspace, timeoutMs: cfg.timeoutPerCallMs || 600000,
    budgetBumpFactor: cfg.budgetBumpFactor || 1.5, onEvent,
  });
  eventLog.end();
  const wallMs = Date.now() - t0;
  state.cost = state.cost || { calls: 0, tokens: null, wallMs: 0 };
  state.cost.wallMs += wallMs;
  console.log(JSON.stringify(persistRound(d, state, results, phase, { divergences, startedAt: new Date(t0).toISOString(), wallMs }), null, 2));
}

async function cmdStatus(a) {
  const workspace = path.resolve(a.workspace || process.cwd());
  if (a.run) {
    console.log(JSON.stringify(readState(runDir(workspace, a.run)), null, 2));
  } else {
    const root = runsRoot(workspace);
    const runs = fs.existsSync(root) ? fs.readdirSync(root).sort().reverse() : [];
    console.log(JSON.stringify({ runs }, null, 2));
  }
}

const { cmd, a } = parseArgs(process.argv.slice(2));
try {
  if (cmd === 'preflight') await cmdPreflight(a);
  else if (cmd === 'blind') await cmdBlind(a);
  else if (cmd === 'round') await cmdRoundLike(a, a.phase || 'R2');
  else if (cmd === 'vote') await cmdRoundLike(a, 'vote');
  else if (cmd === 'status') await cmdStatus(a);
  else {
    console.error('用法: run.mjs <preflight|blind|round|vote|status> [--workspace d] [--run ts] [--question-file f] [--prompt-file f] [--draft-file f] [--divergences-file f] [--deep] [--force]');
    process.exit(2);
  }
} catch (e) {
  console.error(`[consensus] 失败: ${e.stack || e}`);
  process.exit(1);
}
