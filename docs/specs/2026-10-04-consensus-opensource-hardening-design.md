# consensus 开源加固设计（Open-Source Hardening）

> 日期：2026-10-04
> 状态：待用户评审
> 前置调研：`docs/research/community-prior-art.md`（先行工作调研，随本仓库发布）

## 1. 背景与目标

consensus 是一个 OpenCode skill：多 agent 辩论式强共识诊断（盲辩 R1 → 交叉批评 → 分层表决 → 僵局不强制收敛），当前实现位于 `~/.agents/skills/consensus`（约 817 行，非 git 管理）。

调研结论：思想有近邻（ReConcile / Council Mode / agent-arena），但**协议组合无等价物**。本次目标：把 agent-arena 的三项工程纪律（participant 预检、逐轮 checkpoint、error 三分类诊断）深融进协议与实现，写一份带学术论证的 README，并完成开源基建（LICENSE / git / 可移植性），产出**开源就绪**的仓库。

## 2. 范围

**做**：
1. 新仓库 `github-wyy/consensus`，`~/.agents/skills/consensus` 改为软链指向仓库根（单份维护，opencode 加载路径不变）
2. 席位路由预检（`lib/preflight.mjs` + `run.mjs preflight` 子命令）
3. 逐轮 checkpoint（state.json 覆盖式 → 累积式，含 retry 预算、席位轨迹、openDisagreements、cost 累积）
4. 失败三分类诊断（`lib/diagnose.mjs`，分类驱动重试策略）
5. 可移植性重构：硬编码路径/模型名 → 三级解析（env > config > which）
6. README.md（中文为主，学术论证 + 近邻差异表）、MIT LICENSE、config.example.yaml、.gitignore
7. SKILL.md / SKILL_BODY.md 协议文档同步（协议级写入三纪律）
8. `node:test` 单元测试

**不做（明确出栈）**：
- quick 基线模式（R1+直接表决）
- v2 长驻会话 / 服务端 resume / mABC 席位权重
- 英文 README、CI、skills.sh 市场发布
- render-report.mjs / report-template.html 改动（渲染层保持现状）

## 3. 仓库布局与真源策略

```
consensus/
├── README.md                  # 中文为主：定位/学术论证/差异表/快速开始
├── LICENSE                    # MIT
├── SKILL.md                   # 入口（opencode 触发层）
├── SKILL_BODY.md              # 完整协议（本次大改）
├── config.example.yaml        # 三席配置样例
├── .gitignore                 # .consensus/ 等
├── lib/                       # run / acp-client / cli-client / investigators / render-report
│   ├── preflight.mjs          # 新增
│   └── diagnose.mjs           # 新增
├── test/                      # node:test 单测
│   ├── diagnose.test.mjs
│   ├── preflight.test.mjs
│   └── checkpoint.test.mjs
└── docs/
    ├── specs/                 # 本 spec
    └── research/              # 先行工作调研报告
```

迁移终态：`~/.agents/skills/consensus` → 软链 → `/Users/yangyang/go/src/github.com/github-wyy/consensus`。

## 4. 设计细节

### 4.1 席位路由预检（preflight）

**二进制三级解析**（`resolveBin(seatKey, cfg)`，写入 `lib/preflight.mjs`）：

1. env：`CONSENSUS_BIN_OPENCODE` / `CONSENSUS_BIN_DSH` / `CONSENSUS_BIN_OMP`
2. config：roster[].bin（仓库 `.consensus.yaml` > `~/.config/consensus/config.yaml`）
3. `which` PATH 探测
4. 均未命中 → 预检失败，报可操作错误（"安装 X 或设置 CONSENSUS_BIN_X / roster[].bin"）

> 注意：**移除**现有代码中的作者路径兜底（`/Users/yangyang/.opencode/bin/opencode` 等硬编码）。作者自己的路径写进 `~/.config/consensus/config.yaml`（不入库）；dsh 的 .app 内路径同理，config.example.yaml 中以注释示例。

