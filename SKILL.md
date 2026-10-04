---
name: consensus
description: 共识模式——多 agent 辩论强共识诊断。当用户要对一个 bug/问题做多 agent 交叉验证诊断、提到"共识"、"consensus"、"让几个工具一起看看"、"多模型会诊"时使用。opencode 作为编排者，通过 ACP 协议调度 dsh/omp/自 spawn 的子 agent（不同模型）盲辩→交叉批评→表决，产出全员一致的根因共识+分歧报告，支持分级追问。
---

# Consensus — 共识模式

多 agent 辩论强共识诊断。核心思想：**单模型考虑不全，多模型独立盲辩再交叉验证**——相同点是共识种子，不同点是辩论议题。

## 何时触发

用户显式要求：`/consensus <问题>` 或明确说"共识模式诊断这个 bug"。
**不要自动触发**——三 agent 辩论约 3-12 倍单次调用成本。

## 你（opencode 主会话）的角色：协调者，不是辩手

你不辩论、不裁决。你只做：调度辩手、汇总立场、read/grep 实证、起草共识文案、渲染报告。
结论由三个调查员（辩手）表决产生。

## 执行流程

严格按 `SKILL_BODY.md` 的六阶段协议执行。关键纪律：

1. **盲辩纪律**：R1 任务书 = 用户问题原文 + 工作区路径 + 报告 schema 要求，**零他方信息**
2. **槽位 spawn 化**：三个辩手全部是独立进程/子 agent，你不得亲自下场
3. **证据门槛**：保留必须引用具体证据/反例，否则丢弃；反对必须带反驳证据(file:line)并指认分歧点，否则降级为保留
4. **增量上下文**：R2+ 只发新增材料（他方结论+分歧点），不重贴全文
5. **分层判定**：根因=全员非反对；修复方案=无反对票，允许多候选并列
6. **僵局降级**：轮数耗尽仍有实质分歧 → 输出已共识部分+分歧报告（按层标注），交用户裁决，**不强制收敛**
7. **成本披露**：报告含调用次数/token/耗时 + 单 agent 对照基线估算（数据源：state.json checkpoint 的 cost 累积）
8. **席位预检、永不静默降级**：辩论前 `preflight`；席位运行中失败走三分类诊断（launch/budget/structural），通道回落必披露（channelFallback）；**任何收窄调查员独立审查范围的有损动作须用户批准**——重试只做无损动作

## 阵容（默认，可被 .consensus.yaml / ~/.config/consensus/config.yaml 覆盖）

| 槽位 | 宿主 | 模型 |
|---|---|---|
| 1 | opencode spawn 子进程（`opencode run`） | null=随 opencode 默认（配置可钉死） |
| 2 | dsh acp profile | 随 dsh profile（配置标注用） |
| 3 | omp acp | null=随 omp 默认 |

席位二进制经三级解析：`CONSENSUS_BIN_{OPENCODE,DSH,OMP}` env > 配置 `roster[].bin` > PATH 探测（`lib/preflight.mjs`）。异构性纪律：三席刻意选不同模型，避免同模型趋同——设计依据见 README「协议设计依据」。

## 追问分级

- 默认：基于共识记录直接回答（零调查员调用）
- 追问引入新信息或挑战已有共识 → 向相关调查员（ACP 会话续聊）发起一轮定向辩论，重过阶段 3-5 增量流程

## 工具与文件

- 通道客户端：`lib/acp-client.mjs`（ACP 协议）+ `lib/cli-client.mjs`（CLI 回落通道）
- 调查员定义：`lib/investigators.mjs`（阵容组装、配置解析、凭据读取）
- 工程纪律：`lib/preflight.mjs`（席位预检/二进制三级解析）+ `lib/diagnose.mjs`（失败三分类）+ `lib/checkpoint.mjs`（逐轮 checkpoint）
- 配置：`~/.config/consensus/config.yaml` 全局默认 + 仓库 `.consensus.yaml` 覆盖（样例见 `config.example.yaml`）
- 落盘：`.consensus/runs/<timestamp>/`（state.json=checkpoint 与阵容快照 + reports/ + report.json + report.html + events.ndjson）
- 完整协议细节：`SKILL_BODY.md`
