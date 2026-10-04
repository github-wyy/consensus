// checkpoint.mjs 单测：rounds 追加不覆盖、divergences 整体替换、cost 累积与 null 容错
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRound, appendRound, accumulateCost } from '../lib/checkpoint.mjs';

const R = (seat, over = {}) => ({
  seat,
  result: {
    stopReason: 'completed', output: 'x'.repeat(10), attempts: 1, channel: 'acp',
    channelFallback: false, diagnosis: null, wallMs: 1000, ...over,
  },
});

test('rounds 追加不覆盖', () => {
  const state = { rounds: [] };
  appendRound(state, newRound('R1-blind', [R('dsh')], { wallMs: 1000 }));
  appendRound(state, newRound('R2', [R('dsh')], { divergences: ['x'], wallMs: 2000 }));
  assert.equal(state.rounds.length, 2);
  assert.equal(state.rounds[0].phase, 'R1-blind');
  assert.equal(state.rounds[1].phase, 'R2');
});

test('divergences 写入该轮并整体替换 openDisagreements', () => {
  const state = { rounds: [], openDisagreements: ['旧分歧'] };
  appendRound(state, newRound('R2', [], { divergences: ['A', 'B'] }));
  assert.deepEqual(state.openDisagreements, ['A', 'B']);
  appendRound(state, newRound('R3', [], { divergences: [] }));
  assert.deepEqual(state.openDisagreements, []);
});

test('席位轨迹：attempts/diagnosis/channelFallback 完整入轮', () => {
  const round = newRound('vote', [R('dsh', { attempts: 2, channel: 'cli', channelFallback: true, diagnosis: 'launch-failure' })]);
  const t = round.seats.dsh;
  assert.equal(t.attempts, 2);
  assert.equal(t.channel, 'cli');
  assert.equal(t.channelFallback, true);
  assert.equal(t.diagnosis, 'launch-failure');
  assert.equal(t.chars, 10);
});

test('cost 累积：calls 按 attempts、tokens 按 usage 汇总', () => {
  const state = {};
  accumulateCost(state, [R('dsh', { attempts: 2 }), R('omp', { attempts: 1, usage: { input: 100, output: 50 } })]);
  assert.equal(state.cost.calls, 3);
  assert.deepEqual(state.cost.tokens, { input: 100, output: 50 });
  accumulateCost(state, [R('oc-spawn', { usage: { input: 10, output: 5 } })]);
  assert.equal(state.cost.calls, 4);
  assert.deepEqual(state.cost.tokens, { input: 110, output: 55 });
});

test('cost 容错：无任何 usage → tokens 保持 null（如实缺失）', () => {
  const state = {};
  accumulateCost(state, [R('dsh'), R('oc-spawn', { attempts: 2 })]);
  assert.equal(state.cost.calls, 3);
  assert.equal(state.cost.tokens, null);
});

test('cost 容错：缺省 attempts 计 1', () => {
  const state = {};
  accumulateCost(state, [{ seat: 'dsh', result: { stopReason: 'error', output: '' } }]);
  assert.equal(state.cost.calls, 1);
});