**探测语义**（分通道，最小无害调用）：
- ACP 席（dsh/omp）：完整 `initialize` + `session/new` + `dispose` 握手（零 token，验证二进制+协议+会话）
- CLI 席（oc-spawn）：默认 `<bin> --version`（零 token）；`--deep` 时执行一次最小 prompt（"只回复 OK"，验证 auth+模型）

**缓存与失效**：`.consensus/preflight.json`，记录 `{seat, ok, resolvedBin, model, probedAt, deep}`。
- `blind` 自动跑预检：缓存命中且 `fs.existsSync(resolvedBin)` → 直接用；否则重探
- `preflight [--deep]` 子命令强制重探并刷新缓存
- 预检即失败的席位：从本轮阵容剔除（既有"部分参与降级"语义），报告如实标注

**协议纪律**（写进 SKILL_BODY §0）：预检通过的路由在运行中失败 → 走三分类诊断（见 4.3），降级必须**披露**（checkpoint 记 `channelFallback: true` + 运行摘要输出），永不静默降级。

**模型名可移植性**：oc-spawn 默认 model 由 `tke/deepseek-flash-latest` 改为 `null`（随 opencode 默认）；dsh/omp 维持现状（null=随宿主）。作者实际模型钉在他自己的全局 config。`tkehubKey()`（从 opencode auth.json 读凭据）保留为凭据透传，返回 null 时跳过，config.example.yaml 注释说明。

### 4.2 逐轮 checkpoint（state.json 累积式）

```jsonc
{
  "ts": "...", "workspace": "...", "question": "…(截断500)",
  "roster": {
    "seats": [ /* 阵容快照 */ ],
    "preflight": { "dsh": { "ok": true, "resolvedBin": "...", "probedAt": "..." } }
  },
  "rounds": [
    {
      "phase": "R1-blind", "startedAt": "...", "wallMs": 123,
      "divergences": ["分歧点1", "…"],
      "seats": {
        "dsh": { "stopReason": "completed", "attempts": 1, "channel": "acp",
                 "channelFallback": false, "diagnosis": null,
                 "chars": 4567, "wallMs": 89000 }
      }
    }
  ],
  "openDisagreements": ["…"],
  "cost": { "calls": 6, "tokens": { "input": 1234, "output": 567 }, "wallMs": 12345 }
}
```

- 每轮**追加** `rounds[]`（不覆盖），轮内席位结果由 `persistRound` 写入
- `round --divergences-file <f>`（可选）：分歧点一行一个，写入该轮 `divergences` 并整体替换 `openDisagreements`（协调者轮末维护当前未收敛集）
- `cost` 累积：calls 按 prompt 次数计（可靠）；tokens 从各席 usage 汇总（best-effort，无 usage 记 null——ocSpawn 无 usage 时如实缺失）
- 保留文件名 `state.json`（改名收益不抵 churn）；SKILL_BODY §1.5 落盘结构描述同步更新为实际（state.json 已含 roster 快照，不再单列 config.json）

**收益**（README 论证点）：中断恢复（status 直接读 checkpoint）、审计（每席每轮 attempts/diagnosis）、成本基线对照数据源（SKILL_BODY §6 的 cost.compare 从此处取数）。

### 4.3 失败三分类诊断（diagnose.mjs）

`classify({stage, stopReason, diagnostic})` → 纯函数，表驱动：

| 分类 | 触发 | 策略 |
|---|---|---|
| **launch-failure** | ACP `initialize`/`session/new` 失败；CLI exit≠0；ENOENT | ACP 席：经 CLI 回落通道重试 1 次（披露 channelFallback）；CLI 席：同通道重试 1 次。再败 → 缺席 |
| **budget-starved** | prompt 超时 / stopReason=max-tokens | 同通道放宽重试 1 次（timeoutMs × `budgetBumpFactor`，默认 1.5）。再败 → 缺席 |
| **structural** | refusal / completed 但输出空 / 其他 JSON-RPC error | 不重试 → 缺席，如实标注 |

