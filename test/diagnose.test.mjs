// diagnose.mjs 单测：三分类全分支 + 策略表
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, policyFor, RETRY_POLICY } from '../lib/diagnose.mjs';

test('launch-failure：ACP 握手失败（stage=launch）', () => {
  assert.equal(classify({ stage: 'launch', stopReason: 'error', diagnostic: 'ACP 启动失败: initialize 超时' }), 'launch-failure');
});

test('launch-failure：CLI exit≠0', () => {
  assert.equal(classify({ stopReason: 'error', diagnostic: 'exit 2: auth required' }), 'launch-failure');
});

test('launch-failure：ENOENT', () => {
  assert.equal(classify({ stopReason: 'error', diagnostic: 'ENOENT: no such file' }), 'launch-failure');
});

test('budget-starved：prompt 超时（ACP 诊断）', () => {
  assert.equal(classify({ stopReason: 'error', diagnostic: 'prompt 超时 600000ms' }), 'budget-starved');
});

test('budget-starved：CLI 超时诊断', () => {
  assert.equal(classify({ stopReason: 'error', diagnostic: '超时 600000ms' }), 'budget-starved');
});

test('budget-starved：stopReason=max-tokens', () => {
  assert.equal(classify({ stopReason: 'max-tokens' }), 'budget-starved');
});

test('structural：refusal 不重试', () => {
  const cls = classify({ stopReason: 'refusal' });
  assert.equal(cls, 'structural');
  assert.equal(policyFor(cls).retry, false);
});

test('structural：completed 空输出（run.mjs 归一化后的形态）', () => {
  assert.equal(classify({ stopReason: 'error', diagnostic: 'completed 但输出为空' }), 'structural');
});

test('structural：exit 0 但无输出事件', () => {
  assert.equal(classify({ stopReason: 'error', diagnostic: '无 final 事件' }), 'structural');
});

test('策略表：launch 回落通道 / budget 放宽预算 / structural 不重试', () => {
  assert.deepEqual(RETRY_POLICY['launch-failure'], { retry: true, fallbackChannel: true, bumpBudget: false });
  assert.deepEqual(RETRY_POLICY['budget-starved'], { retry: true, fallbackChannel: false, bumpBudget: true });
  assert.deepEqual(RETRY_POLICY.structural, { retry: false, fallbackChannel: false, bumpBudget: false });
});

test('policyFor：未知分类回落 structural', () => {
  assert.equal(policyFor('nonsense').retry, false);
});
