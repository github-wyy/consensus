// CLI 一次性调用通道（consensus skill）
// - oc-spawn 席：opencode run 子进程（干净上下文；model 省略随 opencode 默认）
// - ACP 回落通道：dsh --profile headless / omp -p --mode=json
// 二进制路径由调用方传入（preflight 三级解析结果）；本模块不硬编码任何路径。
// run 契约：settle {stopReason, output, diagnostic, wallMs, usage?}，永不 reject。

import { spawn } from 'node:child_process';

export function runOnce(cmd, input, timeoutMs, opts = {}) {
  const { env = {}, cwd } = opts;
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    let out = '', err = '';
    let done = false;
    const finish = (r) => {
      if (done) return; done = true;
      clearTimeout(timer); resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ stopReason: 'error', output: '', diagnostic: `超时 ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish({ code, stdout: out, stderr: err });
    });
    child.stdin.on('error', () => {});
    if (input != null) { try { child.stdin.write(input); } catch {} }
    try { child.stdin.end(); } catch {}
  });
}

// opencode run：stdout 为最终文本（非 --json 模式）
export async function ocSpawn({ bin, model, question, cwd, timeoutMs = 600000 }) {
  const t0 = Date.now();
  const r = await runOnce([bin, 'run', ...(model ? ['--model', model] : [])], question, timeoutMs, { cwd });
  if (r.stopReason === 'error') return { ...r, seat: 'oc-spawn' };
  if (r.code !== 0) return { stopReason: 'error', output: '', diagnostic: `exit ${r.code}: ${r.stderr.slice(0, 300)}`, seat: 'oc-spawn', wallMs: Date.now() - t0 };
  return { stopReason: 'completed', output: r.stdout.trim(), seat: 'oc-spawn', wallMs: Date.now() - t0 };
}

// dsh headless 回落（--json NDJSON，final 事件为结果）
export async function dshHeadless({ bin, question, cwd, env, timeoutMs = 600000 }) {
  const t0 = Date.now();
  const r = await runOnce([bin, '--profile', 'headless', '--json'], question, timeoutMs, { env, cwd });
  if (r.stopReason === 'error') return { ...r, seat: 'dsh' };
  if (r.code !== 0) return { stopReason: 'error', output: '', diagnostic: `exit ${r.code}: ${r.stderr.slice(0, 300)}`, seat: 'dsh', wallMs: Date.now() - t0 };
  let final = '', usage = {};
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'final') final = ev.text || '';
      if (ev.type === 'status' && ev.usage) usage = ev.usage;
    } catch {}
  }
  if (!final) return { stopReason: 'error', output: '', diagnostic: '无 final 事件', seat: 'dsh', wallMs: Date.now() - t0 };
  return { stopReason: 'completed', output: final, seat: 'dsh', wallMs: Date.now() - t0, usage };
}

// omp 回落（-p --mode=json，agent_end.messages 末条 assistant text）
export async function ompOnce({ bin, question, cwd, timeoutMs = 600000 }) {
  const t0 = Date.now();
  const r = await runOnce([bin, '-p', '--mode=json', '--no-session'], question, timeoutMs, { env: { OMP_NO_HOME_SWITCH: '1' }, cwd });
  if (r.stopReason === 'error') return { ...r, seat: 'omp' };
  let output = '', usage = {};
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'agent_end' && Array.isArray(ev.messages)) {
        const last = [...ev.messages].reverse().find((m) => m.role === 'assistant');
        const textBlock = (last?.content || []).find((c) => c.type === 'text');
        if (textBlock) output = textBlock.text;
        if (last?.usage) usage = { input: last.usage.input, output: last.usage.output };
      }
    } catch {}
  }
  if (!output) return { stopReason: 'error', output: '', diagnostic: `exit ${r.code}: 无 agent_end text`, seat: 'omp', wallMs: Date.now() - t0 };
  return { stopReason: 'completed', output, seat: 'omp', wallMs: Date.now() - t0, usage };
}
