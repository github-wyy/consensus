# 共识协议完整规格（SKILL_BODY）

本文档是 SKILL.md 引用的完整协议。协调者（opencode 主会话）按此执行。

## 0. 阵容与通道

### 调查员（辩手）三席

| 槽位 | 宿主与启动 | 模型 | 通道 |
|---|---|---|---|
| `oc-spawn` | `opencode run`（stdin 传任务书；model 省略随 opencode 默认） | null=随宿主（配置可钉死） | CLI（子进程） |
| `dsh` | `dsh --profile acp`（bin 三级解析，见「席位路由预检」） | 随 dsh profile（配置标注用） | ACP |
| `omp` | `omp acp`（`roster[].args` 可附启动参数） | null=随宿主 | ACP |

- dsh 席 env 由代码固定组装：`DSH_PERMISSION_MODE=read-only`（沙箱级只读）+ `TOKENHUB_API_KEY`（运行时从 opencode auth.json 读取，无则跳过）；**不接受配置注入 env**（防任意环境变量进入子进程）
- omp 无协议层权限时可经 `roster[].args` 带 `--approval-mode always-ask`（write/edit 需进程级硬拒；bash 逐条经权限请求放行）
- **部分参与降级**：某席不可用（预检失败/重试耗尽）→ 该席缺席，双共识过渡，报告如实标注

### 权限策略（决策 13：只读 + 可执行命令）

ACP `session/request_permission` 统一策略：

1. `options[]` 按 `kind` 选（**不能按 optionId**，opencode 用 once/always/reject、omp 用标准四项，命名不一致）
2. edit 类（file write/edit）→ reject
3. execute 类（bash）→ 按 `rawInput.command` 只读白名单判定：`ls/cat/grep/find/head/tail/wc/sed -n/git log/git diff/git show/go test/go vet/pytest` 等读命令放行；含 `>` `>>` `tee` `cp` `mv` `rm` `mkdir` `touch` 或写意图 → reject
4. read 类（工具自带 read/grep/glob）→ allow（once）
5. 权限请求不应答超时（10s）→ 自动 reject（opencode 行为未实测，防御性设计）
6. CLI 通道（oc-spawn）：无协议权限层，任务书内嵌只读纪律 + 子进程 cwd 隔离

### 席位路由预检（决策 14：学自 agent-arena）

进辩论前确认每个席位真实可用，**永不静默降级**：

- 二进制三级解析（`lib/preflight.mjs`）：env `CONSENSUS_BIN_{OPENCODE,DSH,OMP}` > 配置 `roster[].bin` > PATH `which` 探测；均未命中 → 该席预检失败（错误信息含可操作提示）
- 最小无害探测：ACP 席 = 完整 `initialize`+`session/new`+`dispose` 握手（零 token）；CLI 席 = `<bin> --version`（零 token），`--deep` 时追加一次最小 prompt（验证 auth+模型）
- 缓存 `.consensus/preflight.json`：ok 且二进制仍在 → 命中跳过；否则重探；`--force` 强制
- 预检失败席位：从本轮阵容剔除（部分参与降级）；全部失败 → 中止并列出各席诊断
- 预检通过的路由运行中失败 → 三分类诊断（§5）；通道回落必披露（checkpoint `channelFallback`）
- 铁律：**saved route 失败不静默换路由**——要么明确报错并提示切换，要么披露降级

### 会话管理（run 契约三定律）

- 任何失败 settle 成 `{stopReason, output, diagnostic}` **永不 reject**；dispose 幂等；abort→cancelled
- ACP stopReason 映射：`end_turn→completed / max_tokens→max-tokens / refusal→refusal / cancelled→aborted`
- **v1 会话模型（上下文重放）**：run.mjs 每次调用独立进程、每席每次调用新 ACP 会话、用完即回收（无长驻、无串行锁需求——单调用内天然串行）。多轮续聊 = 协调者在 prompt 里重放该席既往结论（见 §2 R2+ 模板）。跨调用长驻会话 Map + 空闲回收 + 服务端 resume 留作 v2 优化（收益：省重放 token）
- opencode 无 `session/cancel`（-32601）——取消该席只能杀进程；omp cancel 即时生效（实测）

## 1. 六阶段协议

### 阶段 0：触发与解析

- 触发词：`/consensus <问题>` 或用户明确表达；`--quick` / "快速共识" → quick 模式（决策 17）
- 解析：问题文本原文（一字不改）、当前工作区（`session/new` 的 cwd / 子进程 cwd）、模式（quick|full，入 state.mode）
- 构造 R1 任务书模板（见 §2）

### 阶段 1：盲辩（并行）

