# consensus

> 多 agent 辩论式强共识诊断 —— OpenCode skill。三个异构宿主上的不同模型独立盲辩、交叉批评、分层表决；**证据先于共识，分歧永不静默。**

**consensus** 把一个 bug/根因问题同时交给三个不同宿主上的不同模型（`opencode run` 子进程 + 两个 ACP 协议宿主），让它们先独立盲辩、再互相批评、最后对共识文案表决。你得到的不只是一个答案，而是：全员表决过的根因结论、并列的修复候选、逐字保留的少数派异议、以及完整的成本与审计记录。

**适合**：疑难 bug 根因分析、高风险架构决策、单模型过度自信时的交叉验证。
**不适合**：简单事实查询、格式化、常规小改动（成本约 3-12 倍单次调用，见[限制](#限制诚实披露)）。

> 同名说明：本仓库与 [sethwebster/consensus](https://github.com/sethwebster/consensus) 同名不同物——那是把 prompt 并行 fan-out 给全部本机 CLI 再综合的单轮工具；本仓库是完整的多轮辩论 + 分层表决协议。

## 为什么存在

LLM 单模型会过早自信：一旦形成某个框架就难以自我跳出（Degeneration-of-Thought，[Liang et al. 2024](https://arxiv.org/abs/2305.19118)）。多 agent 系统自己的失败模式研究（[MAST, NeurIPS 2025](https://arxiv.org/abs/2503.13657)，1600+ 标注 trace）把常见失败归为 14 类，其中两大类——**agent 间失配**（基于错误假设继续跑、忽略他人输入、隐瞒信息）与**验证不足**（过早终止、错误验证）——恰好都是"没有强制的证据纪律与外部验证"导致的。obra/superpowers 的维护者也收到了同样的诉求（[issue #730](https://github.com/obra/superpowers/issues/730)：评审与实现同模型家族 = "带额外步骤的自我评审"），但明确决定不实现。

而最朴素的解法"多问几个模型让他们吵"，又被 [Debate or Vote（NeurIPS 2025 Spotlight）](https://arxiv.org/abs/2508.17536)证明了一件扎心的事：**多 agent 辩论的大部分收益来自多数投票，辩论轮本身是鞅——期望收益约等于零**。agent 互相说服和互相带偏是对称的。

所以本 skill 的设计不是"让 agent 吵出真理"，而是把收益引擎放在辩论之外：**独立多样本（R1 盲辩）+ 外部确定性证据（file:line 门槛 + 协调者亲自实证）+ 分层表决门槛**。辩论轮只负责暴露分歧点，不负责裁决。

## 六阶段协议

| 阶段 | 内容 |
|---|---|
| 0 触发解析 | `/consensus <问题>`，问题原文一字不改 |
| 1 盲辩 | 三席并行独立作答；任务书只含问题+工作区+报告 schema，**零他方信息**；六字段结构化报告（假设集/根因/证据 file:line/置信度/修复草案/开放疑虑） |
| 2 汇总 | 协调者本地构建观点矩阵、分歧检测、条件触发判定（全一致且证据齐 → 直跳表决） |
| 3 交叉批评 | ≤3 轮：每席看他方结论+具体分歧点；**认输须说明被哪条证据说服，反驳须带 file:line**；协调者同时用 read/grep **亲自实证**分歧点（不下场辩论） |
| 4 分层表决 | 对共识文案草案投 同意/反对/保留；反对无证据降级为保留；**根因=全员非反对才通过，修复方案=无反对即可、多候选并列** |
| 5 报告落盘 | 会话面精简 markdown + Review 面短幻灯片 deck（封面/结论与证据/辩论过程/分歧与保留/修复/成本，空页自动跳过）+ report.json + events.ndjson 审计流；成本披露含单 agent 基线对照 |

外加三项工程纪律（学自 [agent-arena](https://github.com/zhjai/agent-arena)，见[致谢](#致谢)）：

- **席位路由预检**：进辩论前三级解析二进制并做最小无害探测（ACP 完整握手零 token / CLI `--version`）；预检失败席位缺席、如实标注，**永不静默降级**
- **逐轮 checkpoint**：state.json 累积式记录每席每轮 attempts / 失败分类 / 通道回落 / 成本——中断恢复、审计、成本对照的单一数据源
- **失败三分类诊断**：`launch-failure`（回落通道重试并披露）/ `budget-starved`（放宽预算重试）/ `structural`（不重试缺席）；**重试只做无损动作，收窄审查范围的有损动作须用户批准**

**模式**：默认 full（完整六阶段）；`--mode quick` = R1 盲辩 + 直接表决（跳过阶段 3，run.mjs 对交叉批评轮硬拒绝，约 1/3 成本）——用于成本敏感问题，或与 full 同题对照（见[直面反方证据](#直面反方证据)）。

## 协议设计依据

每条纪律都有出处——不是拍脑袋：

| 纪律 | 学术出处 | 一句话理由 |
|---|---|---|
| R1 盲辩（任务书零他方信息） | [Voting or Consensus（ACL 2025）](https://aclanthology.org/2025.findings-acl.606/) 的 AAD | 交互前独立起草 +3.3%；投票前增加讨论轮次反而降分 |
| 三席三宿主异构（CLI + ACP×2） | [Council Mode](https://arxiv.org/abs/2604.02923) 消融 + [ReConcile](https://arxiv.org/abs/2309.13007) | 同模型集成（3×同一模型）远逊异构议会——模型多样性是收益来源 |
| 交叉批评须 file:line 证据 | [Debate or Vote](https://arxiv.org/abs/2508.17536) 鞅定理 | 辩论期望收益≈0；能约束信念更新方向的只有外部证据 |
| 协调者亲自 read/grep 实证分歧点 | 同上 + [ACPX 方法论](https://casys.ai/blog/acpx-multi-agent-orchestration) | 外部确定性证据打破鞅——**这是本协议的核心收益引擎，不是附属检查** |
| 分层表决（根因=全员非反对；修复=无反对） | [Voting or Consensus](https://aclanthology.org/2025.findings-acl.606/) | 知识型任务共识制更优、推理型投票制更优——根因与修复恰好分属两类，按结论类型分层比按任务类型更细 |
| ≤3 轮预算 | 同文 | 加 agent 优于加轮次；共识制平均 1.42 轮出结论 |
| 僵局不强制收敛、分歧报告交用户 | [Should we be going MAD?（ICML 2024）](https://arxiv.org/abs/2311.17371) + agent-arena | MAD 对超参敏感、常不优于 self-consistency 基线；保留异议优于强行收敛 |
| 保留意见逐字引用、协调者不转述 | 工程实践 | 转述会抹掉少数派信号（Liang et al. 另有警告：裁判对异构辩手可能不公） |
| 盲辩后每轮只发增量材料 | [ChatEval（ICLR 2024）](https://arxiv.org/abs/2308.07201) 通信策略研究 | 通信拓扑影响效果；上下文重放保独立性又省 token |

### 直面反方证据

[Debate or Vote](https://arxiv.org/abs/2508.17536) 证明辩论轮是鞅，那为什么本协议还保留交叉批评轮？因为它在协议里的角色不是"期望上提升正确率"，而是：**暴露分歧点**（给协调者实证指靶）+ **给认输方一个被证据说服的更新机会**——论文自己证明了后半句：朝纠偏方向偏置信念更新（MAD-Follower 类干预）可以超越 vanilla MAD，而 file:line 证据门槛正是这种偏置的最严格形式。

诚实披露：对照实验数据尚待积累——但协议已把"辩论轮的增量收益"变成**可测量的量**：`--mode quick`（R1 盲辩 + 直接表决，约 1/3 成本）就是为这个批评准备的开关。同一问题双跑 quick/full，成本与结论稳定性直接对比，不必信仰任何一方。

## 与近邻的差异

| | 本 skill | [agent-arena](https://github.com/zhjai/agent-arena) | [cross-review](https://www.skillsdirectory.com/skills/dmitriyyukhanov-cross-review) | [sethwebster/consensus](https://github.com/sethwebster/consensus) | [Trail of Bits second-opinion](https://trailofbits.com/skills/second-opinion/) |
|---|---|---|---|---|---|
| 席位 | 3（三宿主：CLI + ACP×2） | 2 | 2 | N（全 CLI） | 2 |
| 盲辩独立作答 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 交叉批评轮 | ✓ ≤3 轮 + 分歧点 | ✓（含证据检查） | ✓（证据裁决） | ✗ 单轮 | ✗ |
| 显式表决协议 | ✓ 分层门槛 | ✗ judge+synthesis | ✗ | ✗ | ✗ |
| 僵局处理 | ✓ 不强制收敛 + 分歧报告 | △ 保留异议 | △ 交用户 | △ Unresolved 段 | ✗ |
| file:line 证据纪律 | ✓ | △ | ✓ | ✗ | ✗ |
| 成本披露 | ✓ 含单 agent 基线 | △ 单调用记录 | ✗ | ✗ | ✗ |
| 审计产物 | events.ndjson + checkpoint | checkpoint | 归档 | ✗ | ✗ |
| 形态 | OpenCode skill（协议 + 可执行编排器） | 协议 skill（自述不含编排器） | Claude Code skill | CLI | Claude/Codex 插件 |

什么时候该用别的：要一个通用的"红队我的方案"协议 skill、且愿意自己编排执行 → agent-arena；要 Claude×Codex 双模型的证据裁决评审 → cross-review；只想并行问一圈 CLI 拿综合答案 → sethwebster/consensus。

## 快速开始

前置：Node ≥ 18；opencode 已安装并登录；（可选）任一 ACP 宿主（dsh / omp）——没有的席位自动按"部分参与降级"缺席。

```sh
git clone https://github.com/github-wyy/consensus.git
# 作为 OpenCode skill 安装（软链或拷贝）
ln -s "$(pwd)/consensus" ~/.agents/skills/consensus
```

配置（可选——默认全部走 PATH 探测 + 宿主默认模型；完整样例见 [config.example.yaml](config.example.yaml)）：

```sh
cp config.example.yaml ~/.config/consensus/config.yaml   # 按需修改
```

席位预检（零 token；`--deep` 对 CLI 席追加最小 prompt 验证 auth）：

```sh
node lib/run.mjs preflight --workspace <你的项目>
```

在 OpenCode 会话里触发：

```
/consensus <你的问题>
/consensus --quick <你的问题>    # 快速基线：盲辩+直接表决，约 1/3 成本
```

产物落盘：`<项目>/.consensus/runs/<ts>/`——`state.json`（checkpoint）、`reports/`（各席各轮报告）、`report.json` / `report.html`（协调者编译）、`events.ndjson`（审计流）。

跑单元测试：

```sh
node --test 'test/*.test.mjs'
```

## 配置参考

配置层级：仓库 `.consensus.yaml` > `~/.config/consensus/config.yaml` > 内置默认（仓库级配置只在可信仓库使用）。

二进制三级解析：env `CONSENSUS_BIN_{OPENCODE,DSH,OMP}` > 配置 `roster[].bin` > PATH 探测。

| 字段 | 默认 | 说明 |
|---|---|---|
| `roster[].model` | `null` | null = 随宿主默认模型；可钉死特定模型 |
| `roster[].bin` | （三级解析） | 手动指定该席二进制路径 |
| `roster[].args` | `[]` | 启动参数（如 omp 的 `--approval-mode always-ask`） |
| `debate.maxRounds` | `3` | 交叉批评轮数上限（含 R1） |
| `debate.confidenceThreshold` | `70` | 任一席置信度低于此触发 R2 |
| `voting.rootCauseRule` | `non-objection` | 根因=全员非反对 |
| `voting.fixRule` | `no-objection` | 修复=无反对，多候选并列 |
| `timeoutPerCallMs` | `600000` | 单次调用超时 |
| `budgetBumpFactor` | `1.5` | budget-starved 重试的预算放宽倍数 |

安全设计：席位 `env` 由代码固定组装（dsh 只读模式 + 凭据运行时从 opencode auth.json 读取），**不接受配置注入**——防任意环境变量进入子进程；凭据不落盘 checkpoint。

## 限制（诚实披露）

- 三个宿主（opencode / dsh / omp）需本地安装；缺席席位如实降级（双共识过渡），不假装等价
- 成本约 3-12 倍单次调用（quick 模式约 1/3）；鞅批评的 quick/full 对照数据尚待积累
- token 计量 best-effort：ACP 席仅在上报过 usage_update 时计入（否则如实缺失）；部分 CLI 通道从事件流解析；oc-spawn 通道无 usage
- 协议文档（SKILL_BODY.md）为中文
- 测试覆盖 diagnose / preflight / checkpoint 纯函数（27 例）；真实三席链路靠 `preflight` + `blind` 冒烟验证

## 路线图

- quick/full 同题对照的实测数据积累（回应 Debate-or-Vote 鞅批评的实证面）
- mABC 式席位权重（分级追问时按历史命中率加权）
- v2 长驻 ACP 会话（省上下文重放 token）

## 致谢

- **[agent-arena](https://github.com/zhjai/agent-arena)**——席位预检、逐轮 checkpoint、error 三分类三项工程纪律直接学自它，"independent heterogeneous agents first, debate later, evidence before consensus, dissent preserved" 的设计哲学与本 skill 共享
- 学术工作（协议依据与被直面的批评）：[Du et al. MAD](https://arxiv.org/abs/2305.14325) / [Liang et al.](https://arxiv.org/abs/2305.19118) / [ReConcile](https://arxiv.org/abs/2309.13007) / [ChatEval](https://arxiv.org/abs/2308.07201) / [MoA](https://arxiv.org/abs/2406.04692) / [Council Mode](https://arxiv.org/abs/2604.02923) / [Debate or Vote](https://arxiv.org/abs/2508.17536) / [Voting or Consensus](https://aclanthology.org/2025.findings-acl.606/) / [Should we be going MAD?](https://arxiv.org/abs/2311.17371) / [MAST](https://arxiv.org/abs/2503.13657) / [mABC](https://arxiv.org/abs/2404.12135)——完整调研（含各近邻工具对比）见 [docs/research/community-prior-art.md](docs/research/community-prior-art.md)

## License

[MIT](LICENSE)
