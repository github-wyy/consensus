// 调查员阵容 + 配置解析（consensus skill）
// 配置优先级：仓库 .consensus.yaml > ~/.config/consensus/config.yaml > 内置默认

import fs from 'node:fs';
import path from 'node:path';

const DSH_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const OC_BIN = '/Users/yangyang/.opencode/bin/opencode';
const OMP_BIN = '/Users/yangyang/.bun/bin/omp';

// 简易 YAML 读取（配置面小，避免引入依赖：只支持扁平 map + roster 列表）
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
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return stripQuotes(v);
}
function stripQuotes(v) { return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v; }

// tkehub 凭据：从 opencode auth.json（编排环境内唯一已证来源，#125 实测）
export function tkehubKey() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.local/share/opencode/auth.json'), 'utf8'));
    return auth?.tkehub?.key || null;
  } catch { return null; }
}

// 默认阵容（SKILL.md §阵容；可被配置覆盖）
export function buildRoster(cfg, workspace) {
  const key = tkehubKey();
  const rosterCfg = cfg.roster;
  const seat = (k, defaults) => {
    const over = (rosterCfg || []).find((r) => r && r.key === k) || {};
    return { ...defaults, ...over };
  };
  const seats = [
    seat('oc-spawn', {
      key: 'oc-spawn', tool: 'opencode', channel: 'cli',
      model: 'tke/deepseek-flash-latest',
      get cmd() { return [OC_BIN, 'run', '--model', this.model]; },
    }),
    seat('dsh', {
      key: 'dsh', tool: 'dsh', channel: 'acp',
      model: 'tke/deepseek-pro-latest',
      get cmd() { return [DSH_CLI, '--profile', 'acp']; },
      env: { DSH_PERMISSION_MODE: 'read-only', ...(key ? { TOKENHUB_API_KEY: key } : {}) },
    }),
    seat('omp', {
      key: 'omp', tool: 'omp', channel: 'acp',
      model: null,
      get cmd() { return [OMP_BIN, 'acp', ...(this.model ? ['--model', this.model] : [])]; },
      env: {},
    }),
  ];
  return { seats, key };
}

// ACP 席位构造（run.mjs 用）
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
