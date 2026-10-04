// 失败三分类诊断（consensus skill）
// 学自 agent-arena 的 error 诊断纪律：重试只做无损动作，有损动作须用户批准。
//
// 分类与策略（run.mjs 的重试闭环按此驱动，每席每轮 attempts ≤ 2）：
//   launch-failure  启动失败（ACP 握手 / CLI exit≠0 / ENOENT）→ ACP 席回落 CLI 通道重试（披露 channelFallback）；CLI 席同通道重试
//   budget-starved  预算饥饿（prompt 超时 / max_tokens）        → 同通道放宽预算重试
//   structural      结构性故障（refusal / 空输出 / 协议错误）    → 不重试，缺席并如实标注
//
// 纯函数、无 IO——node:test 直测（test/diagnose.test.mjs）。

export const RETRY_POLICY = {
  'launch-failure': { retry: true, fallbackChannel: true, bumpBudget: false },
  'budget-starved': { retry: true, fallbackChannel: false, bumpBudget: true },
  'structural': { retry: false, fallbackChannel: false, bumpBudget: false },
};

// result: { stage?: 'launch' | 'prompt', stopReason: string, diagnostic?: string }
// stage 由调用方标注：ACP 握手失败记 stage='launch'；CLI/会话中失败靠 diagnostic 特征识别。
export function classify(result = {}) {
  const { stage, stopReason, diagnostic = '' } = result;
  if (stage === 'launch') return 'launch-failure';
  if (stopReason === 'max-tokens') return 'budget-starved';
  if (stopReason === 'error') {
    if (/超时/.test(diagnostic)) return 'budget-starved';
    if (/exit \d+|ENOENT|not found|启动失败/i.test(diagnostic)) return 'launch-failure';
  }
  return 'structural';
}

export function policyFor(cls) {
  return RETRY_POLICY[cls] || RETRY_POLICY.structural;
}
