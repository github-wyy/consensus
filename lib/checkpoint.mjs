// 逐轮 checkpoint（consensus skill）
// state.json 累积式结构（学自 agent-arena 的 run_state/checkpoint 纪律）：
//   - rounds[] 追加不覆盖（每轮每席 attempts/diagnosis/channelFallback 轨迹）
//   - divergences 写入该轮并整体替换 openDisagreements（协调者轮末维护当前未收敛集）
//   - cost 累积：calls=Σattempts；tokens 为 usage 汇总（best-effort，无 usage 如实保持 null）
// 纯数据变换、无 IO（读写由 run.mjs 负责）——node:test 直测（test/checkpoint.test.mjs）。

export function seatTrajectory(r) {
  const res = r?.result || {};
  return {
    stopReason: res.stopReason ?? null,
    attempts: res.attempts ?? 1,
    channel: res.channel ?? null,
    channelFallback: !!res.channelFallback,
    diagnosis: res.diagnosis ?? null,
    chars: (res.output || '').length,
    wallMs: res.wallMs ?? null,
  };
}

export function newRound(phase, results, { divergences = [], startedAt, wallMs } = {}) {
  const seats = {};
  for (const r of results || []) seats[r.seat] = seatTrajectory(r);
  return {
    phase,
    startedAt: startedAt || new Date().toISOString(),
    wallMs: wallMs ?? null,
    divergences: [...divergences],
    seats,
  };
}

export function appendRound(state, round) {
  state.rounds = state.rounds || [];
  state.rounds.push(round);
  state.openDisagreements = [...(round.divergences || [])]; // 整体替换：当前未收敛集
  return state;
}

export function accumulateCost(state, results = []) {
  state.cost = state.cost || { calls: 0, tokens: null, wallMs: 0 };
  for (const r of results) {
    state.cost.calls += r?.result?.attempts ?? 1;
    const u = r?.result?.usage;
    if (u && typeof u.input === 'number') {
      state.cost.tokens = state.cost.tokens || { input: 0, output: 0 };
      state.cost.tokens.input += u.input;
    }
    if (u && typeof u.output === 'number') {
      state.cost.tokens = state.cost.tokens || { input: 0, output: 0 };
      state.cost.tokens.output += u.output;
    }
  }
  return state.cost;
}
