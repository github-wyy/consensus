// 席位路由预检（consensus skill）
// 学自 agent-arena 的 participant 预检纪律：进辩论前确认席位真实可用；
// 预检通过的路由运行中失败 → 三分类诊断（diagnose.mjs），永不静默降级（降级必披露 channelFallback）。
//
// 二进制三级解析：env CONSENSUS_BIN_* > config roster[].bin > PATH which 探测。
// 探测语义（最小无害）：
//   ACP 席（dsh/omp）：完整 initialize + session/new + dispose 握手（零 token）
//   CLI 席（oc-spawn）：<bin> --version（零 token）；--deep 追加一次最小 prompt（验证 auth+模型）
// 缓存：<workspace>/.consensus/preflight.json（ok 且二进制仍在 → 命中跳过；否则重探；--force 强制）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeAcpSeat } from './investigators.mjs';
import { runOnce, ocSpawn } from './cli-client.mjs';

export const BIN_ENV = {
  opencode: 'CONSENSUS_BIN_OPENCODE',
  dsh: 'CONSENSUS_BIN_DSH',
  omp: 'CONSENSUS_BIN_OMP',
};

export function defaultWhich(name) {
  const r = spawnSync('which', [name], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout.trim().split('\n')[0] || null) : null;
}

// 三级解析（纯函数：env/whichFn 可注入，供测试）
export function resolveBin(tool, cfg, { env = process.env, whichFn = defaultWhich } = {}) {
  const envVar = BIN_ENV[tool] || `CONSENSUS_BIN_${String(tool).toUpperCase()}`;
  if (env[envVar]) return { bin: env[envVar], source: 'env' };
  const rc = (cfg?.roster || []).find((r) => r && (r.tool === tool || r.key === tool));
  if (rc?.bin) return { bin: rc.bin, source: 'config' };
  const found = whichFn(tool);
  if (found) return { bin: found, source: 'path' };
  return { error: `未找到 ${tool}：请安装并加入 PATH，或设置 ${envVar}，或在配置 roster[].bin 指定`, envVar };
}

export function resolveAllBins(cfg, opts) {
  const out = {};
  for (const tool of Object.keys(BIN_ENV)) out[tool] = resolveBin(tool, cfg, opts);
  return out;
}

// ---- 探测 ----

async function probeCliVersion(seatDef) {
  const r = await runOnce([seatDef.cmd[0], '--version'], null, 15000);
  if (r.stopReason === 'error') return { ok: false, diagnostic: `版本探测超时: ${r.diagnostic || ''}` };
  if (r.code !== 0) return { ok: false, diagnostic: `exit ${r.code}: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}` };
  return { ok: true, probe: 'version' };
}

async function probeAcp(seatDef, { cwd }) {
  const m = await makeAcpSeat(seatDef, { cwd });
  if (!m.ok) return { ok: false, diagnostic: `ACP 握手失败: ${m.diagnostic}` };
  await m.client.dispose();
  return { ok: true, probe: 'acp-handshake' };
}

export async function probeSeat(seatDef, { deep = false, cwd } = {}) {
  const base = {
    seat: seatDef.key,
    resolvedBin: seatDef.bin || seatDef.cmd?.[0] || null,
    model: seatDef.model ?? null,
    probedAt: new Date().toISOString(),
    deep: !!deep,
  };
  if (!seatDef.cmd) return { ...base, ok: false, diagnostic: seatDef.resolveError || '二进制未解析' };
  let r = seatDef.channel === 'acp' ? await probeAcp(seatDef, { cwd }) : await probeCliVersion(seatDef);
  if (r.ok && deep && seatDef.channel === 'cli') {
    // 深探：一次最小 prompt（消耗少量 token，验证 auth+模型）
    const d = await ocSpawn({ bin: seatDef.cmd[0], model: seatDef.model, question: '预检：只回复 OK', cwd, timeoutMs: 90000 });
    if (d.stopReason !== 'completed' || !/ok/i.test(d.output || '')) {
      r = { ok: false, diagnostic: `深探失败: ${d.diagnostic || (d.output || '').slice(0, 200)}` };
    } else {
      r = { ok: true, probe: 'deep-prompt' };
    }
  }
  return { ...base, ...r };
}

// ---- 缓存 ----

export function cachePath(workspace) { return path.join(workspace, '.consensus', 'preflight.json'); }
export function readCache(workspace) {
  try { return JSON.parse(fs.readFileSync(cachePath(workspace), 'utf8')); } catch { return null; }
}
export function writeCache(workspace, map) {
  fs.mkdirSync(path.dirname(cachePath(workspace)), { recursive: true });
  fs.writeFileSync(cachePath(workspace), JSON.stringify(map, null, 2));
}

// 预检全体：缓存命中（ok 且二进制仍在）跳过探测；deep 时 CLI 席强制重探（缓存无深探结果）
export async function preflightSeats(seats, workspace, { deep = false, force = false, cwd } = {}) {
  const cache = force ? {} : (readCache(workspace) || {});
  const out = {};
  for (const s of seats) {
    const c = cache[s.key];
    const hit = c && c.ok && c.resolvedBin && fs.existsSync(c.resolvedBin)
      && !(deep && s.channel === 'cli' && !c.deep);
    if (hit) { out[s.key] = { ...c, cached: true }; continue; }
    out[s.key] = await probeSeat(s, { deep, cwd: cwd || workspace });
  }
  writeCache(workspace, out);
  return out;
}