- （前置）`run.mjs blind` 自动席位预检（缓存感知）；预检失败席位缺席，如实标注
- 三席**同时**发起（ACP 两席 + CLI 一席并行）
- 任务书：问题原文 + 工作区路径 + 报告 schema 要求 + 只读纪律（CLI 席）
- **零他方信息**：任务书不得含任何其他调查员的存在痕迹或结论
- 收集六字段结构化报告（schema 见 §3）

### 阶段 2：汇总与条件触发判定（协调者本地，零调用）

- 构建观点矩阵：三席 × {根因判断, 置信度, 证据}
- 分歧检测：根因文本语义对比（协调者判断）
- **quick 模式（决策 17）**：无论是否分歧，跳过阶段 3，直接起草→表决（run.mjs 对 R* 轮次硬拒绝；vote 与追问 Q* 不受限）
- **进入 R2 的条件**（三者其一）：结论存在分歧 / 任一席置信度 <70% / 关键证据缺 file:line
- 全部不满足 → 直跳表决（阶段 4）
- 若已达共识且证据齐备：起草文案 → 表决确认（快通道）

### 阶段 3：交叉批评（条件触发，≤3 轮总预算含 R1）

每轮每席（ACP 席续聊、CLI 席新调用附增量材料）：

- 发送：其他两席结论摘要 + 具体分歧点（**只发新增材料**）
- 要求回应：认同则说明被哪条证据说服；不认同则给反驳证据（file:line）
- 协调者同时用 read/grep 对分歧点亲自实证（不辩论，只实证）
- 轮末把未收敛分歧写入 checkpoint（决策 15：逐轮 checkpoint，学自 agent-arena）：`round --divergences-file <f>`（分歧点一行一个；整体替换 openDisagreements）
- 轮末检查：收敛则进表决；未收敛且预算未尽则续轮
- 僵局（预算耗尽仍实质分歧）：降级输出（见 §5）

### 阶段 4：表决

- 协调者起草共识文案：根因表述 + 修复候选列表 + 分歧清单（归因格式）+ 保留意见（**逐字引用调查员原话**，无转述改写权）
- 每席发极短表决 prompt：`同意 / 反对 / 保留`（+ 证据门槛：反对须带反驳证据并指认分歧点，否则降级保留；保留须引用具体证据或反例，否则丢弃）
- **分层判定**：
  - 根因：全员非反对（同意+保留）才通过
  - 修复方案：无反对票即可，允许多候选并列
- 状态标签：强共识（全同意）/ 共识+保留意见 / 多数共识(2:1，附少数方理由) / 未收敛

### 阶段 5：报告与落盘

- 双面报告（决策 21）：
  - **会话面**（精简 markdown）：根因结论卡+状态徽章 → 修复候选并列 → 分歧归因清单 → 保留意见原话 → 成本披露
  - **Review 面**：`lib/render-report.mjs` 生成完整 HTML（三视图：A 结论卡片 / B 判决书叙事 / C 观点矩阵，原型 `docs/tmp/consensus-report-prototype.html` 转正）写入 `.consensus/runs/<ts>/report.html`，Review pane 打开
- 落盘结构：

```
.consensus/runs/<timestamp>/
├── state.json      # checkpoint：rounds[] 累积（每席 attempts/diagnosis/channelFallback）、openDisagreements、cost 累积、阵容快照（不含凭据）
├── reports/        # <seat>-<phase>.md 各席各轮报告（含失败诊断与重试轨迹）
├── report.json     # 结构化共识记录（schema = 原型 mock 数据结构 D；协调者编译）
├── report.html     # Review 面三视图渲染
└── events.ndjson   # 全部调查员调用原始事件流（审计）
```

- 成本披露：调用次数 × 席位、token 汇总（ACP usage_update / CLI 事件流；oc-spawn 无 usage 时如实缺失）、墙钟耗时、单 agent 对照基线估算——数据源为 state.json 的 cost 累积（calls = Σ attempts）

### 追问（分级，决策 12）

- 默认：协调者基于 report.json + transcript 直接回答（零调查员调用）
- 追问引入新信息 / 挑战已有共识 → 定向辩论：向相关调查员（ACP 续聊）发增量材料，重过阶段 3-5（增量）
- 跨会话：新会话读到 `.consensus/runs/` 最新 report.json 即可恢复上下文

## 1.5 协调者驱动手册（run.mjs 命令映射）