- 每席每轮 attempts ≤ 2；重试在 `promptSeat` 内部闭环，结果带 attempts/diagnosis/channelFallback 进 checkpoint
- **铁律**（SKILL_BODY §5，摘 agent-arena）：重试只做无损动作（重开进程/放宽预算/换通道并披露）；任何**收窄调查员独立审查范围**的有损动作（砍工具/砍轮数/降上下文）须用户批准
- 现有降级链语义保持：ACP→CLI 回落仍存在，但从"静默"变"披露"

### 4.4 README.md（中文为主，学术论证是核心节）

骨架：
1. 一句话定位（多 agent 辩论式强共识诊断；与 sethwebster/consensus 同名不同物，一句话说明）
2. 为什么存在——单模型过度自信/锚定；引 MAST 失败分类学与 agent-arena 哲学
3. 六阶段协议一览 + 工程纪律（预检/checkpoint/三分类，从 agent-arena 吸收并致谢）
4. **协议设计依据**（核心差异节）：每条纪律 → 学术出处
   - 盲辩 R1 ← Voting or Consensus 的 AAD（交互前独立起草，+3.3%）
   - 异构三宿主 ← Council Mode 消融（同模型集成远逊异构）+ ReConcile
   - 交叉批评须 file:line + 协调者亲自实证 ← **Debate or Vote 鞅定理**（辩论期望收益≈0，收益须来自外部确定性证据——这是把学术批评转化为设计论证的关键一节）
   - 分层表决 ← Voting or Consensus（知识型共识制/推理型投票制）
   - ≤3 轮上限 ← 同文"加 agent 优于加轮次"
   - 僵局不强制收敛 ← Should we be going MAD 的批评
5. 与近邻差异表（agent-arena / cross-review / sethwebster-consensus / Trail of Bits second-opinion，取调研报告 §6 总表的近邻行）
6. 快速开始（安装 skill → config → preflight → `/consensus`）
7. 配置参考（三级解析、config.example.yaml 逐项注释、tke 环境说明）
8. 限制与诚实披露（三宿主需本地安装；成本 3-12×；协议文档中文）
9. 致谢与引用（论文列表 + agent-arena）

所有引用链接以 `docs/research/community-prior-art.md` §8 为唯一来源（已逐条核实，含 Council Mode v5 改题勘误）。

### 4.5 协议文档同步（SKILL.md / SKILL_BODY.md）

- SKILL_BODY §0：新增"席位路由预检"小节（三级解析/缓存失效/永不静默降级/`preflight` 命令）
- SKILL_BODY §1：阶段 1 前插预检步骤；阶段 3 轮末写 `--divergences-file`；阶段 5 报告从 checkpoint 取 cost
- SKILL_BODY §1.5：命令映射表加 `preflight` 与 `--divergences-file`
- SKILL_BODY §5：降级路径表前加三分类表，行级映射到分类
- SKILL.md：纪律清单加预检一条；阵容表 model 默认改 null 说明
- 两文档的"决策 #1xx"编号体系不动（新增规则追加编号）

## 5. 文件变更清单

| 文件 | 动作 | 要点 |
|---|---|---|
| `lib/preflight.mjs` | 新增 | resolveBin 三级解析 + 探测 + 缓存读写（~120 行） |
| `lib/diagnose.mjs` | 新增 | classify 纯函数 + RETRY_POLICY 表（~60 行） |
| `lib/run.mjs` | 修改 | preflight 集成、checkpoint 累积、promptSeat 重试闭环、--divergences-file、cost 汇总 |
| `lib/investigators.mjs` | 修改 | 去硬编码路径；model 默认 null；bin 解析走 preflight |
| `lib/cli-client.mjs` | 修改 | ocSpawn/dshHeadless/ompOnce 接收 bin/cmd 参数（去内部硬编码） |
| `lib/acp-client.mjs` | 不动 | — |
| `SKILL.md` / `SKILL_BODY.md` | 修改 | 见 4.5 |
| `README.md` / `LICENSE` / `config.example.yaml` / `.gitignore` | 新增 | 见 4.4 / §3 |
| `test/*.test.mjs` | 新增 | 3 个测试文件 |
| `docs/research/community-prior-art.md` | 迁入 | 从 ~/.agents/skills/consensus/research/ 移入 |

