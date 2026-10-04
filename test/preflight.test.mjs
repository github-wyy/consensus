// preflight.mjs 单测：三级解析优先级、缓存命中/失效、CLI 探测（用 node 自身当真实二进制）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBin, probeSeat, preflightSeats, readCache, writeCache } from '../lib/preflight.mjs';

const nodeBin = process.execPath; // 真实可执行文件，--version 可跑

test('resolveBin 优先级：env > config > which', () => {
  const cfg = { roster: [{ key: 'oc-spawn', tool: 'opencode', bin: '/cfg/oc' }] };
  const r = resolveBin('opencode', cfg, { env: { CONSENSUS_BIN_OPENCODE: '/env/oc' }, whichFn: () => '/which/oc' });
  assert.deepEqual(r, { bin: '/env/oc', source: 'env' });
});

test('resolveBin：config 覆盖 which', () => {
  const cfg = { roster: [{ key: 'dsh', tool: 'dsh', bin: '/cfg/dsh' }] };
  assert.deepEqual(resolveBin('dsh', cfg, { env: {}, whichFn: () => '/which/dsh' }), { bin: '/cfg/dsh', source: 'config' });
});

test('resolveBin：which 兜底', () => {
  assert.deepEqual(resolveBin('omp', { roster: [] }, { env: {}, whichFn: () => '/which/omp' }), { bin: '/which/omp', source: 'path' });
});

test('resolveBin：全部未命中 → 可操作错误（含 env 变量名提示）', () => {
  const r = resolveBin('dsh', { roster: [] }, { env: {}, whichFn: () => null });
  assert.ok(!r.bin && r.error);
  assert.ok(r.error.includes('CONSENSUS_BIN_DSH'), '错误信息应提示对应 env 变量');
});

test('resolveBin：key 与 tool 均可匹配 config', () => {
  const byKey = resolveBin('dsh', { roster: [{ key: 'dsh', bin: '/by-key/dsh' }] }, { env: {}, whichFn: () => null });
  assert.deepEqual(byKey, { bin: '/by-key/dsh', source: 'config' });
  const byTool = resolveBin('opencode', { roster: [{ key: 'oc-spawn', tool: 'opencode', bin: '/by-tool/oc' }] }, { env: {}, whichFn: () => null });
  assert.deepEqual(byTool, { bin: '/by-tool/oc', source: 'config' });
});

test('probeSeat：CLI 席 --version 探测真实二进制成功', async () => {
  const seat = { key: 'oc-spawn', channel: 'cli', bin: nodeBin, model: null, cmd: [nodeBin, 'run'] };
  const r = await probeSeat(seat, {});
  assert.equal(r.ok, true);
  assert.equal(r.probe, 'version');
  assert.equal(r.resolvedBin, nodeBin);
});

test('probeSeat：bin 未解析 → 失败并保留诊断', async () => {
  const r = await probeSeat({ key: 'dsh', channel: 'acp', cmd: null, bin: null, resolveError: '未找到 dsh：请安装…' }, {});
  assert.equal(r.ok, false);
  assert.ok(r.diagnostic.includes('未找到'));
});

test('preflightSeats：缓存命中（ok 且二进制仍在）跳过探测', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consensus-pf-'));
  const seat = { key: 'oc-spawn', channel: 'cli', bin: nodeBin, model: null, cmd: [nodeBin, 'run'] };
  writeCache(dir, { 'oc-spawn': { ok: true, resolvedBin: nodeBin, probe: 'version', probedAt: '2026-01-01T00:00:00Z' } });
  const out = await preflightSeats([seat], dir, {});
  assert.equal(out['oc-spawn'].cached, true);
  assert.equal(out['oc-spawn'].probe, 'version');
});

test('preflightSeats：缓存失效（resolvedBin 不存在）→ 重探并刷新', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consensus-pf-'));
  const seat = { key: 'oc-spawn', channel: 'cli', bin: nodeBin, model: null, cmd: [nodeBin, 'run'] };
  writeCache(dir, { 'oc-spawn': { ok: true, resolvedBin: '/nonexistent/oc', probedAt: '2026-01-01T00:00:00Z' } });
  const out = await preflightSeats([seat], dir, {});
  assert.ok(!out['oc-spawn'].cached);
  assert.equal(out['oc-spawn'].ok, true);
  assert.equal(out['oc-spawn'].resolvedBin, nodeBin);
  const persisted = readCache(dir);
  assert.equal(persisted['oc-spawn'].resolvedBin, nodeBin);
});

test('preflightSeats：force 强制重探', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consensus-pf-'));
  const seat = { key: 'oc-spawn', channel: 'cli', bin: nodeBin, model: null, cmd: [nodeBin, 'run'] };
  writeCache(dir, { 'oc-spawn': { ok: true, resolvedBin: nodeBin, probe: 'version', probedAt: '2026-01-01T00:00:00Z' } });
  const out = await preflightSeats([seat], dir, { force: true });
  assert.ok(!out['oc-spawn'].cached);
  assert.equal(out['oc-spawn'].ok, true);
});