```sh
LIB=~/.agents/skills/consensus/lib

# 前置：席位预检（零 token；--deep 对 CLI 席加最小 prompt 验证 auth；--force 忽略缓存）
node $LIB/run.mjs preflight --workspace <repo> [--deep] [--force]

# 阶段1 盲辩（问题原文+报告要求写入 question 文件；由协调者构造；自动预检）
node $LIB/run.mjs blind --workspace <repo> --question-file <q.txt>
# → stdout: {run, reports[{seat,file}], summary, preflight, activeSeats, cost}；报告在 <repo>/.consensus/runs/<ts>/reports/<seat>-R1-blind.md

# 阶段2（协调者本地，零调用）：读三份报告 → 观点矩阵 + 分歧检测 → 条件触发判定
#   全一致且置信度≥70%且证据齐 → 直跳表决；否则进 R2

# 阶段3 亮牌（per-seat prompt：--prompt-dir 下每席一个 <seat>.md，按 §2 R2+ 模板含该席自己上轮报告；缺该席文件回落共用 --prompt-file）
node $LIB/run.mjs round --run <ts> --prompt-dir <dir> --workspace <repo> [--phase R2] [--divergences-file <div.txt>]
# 协调者同时用 read/grep 亲自实证分歧点；轮末未收敛分歧经 --divergences-file 写入 checkpoint（一行一个，整体替换 openDisagreements）
# quick 模式下 run.mjs 硬拒绝 R* 轮次（决策 17）——直接走 vote

# 阶段4 表决（draft-file = 共识文案草案，模板见 §2；共用草案广播全体）
node $LIB/run.mjs vote --run <ts> --draft-file <draft.txt> --workspace <repo>
# → 读 reports/<seat>-vote.md 收集三份表态 → 分层判定

# 阶段5 编译 report.json（schema §3）→ 渲染 → Review pane 打开
node $LIB/render-report.mjs <repo>/.consensus/runs/<ts>/report.json
# → report.html 同目录生成；协调者用 browser preview 打开给用户

# 查询 / 排查
node $LIB/run.mjs status --workspace <repo> [--run <ts>]
```

round/vote 重建阵容：bin 取自 checkpoint 快照（失效则重新三级解析），env/凭据现场组装；仅 checkpoint `activeSeats` 内的席位参与。

追问（分级）：默认协调者直接读 report.json + reports/ 作答；新信息/挑战共识 →
构造增量 prompt（含该席全部既往报告）走 `round`（--phase Q1、Q2…）→ 重新表决受影响层 → 更新 report.json。



## 2. Prompt 模板

### R1 任务书（盲辩）

```
你是一名独立诊断专家。请分析以下问题，只依赖你自己的推理和可用的只读工具。

【问题】
{question}

【工作区】{workspace}（可用 read/grep/glob 只读检索；可执行只读命令验证，如 go test）

【报告要求】严格按以下六字段输出，≤600 词：
1. 假设集：按可能性降序排列
2. 根因判断：一句话
3. 关键证据：每条必须带 file:line（或命令输出摘要）
4. 置信度：百分比
5. 修复方向草案：一句到三句
6. 开放疑虑：没有就写"无"
```

### R2+ 亮牌（增量 + 上下文重放）

> v1 架构：run.mjs 每次调用独立进程，ACP 会话不跨调用存活。协调者构造 R2+ prompt 时
> **必须包含该席自己的上一轮结论**（从 `.consensus/runs/<ts>/reports/<seat>-<phase>.md` 读取），
> 加上他方结论与分歧点——run 契约的降级重放路径，鲁棒且状态简单；服务端会话 resume 留作 v2。
> 落地：`round --prompt-dir <dir>`（每席 `<seat>.md`，按本模板构造）；缺该席文件时回落单一共用 `--prompt-file` 广播（token 略费，语义等价）。

```
【你上一轮的结论】
{seat_own_previous_report}

【其他专家的结论】
{other_a_summary}
{other_b_summary}

【具体分歧点】{divergence_points}

请重新审视你的结论：
- 若你认同对方某点，说明被哪条证据说服
- 若不认同，给出反驳证据（file:line）
- 更新你的六字段报告（仅更新有变化的部分）
```

### 表决

```
【共识文案草案】
{draft}

请表决：同意 / 反对 / 保留
- 反对必须给出反驳证据（file:line）并指认你反对的具体分歧点，否则按保留计
- 保留必须引用具体证据或反例，否则将被丢弃
只回一个词 + 理由（若有）。
```

## 3. 报告 schema（report.json = 原型结构 D）

