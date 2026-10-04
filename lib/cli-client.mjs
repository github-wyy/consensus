// CLI 一次性调用通道（consensus skill）
// - 槽位 1（oc-spawn）：opencode run 子进程，干净上下文
// - 回落：dsh --profile headless / omp -p --mode=json
// 同样遵守 run 契约：settle {stopReason, output, diagnostic}，永不 reject

import { spawn } from 'node:child_process';

function runOnce(cmd, input, timeoutMs, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    let chunks = [];
    let done = false;
    const finish = (r) => {
      if (done) return; done = true;
      clearTimeout(timer); resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ stopReason: 'error', output: '', diagnostic: `超时 ${timeoutMs}ms`, seat: null });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish({ code, stdout: out, stderr: err, chunks });
    });
    child.stdin.on('error', () => {});
    if (input != null) { try { child.stdin.write(input); } catch {} }
    try { child.stdin.end(); } catch {}
    child._collectChunk = (s) => chunks.push(s);
  });
}

// opencode run：stdout 为最终文本（非 --json 模式）
export async function ocSpawn({ model, question, cwd, timeoutMs = 600000 }) {
  const t0 = Date.now();
  const r = await runOnce(['/Users/yangyang/.opencode/bin/opencode', 'run', '--model', model], question, timeoutMs);
  const wallMs = Date.now() - t0;
  if (r.stopReason === 'error') return { ...r, seat: 'oc-spawn' };
  if (r.code !== 0) return { stopReason: 'error', output: '', diagnostic: `exit ${r.code}: ${r.stderr.slice(0, 300)}`, seat: 'oc-spawn', wallMs };
  return { stopReason: 'completed', output: r.stdout.trim(), seat: 'oc-spawn', wallMs };
}

// dsh headless 回落（--json NDJSON，final 事件为结果）
export async function dshHeadless({ question, cwd, env, timeoutMs = 600000 }) {
  const DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
  const t0 = Date.now();
  const r = await runOnce([DSH, '--profile', 'headless', '--json'], question, timeoutMs, env);
  const wallMs = Date.now() - t0;
  if (r.stopReason === 'error') return { ...r, seat: 'dsh' };
  if (r.code !== 0) return { stopReason: 'error', output: '', diagnostic: `exit ${r.code}: ${r.stderr.slice(0, 300)}`, seat: 'dsh', wallMs };
  let final = '', usage = {};
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'final') final = ev.text || '';
      if (ev.type === 'status' && ev.usage) usage = ev.usage;
    } catch {}
  }
  if (!final) return { stopReason: 'error', output: '', diagnostic: '无 final 事件', seat: 'dsh', wallMs };
  return { stopReason: 'completed', output: final, seat: 'dsh', wallMs, usage };
}

// omp 回落（-p --mode=json，agent_end.messages 末条 assistant text）
export async function ompOnce({ question, cwd, timeoutMs = 600000 }) {
  const t0 = Date.now();
  const r = await runOnce(['/Users/yangyang/.bun/bin/omp', '-p', '--mode=json', '--no-session'], question, timeoutMs, { OMP_NO_HOME_SWITCH: '1' });
  const wallMs = Date.now() - t0;
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
  if (!output) return { stopReason: 'error', output: '', diagnostic: `exit ${r.code}: 无 agent_end text`, seat: 'omp', wallMs };
  return { stopReason: 'completed', output, seat: 'omp', wallMs, usage };
}
