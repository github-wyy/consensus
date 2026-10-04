// ACP (Agent Client Protocol) stdio nd-JSON JSON-RPC 2.0 客户端
// consensus skill — #123 骨架
// 契约：任何失败 settle 成 {stopReason, output, diagnostic}，永不 reject；dispose 幂等。
// stopReason 映射：end_turn→completed / max_tokens→max-tokens / refusal→refusal / cancelled→aborted

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const STOP_MAP = { end_turn: 'completed', max_tokens: 'max-tokens', refusal: 'refusal', cancelled: 'aborted' };

// 权限策略引擎（SKILL_BODY §0：只读 + 可执行命令）
// 按 options[].kind 选（不能按 optionId——两家命名不一致，#128 实测）
const WRITE_CMD_RE = /(^|[^>])>{1,2}\s*|(^|\s)(tee|cp|mv|rm|touch|mkdir|chmod|chown|dd|truncate|shred)\s|sed\s+-\S*i|(^|\s)(git)\s+(commit|push|checkout|reset|rebase|apply)\b/;
export function decidePermission(params) {
  const options = params?.options || [];
  const tc = params?.toolCall || {};
  const pick = (want) => options.find((o) => (o.kind || '').includes(want));
  const answer = (o) => (o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } });

  if (tc.kind === 'read') return answer(pick('allow'));
  if (tc.kind === 'edit') return answer(pick('reject'));
  if (tc.kind === 'execute') {
    const cmd = String(tc.rawInput?.command || '');
    return answer(WRITE_CMD_RE.test(cmd) ? pick('reject') : pick('allow'));
  }
  // 未知 kind（含 dsh 的 "other"）：按 rawInput 保守判定
  const raw = JSON.stringify(tc.rawInput || {}).toLowerCase();
  if (raw.includes('command')) {
    const cmd = String(tc.rawInput?.command || '');
    return answer(WRITE_CMD_RE.test(cmd) ? pick('reject') : pick('allow'));
  }
  if (raw.includes('file_path') || raw.includes('files')) return answer(pick('reject'));
  return answer(pick('reject')); // 默认拒绝
}

export class AcpClient {
  constructor({ key, cmd, env = {}, label }) {
    this.key = key;
    this.label = label || key;
    this.cmd = cmd;
    this.env = env;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.dead = false;
    this.sessionId = null;
    this.usage = { input: 0, output: 0, calls: 0 };
    this._chain = Promise.resolve(); // per-key 串行锁（同一会话不并发 prompt）
    this.onEvent = null;             // (ev) => void 事件流回调（审计）
    this.disposed = false;
  }

  _log(ev) { if (this.onEvent) this.onEvent({ ts: new Date().toISOString(), seat: this.key, ...ev }); }

  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { this._log({ ev: 'stdout_non_json', line: line.slice(0, 500) }); return; }
    if (msg.id !== undefined && msg.method !== undefined) {
      // 服务器请求（session/request_permission 等）
      this._handleServerRequest(msg);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve({ result: msg.result ?? null, error: msg.error ?? null });
      }
    } else if (msg.method) {
      if (msg.method === 'session/update') this._onUpdate(msg.params || {});
    }
  }

  _onUpdate(params) {
    const u = params.update || {};
    const su = u.sessionUpdate;
    if (su === 'agent_message_chunk') {
      this._lastChunk = (this._lastChunk || '') + ((u.content || {}).text || '');
    } else if (su === 'usage_update') {
      if (u.input != null) this.usage.input = u.input;
      if (u.output != null) this.usage.output = u.output;
    } else if (su === 'tool_call' || su === 'tool_call_update') {
      this._log({ ev: 'tool', status: u.status, title: u.title, kind: u.kind });
    }
  }

  async _handleServerRequest(msg) {
    let result = { outcome: { outcome: 'cancelled' } };
    if (msg.method === 'session/request_permission') {
      // 不应答超时防御（10s 自动 reject）
      result = await Promise.race([
        Promise.resolve(decidePermission(msg.params)),
        new Promise((r) => setTimeout(() => r({ outcome: { outcome: 'cancelled' } }), 10000)),
      ]);
    }
    this._sendRaw({ jsonrpc: '2.0', id: msg.id, result });
  }

  _sendRaw(obj) {
    if (this.dead) return;
    try { this.child.stdin.write(JSON.stringify(obj) + '\n'); } catch {}
  }

  _request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ timeout: true, method }); }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this._sendRaw({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  async start() {
    if (this.dead || this.child) return this;
    this.child = spawn(this.cmd[0], this.cmd.slice(1), {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('exit', (code, signal) => { this.dead = true; this._log({ ev: 'exit', code, signal }); });
    this.child.stdin.on('error', () => {});
    readline.createInterface({ input: this.child.stdout }).on('line', (l) => this._onLine(l));
    this.child.stderr.on('data', (d) => this._log({ ev: 'stderr', line: String(d).slice(0, 300) }));

    const init = await this._request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
    }, 20000);
    if (init.error || init.timeout) {
      return this._fail('error', `initialize 失败: ${JSON.stringify(init.error || 'timeout')}`);
    }
    this._sendRaw({ jsonrpc: '2.0', method: 'initialized' });
    return this;
  }

  async newSession(cwd) {
    const r = await this._request('session/new', { cwd, mcpServers: [] }, 20000);
    if (r.error || r.timeout || !r.result?.sessionId) {
      return this._fail('error', `session/new 失败: ${JSON.stringify(r.error || r.result || 'timeout')}`);
    }
    this.sessionId = r.result.sessionId;
    return { ok: true, sessionId: this.sessionId };
  }

  // 一次性 prompt：settle 成 run 契约结果，永不 reject
  prompt(text, timeoutMs = 600000) {
    this._chain = this._chain.then(() => this._promptSerial(text, timeoutMs));
    return this._chain;
  }

  async _promptSerial(text, timeoutMs) {
    if (this.dead) return this._fail('error', '进程已退出');
    this._lastChunk = '';
    const t0 = Date.now();
    const r = await this._request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, timeoutMs);
    this.usage.calls += 1;
    const wallMs = Date.now() - t0;
    if (r.timeout) return this._fail('error', `prompt 超时 ${timeoutMs}ms`);
    if (r.error) return this._fail('error', `prompt 错误: ${r.error.message || JSON.stringify(r.error)}`);
    const stopReason = STOP_MAP[r.result?.stopReason] || 'error';
    return {
      stopReason,
      output: this._lastChunk || '',
      diagnostic: stopReason === 'completed' ? undefined : `stopReason=${r.result?.stopReason}`,
      wallMs, seat: this.key,
    };
  }

  // omp 支持；opencode -32601（#128 实测），失败静默
  async cancel() {
    if (!this.sessionId) return;
    await this._request('session/cancel', { sessionId: this.sessionId }, 5000);
  }

  _fail(stopReason, diagnostic) {
    this._log({ ev: 'fail', stopReason, diagnostic });
    return { stopReason, output: '', diagnostic, seat: this.key };
  }

  // dispose 幂等：cancel（尽力）→ stdin close → kill
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { await this.cancel(); } catch {}
    if (this.child && !this.dead) {
      try { this.child.stdin.end(); } catch {}
      await new Promise((r) => setTimeout(r, 300));
      if (!this.dead) { try { this.child.kill('SIGTERM'); } catch {} }
      setTimeout(() => { if (!this.dead) { try { this.child.kill('SIGKILL'); } catch {} } }, 2000);
    }
  }
}