```jsonc
{
  "question": "...", "date": "ISO", "workspace": "...", "mode": "full|quick", "rounds": "N 轮 + 表决",
  "investigators": [{ "id": "glm|deepseek|third", "host": "...", "model": "..." }],
  "rootCause": { "text": "...", "status": "强共识|共识+保留意见|多数共识 2:1|未收敛",
                  "votes": "n同意/n反对/n保留", "evidence": ["file:line", ...] },
  "fixes": [{ "title": "...", "desc": "...", "status": "...", "votes": "...", "note": "反对理由" }],
  "divergences": [{ "a": "...", "aView": "...", "b": "...", "bView": "...",
                    "point": "...", "resolved": "...", "round": "R2|R3|未收敛" }],
  "reservations": [{ "who": "...", "quote": "逐字原话", "evidence": "..." }],
  "trajectory": [{ "round": "R1 盲辩", "turns": "3 并行", "key": "..." }],
  "evidenceIndex": [{ "loc": "file:line", "desc": "...", "verified": true }],
  "cost": { "calls": "...", "tokens": "...", "wall": "...", "compare": "..." }
}
```

## 4. 配置（~/.config/consensus/config.yaml，仓库 .consensus.yaml 覆盖）

```yaml
roster:
  - key: oc-spawn
    tool: opencode
    channel: cli          # opencode run 子进程
    model: null           # null = 随 opencode 默认
    # bin: /usr/local/bin/opencode   # 三级解析之外的手动指定（默认：env CONSENSUS_BIN_OPENCODE > 此处 > PATH）
  - key: dsh
    tool: dsh
    channel: acp
    model: null           # 标注用；实际模型随 dsh profile
    # bin: "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
    # env 由代码固定组装（DSH_PERMISSION_MODE=read-only + 凭据运行时读取），不接受配置注入
  - key: omp
    tool: omp
    channel: acp
    model: null           # null = 随 omp 默认
    # args: ["--approval-mode", "always-ask"]   # 启动参数（omp 无协议层权限时建议）
moderator:
  role: coordinator        # 主会话兼任（#122 定案）
debate:
  maxRounds: 3             # 含 R1
  blindReportMaxWords: 600
  confidenceThreshold: 70
voting:
  rootCauseRule: non-objection
  fixRule: no-objection
timeoutPerCallMs: 600000   # 10 分钟
budgetBumpFactor: 1.5      # budget-starved 重试的预算放宽倍数
idleRecycleMs: 1800000     # 30 分钟
```

## 5. 降级路径

失败先经三分类诊断（`lib/diagnose.mjs`，决策 16；学自 agent-arena 的 error 分类纪律），分类驱动重试（每席每轮 attempts ≤ 2）：

| 分类 | 触发 | 重试策略 |
|---|---|---|
| launch-failure | ACP 握手失败 / CLI exit≠0 / ENOENT | ACP 席回落 CLI 通道重试 1 次（**披露 channelFallback**）；CLI 席同通道重试 1 次 |
| budget-starved | prompt 超时 / max_tokens | 同通道放宽预算（×`budgetBumpFactor`，默认 1.5）重试 1 次 |
| structural | refusal / 输出为空 / 其他协议错误 | 不重试 → 缺席，如实标注 |

铁律（学自 agent-arena）：**重试只做无损动作**（重开进程 / 放宽预算 / 换通道并披露）；任何收窄调查员独立审查范围的有损动作（砍工具 / 砍轮数 / 降上下文）**须用户批准**。

| 情形 | 处理 |
|---|---|
| 僵局（轮数耗尽） | 输出已共识部分 + 分歧报告（按层标注），交用户裁决，不强制收敛 |
| 某席缺席 | 双共识过渡，报告标注席位状态（预检失败或重试耗尽，checkpoint 留诊断） |
| ACP 握手失败 | 三分类 launch-failure → 回落 CLI 通道（dsh headless / omp -p，披露 channelFallback）→ 再失败则缺席 |
| 权限请求超时 | 自动 reject，继续 |
| 调查员进程崩溃 | settle {stopReason:error} → 三分类诊断驱动重试（≤2 attempts）→ 缺席 |

## 6. 与单 agent 对照基线（成本披露用）

估算公式：单次等价诊断 ≈ R1 任务书 tokens（三席共享同一任务书文本）× 1 席。
报告 `cost.compare` 字段格式：`单 agent 对照基线：1 次调用 / ~XK tokens / ~Y 秒（无分歧报告与交叉验证）`，X/Y 取三席 R1 均值。
成本数据取自 state.json 的 cost 累积（calls = Σ attempts；tokens 为 usage 汇总，oc-spawn 无 usage 时如实缺失）。
quick 模式成本约为 full 的 1/3——同一问题可双跑（`--mode quick` 与默认 full）对照成本与结论稳定性，`cost.compare` 字段记录对照。
