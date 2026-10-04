#!/usr/bin/env node
// consensus 编排驱动器 — 协调者（opencode 主会话）经 shell 调用
// 用法：
//   node run.mjs blind  --workspace <dir> --question-file <file>       # 阶段1：三席并行盲辩
//   node run.mjs round  --run <ts> --prompt-file <file>               # 阶段3：全体亮牌（prompt 文件含各席增量材料？否——见下）
//   node run.mjs vote   --run <ts> --draft-file <file>                # 阶段4：全体表决
//   node run.mjs status [--run <ts>]                                   # 查看运行
// 产物目录：<workspace>/.consensus/runs/<ts>/  (state.json / events.ndjson / reports/<seat>-<phase>.md)
//
// 架构说明（v1）：本脚本每次调用独立进程，ACP 会话不跨调用存活。
// 多轮续聊采用「上下文重放」：协调者构造 prompt 时必须包含该席自己的上一轮结论
// （从 reports/<seat>-<phase>.md 读取），加上他方新结论与分歧点——见 SKILL_BODY §2。
// 这是 run 契约的降级路径（新会话+摘要重放），鲁棒且状态简单；服务端会话 resume 留作 v2 优化。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, buildRoster, makeAcpSeat } from './investigators.mjs';
import { ocSpawn, dshHeadless, ompOnce } from './cli-client.mjs';

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
function writeState(d, s) {
  const { eventLog, ...serializable } = s;
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(serializable, null, 2));
}

// ---- 单席调用：盲辩/亮牌/表决共用；每调用一次，用完即回收 ----
async function promptSeat(seatDef, text, phase, { cwd, timeoutMs, onEvent }) {
  // CLI 席（opencode run 子进程，天然一次性）
  if (seatDef.channel === 'cli') {
    return ocSpawn({ model: seatDef.model, question: text, timeoutMs });
  }
  // ACP 席：起进程 → 握手 → 新会话 → prompt → dispose（本调用内闭环）
  const m = await makeAcpSeat(seatDef, { cwd, onEvent });
  if (!m.ok) {
    // 降级链：ACP 启动失败 → CLI 回落 → 缺席（SKILL_BODY §5）
    const fb = seatDef.tool === 'dsh'
      ? await dshHeadless({ question: text, env: seatDef.env, timeoutMs })
      : seatDef.tool === 'omp'
        ? await ompOnce({ question: text, timeoutMs })
        : { stopReason: 'error', output: '', diagnostic: '无可回落通道' };
    if (fb.stopReason === 'error') fb.diagnostic = (fb.diagnostic || '') + `（ACP 启动失败: ${m.diagnostic}）`;
    return fb;
  }
  try {
    return await m.client.prompt(text, timeoutMs);
  } finally {
    await m.client.dispose();
  }
}

async function promptAll(seats, text, phase, ctx) {
  return Promise.all(seats.map(async (seatDef) => {
    const r = await promptSeat(seatDef, text, phase, ctx);
    return { seat: seatDef.key, tool: seatDef.tool, model: seatDef.model, phase, result: r };
  }));
}

function persistRound(d, results, phase) {
  for (const r of results) {
    fs.writeFileSync(
      path.join(d, 'reports', `${r.seat}-${phase}.md`),
      r.result.output || `（失败 stopReason=${r.result.stopReason}: ${r.result.diagnostic || ''}）`,
    );
  }
  return {
    run: path.basename(d), phase: `${phase}-done`,
    reports: results.map((r) => ({ seat: r.seat, file: path.join(d, 'reports', `${r.seat}-${phase}.md`) })),
    summary: results.map((r) => ({
      seat: r.seat, stopReason: r.result.stopReason, chars: (r.result.output || '').length, wallMs: r.result.wallMs,
    })),
  };
}

// ---- 命令 ----
async function cmdBlind(a) {
  const workspace = path.resolve(a.workspace || process.cwd());
  const question = fs.readFileSync(a['question-file'], 'utf8');
  const cfg = loadConfig(workspace);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const d = runDir(workspace, ts);
  const { seats } = buildRoster(cfg, workspace);

  const taskBook = `${question}

【报告要求】严格按以下六字段输出，≤600 词：
1. 假设集：按可能性降序排列
2. 根因判断：一句话
3. 关键证据：每条必须带 file:line（或命令输出摘要）
4. 置信度：百分比数字
5. 修复方向草案：一到三句
6. 开放疑虑：没有就写"无"`;

  const eventLog = fs.createWriteStream(path.join(d, 'events.ndjson'), { flags: 'a' });
  const onEvent = (ev) => eventLog.write(JSON.stringify(ev) + '\n');

  writeState(d, { ts, workspace, question: question.slice(0, 500), roster: { seats }, phase: 'blind' });
  console.error(`[consensus] run=${ts} 三席并行盲辩（workspace=${workspace}）…`);
  const t0 = Date.now();
  const results = await promptAll(seats, taskBook, 'R1-blind', {
    cwd: workspace, timeoutMs: cfg.timeoutPerCallMs || 600000, onEvent,
  });
  eventLog.end();
  writeState(d, { ts, workspace, question: question.slice(0, 500), roster: { seats }, phase: 'blind-done', wallMs: Date.now() - t0 });
  console.log(JSON.stringify(persistRound(d, results, 'R1-blind'), null, 2));
}

async function cmdRoundLike(a, phase) {
  const workspace = path.resolve(a.workspace || process.cwd());
  const d = runDir(workspace, a.run);
  const state = readState(d);
  const cfg = loadConfig(workspace);
  const text = fs.readFileSync(a['prompt-file'] || a['draft-file'], 'utf8');
  const eventLog = fs.createWriteStream(path.join(d, 'events.ndjson'), { flags: 'a' });
  const onEvent = (ev) => eventLog.write(JSON.stringify(ev) + '\n');
  console.error(`[consensus] run=${a.run} 全体 ${phase}…`);
  const results = await promptAll(state.roster.seats, text, phase, {
    cwd: state.workspace, timeoutMs: cfg.timeoutPerCallMs || 600000, onEvent,
  });
  eventLog.end();
  writeState(d, { ...state, phase: `${phase}-done` });
  console.log(JSON.stringify(persistRound(d, results, phase), null, 2));
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
  if (cmd === 'blind') await cmdBlind(a);
  else if (cmd === 'round') await cmdRoundLike(a, a.phase || 'R2');
  else if (cmd === 'vote') await cmdRoundLike(a, 'vote');
  else if (cmd === 'status') await cmdStatus(a);
  else {
    console.error('用法: run.mjs <blind|round|vote|status> [--workspace d] [--run ts] [--question-file f] [--prompt-file f] [--draft-file f]');
    process.exit(2);
  }
} catch (e) {
  console.error(`[consensus] 失败: ${e.stack || e}`);
  process.exit(1);
}
