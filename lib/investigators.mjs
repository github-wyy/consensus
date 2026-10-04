// 调查员阵容 + 配置解析（consensus skill）
// 配置优先级：仓库 .consensus.yaml > ~/.config/consensus/config.yaml > 内置默认
// 二进制三级解析在 preflight.mjs（env > config > which）；本模块按传入 bins 组装 cmd。
// 安全：席位 env 由代码固定组装（DSH 只读 + 凭据运行时读取），不接受配置注入 env。

import fs from 'node:fs';
import path from 'node:path';

// 简易 YAML 读取（配置面小，避免引入依赖：只支持扁平 map + roster 列表 + 数组值）
export function loadConfig(workspace) {
  const sources = [];
  if (workspace) sources.push(path.join(workspace, '.consensus.yaml'));
  sources.push(path.join(process.env.HOME, '.config', 'consensus', 'config.yaml'));
  let merged = {};
  for (const s of sources) {
    if (!fs.existsSync(s)) continue;
    merged = { ...merged, ...parseSimpleYaml(fs.readFileSync(s, 'utf8')) };
  }
  return merged;
}

export function parseSimpleYaml(text) {
  // 最小实现：roster 列表项（- key: ... 嵌套）+ 顶层 key: value
  const out = {};
  let curList = null, curItem = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    if (/^roster:\s*$/.test(line.trim())) { out.roster = []; curList = 'roster'; continue; }
    if (/^(\w[\w-]*):\s*(.*)$/.test(line) && !line.startsWith(' ') && !line.startsWith('-')) {
      const m = line.trim().match(/^(\w[\w-]*):\s*(.*)$/);
      curList = null; curItem = null;
      out[m[1]] = coerce(m[2]);
      continue;
    }
    if (curList && line.trim().startsWith('- ')) {
      curItem = {};
      out[curList].push(curItem);
      const rest = line.trim().slice(2);
      if (/^(\w[\w-]*):\s*(.*)$/.test(rest)) { const m = rest.match(/^(\w[\w-]*):\s*(.*)$/); curItem[m[1]] = coerce(m[2]); }
      continue;
    }
    if (curItem && /^\s+(\w[\w-]*):\s*(.*)$/.test(line)) {
      const m = line.match(/^\s+(\w[\w-]*):\s*(.*)$/);
      curItem[m[1]] = coerce(m[2]);
    }
  }
  return out;
}

function coerce(v) {
  v = (v || '').trim();
  if (v.startsWith('[')) { try { return JSON.parse(v); } catch { /* 落回字符串 */ } }
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return stripQuotes(v);
}
function stripQuotes(v) { return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v; }

// tkehub 凭据：从 opencode auth.json（编排环境内唯一已证来源，#125 实测）；无则跳过
export function tkehubKey() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.local/share/opencode/auth.json'), 'utf8'));
    return auth?.tkehub?.key || null;
  } catch { return null; }
}

// 默认阵容（SKILL.md §阵容；可被配置覆盖；bins 来自 preflight 三级解析）
// bin 不走 roster 覆盖（三级解析已含 config 层）；env 不接受配置注入（安全）
export function buildRoster(cfg, { bins = {} } = {}) {
  const key = tkehubKey();
  const rosterCfg = cfg.roster;
  const res = (tool) => bins[tool] || {};
  const mkSeat = (k, base, buildCmd) => {
    const over = (rosterCfg || []).find((r) => r && r.key === k) || {};
    const { bin: _bin, env: _env, ...rest } = over;
    const s = { ...base, ...rest };
    s.cmd = s.bin ? buildCmd(s) : null;
    return s;
  };
  const seats = [
    mkSeat('oc-spawn', {
      key: 'oc-spawn', tool: 'opencode', channel: 'cli',
      model: null, // null = 随 opencode 默认（配置可钉死）
      env: {},
      bin: res('opencode').bin || null, resolveError: res('opencode').error || null, binSource: res('opencode').source || null,
    }, (s) => [s.bin, 'run', ...(s.model ? ['--model', s.model] : [])]),
    mkSeat('dsh', {
      key: 'dsh', tool: 'dsh', channel: 'acp',
      model: null, // 标注用；实际模型随 dsh profile
      env: { DSH_PERMISSION_MODE: 'read-only', ...(key ? { TOKENHUB_API_KEY: key } : {}) },
      bin: res('dsh').bin || null, resolveError: res('dsh').error || null, binSource: res('dsh').source || null,
    }, (s) => [s.bin, '--profile', 'acp']),
    mkSeat('omp', {
      key: 'omp', tool: 'omp', channel: 'acp',
      model: null, // null = 随 omp 默认
      env: {},
      bin: res('omp').bin || null, resolveError: res('omp').error || null, binSource: res('omp').source || null,
    }, (s) => [s.bin, 'acp', ...(Array.isArray(s.args) ? s.args : []), ...(s.model ? ['--model', s.model] : [])]),
  ];
  return { seats, key };
}

// ACP 席位构造（run.mjs / preflight.mjs 用）
export async function makeAcpSeat(seatDef, { cwd, onEvent }) {
  const { AcpClient } = await import('./acp-client.mjs');
  const c = new AcpClient({ key: seatDef.key, cmd: seatDef.cmd, env: seatDef.env, label: seatDef.tool });
  c.onEvent = onEvent;
  await c.start();
  if (c.dead) return { ok: false, diagnostic: '进程启动失败' };
  const s = await c.newSession(cwd);
  if (!s.ok) return { ok: false, diagnostic: s.diagnostic || 'session/new 失败' };
  return { ok: true, client: c };
}