预计：新增 ~450 行（含 README/测试），改造 ~300 行 diff。

## 6. 测试策略

`node:test`（零依赖，匹配现有代码风格）：
- `diagnose.test.mjs`：表驱动全分支（三类 × 触发形态）+ 边界（timeout 诊断文本、max_tokens、空输出）
- `preflight.test.mjs`：resolveBin 三级优先级（env 覆盖 config 覆盖 which；mock env 与临时 config 文件；PATH 操控）；缓存命中/失效（resolvedBin 不存在 → 重探）
- `checkpoint.test.mjs`：rounds 追加不覆盖、divergences 整体替换语义、cost 累加（含 null token 容错）

真实三席调用与 `--deep` 探测不在单测内——留实测路径（实现后本机各跑一次 blind 验证）。

## 7. 迁移与实施顺序

1. 复制现有 skill 全部文件入新仓库（lib/ SKILL.md SKILL_BODY.md research/），首次提交作为基线
2. 可移植性重构（三级解析 + model null）→ 提交
3. preflight + diagnose 实现 + run.mjs checkpoint 改造 + 测试 → 提交
4. 协议文档同步 → 提交
5. README / LICENSE / config.example.yaml / .gitignore → 提交
6. `~/.agents/skills/consensus` 换软链，验证 opencode 能加载 skill
7. 本机实测一次 `preflight` + 一次 `blind`（冒烟），确认软链下运行正常

每步独立可回退（git 提交粒度）。

## 8. 风险与权衡

- **软链与 skill 加载**：opencode 对 `~/.agents/skills/` 下软链的扫描行为未实测——迁移步骤 6 显式验证；失败回落方案：改回实目录 + rsync 同步脚本
- **`which` 探测误判**：同名二进制版本不符（如老版 omp）——`--deep` 模式兜底验证；预检失败信息中打印 resolvedBin 便于排查
- **重试增加成本**：最坏情况每席 ×2 attempts；但 budget-starved 只在超时发生时触发，正常路径零额外成本
- **去硬编码破坏作者本机默认**：迁移后首次跑 `preflight` 前需先写 `~/.config/consensus/config.yaml`（作者路径）；迁移步骤 6/7 实测覆盖此场景
- **dsh 席 model 为 profile 钉死**：开源用户无 dsh 时该席预检直接失败缺席——属预期行为（部分参与降级），README 限制节如实说明

## 9. 开放问题

无——设计已与用户逐节确认（方案 2 深融合；仓库即 github-wyy/consensus；README 中文为主）。

## 10. 变更记录

- **2026-10-04（用户指示"继续"，补做出栈项与验证缺口）**：
  - quick 基线模式（决策 17）：`blind --mode quick` → state.mode，run.mjs 对 R* 交叉批评轮硬拒绝（vote/追问 Q* 不受限），协议文档与 README 同步——原 §2 出栈项提前落地
  - `round --prompt-dir`：per-seat 亮牌（每席 `<seat>.md`，对齐 §2 R2+ 模板的 own-report 重放；缺文件回落共用 prompt 广播）——修复 v1 文档承诺 per-seat 而代码只广播的缺口
  - cost 诚实性：ACP 席仅在上报过 usage_update 时透传 usage，否则 null（修复"0 假装有数据"）
  - 全链路冒烟补齐：round（R2 真实辩论，dsh 撤回含糊表述）→ vote（三席全票同意）→ report.json 编译 → render-report

