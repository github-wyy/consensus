# consensus 技能先行工作（Prior Art）调研报告

> 调研日期：2026-10-04
> 调研对象：用户自研 OpenCode skill「consensus」（多 agent 辩论式强共识诊断，用于 bug/根因分析）
> 方法：websearch + webfetch，只采信一手来源（arXiv 原文/会议论文、GitHub README/官方文档、官方博客）；营销文与转述仅作线索

---

## 1. TL;DR 裁决

**思想撞车程度：高。** "多 agent 辩论→共识"自 2023 年起已被学术界充分研究（Du et al. 的 Multiagent Debate、ReConcile 的异构多轮置信度加权投票、ChatEval、MoA），2025-2026 年甚至出现了标题几乎与你技能同名的 Council Mode（arXiv 2604.02923，异构多 agent 共识框架；注意其 v5 已于 2026-09 改题重写为 An Inspectable LLM Council，见 §3.1 勘误）和系统研究表决协议的 Voting or Consensus（ACL 2025）；用于根因分析的多 agent 投票也已有 mABC（EMNLP 2024）。**现成轮子：有近邻、无等价物。** Skill 生态里最接近的是 zhjai/agent-arena（证据优先的多模型辩论 skill，含 `bug_root_cause_arena` 模式、明言"独立异构先行→证据先于共识→保留异议"，且明确支持 OpenCode），其次是 sethwebster/consensus、dmitriyyukhanov/cross-review、Trail of Bits second-opinion 等——但没有任何一个同时具备"三席位三宿主异构 + 盲辩 R1 + 交叉批评须 file:line 证据 + 分层表决规则 + 僵局不强制收敛 + 成本基线披露"的完整协议。**建议：混合路线。** 继续造，但把 agent-arena 当最近邻对标、吸收学术界已验证的结论（表决协议选择、辩论的鞅效应、MAD 失败模式），并明确你真正的差异点（分层表决、中立协调者亲自实证、宿主级异构、成本基线对照、双面报告+审计流）。

---

## 2. 用户技能特性清单（对比基准）

| # | 特性 | 说明 |
|---|------|------|
| F1 | 盲辩 R1 | 三席并行独立作答，任务书只含问题原文+工作区+报告 schema，零他方信息 |
| F2 | 异构模型宿主 | `opencode run` 子进程（CLI 通道）+ 两个 ACP 协议宿主（dsh、omp），刻意选不同模型防趋同 |
| F3 | 交叉批评须 file:line 证据 | ≤3 轮，认输须说明被哪条证据说服，反驳须带 file:line 证据；协调者同时用 read/grep 亲自实证分歧点 |
| F4 | 分层表决规则 | 根因=全员非反对才通过；修复方案=无反对即可、允许多候选并列；反对无证据降级为保留 |
| F5 | 僵局不强制收敛 | 轮数耗尽不强行收敛，输出已共识部分+分歧报告交用户裁决 |
| F6 | 只读代码库实证 | 调查员只读权限策略：拒写文件、bash 只读白名单 |
| F7 | 成本披露 | 调用数/token/耗时 + 单 agent 基线对照 |
| F8 | 可直接装入 OpenCode | 以 skill 形式运行于 opencode 主会话（中立主持人只调度/汇总/实证） |
| F9 | 双面报告落盘 | 会话 markdown + HTML 短幻灯片 deck（封面/结论与证据/辩论过程/分歧与保留/修复/成本，空页自动跳过）+ report.json + events.ndjson 审计流 |
| F10 | 其他纪律 | 六字段结构化报告（假设集/根因/证据/置信度%/修复草案/开放疑虑）；保留意见逐字引用；分级追问（新信息才触发定向增量辩论） |

---

## 3. 学术先行工作

### 3.1 Council Mode（2026）——标题最接近的"直接同名"先行者

- **名称/年份**：Council Mode: A Heterogeneous Multi-Agent Consensus Framework for Reducing LLM Hallucination and Bias，arXiv 2604.02923，2026-04。https://arxiv.org/abs/2604.02923
- **⚠️ 版本勘误（核对时发现）**：本条描述的是 **v4（2026-07-05，已核实原文）**。作者于 2026-09-26 发布 **v5，已改题重写**为《An Inspectable LLM Council for Multi-Model Research Answer Aggregation》——同一作者团队，但实验换成 DRACO 基准、架构改为 analyst+writer 两阶段综合（ Council 70.98 分 vs GPT/Gemini +6.18/+8.34，vs Claude 差 0.47 无显著差异）。引用时应以 v5 为准并注明 v4 曾用名；下面协议细节为 v4 内容。
- **协议摘要**：三阶段管线——① Triage 分类器按查询复杂度分流（平凡问题绕过议会）；② 并行专家生成：N=3 家**不同提供商的前沿模型**（GPT-5.5、Claude Opus 4.8、Gemini 3.1 Pro）独立作答；③ 结构化共识综合：专用综合模型（GLM-5.2，1M 上下文）按 16 条强制规则聚合，输出分为 Model Consensus / Model Disagreement / Unique Findings / Comprehensive Analysis 四节。**刻意采用单轮并行架构**（作者明言：相比 MoA 的多层迭代"避免跨层延迟复合"），用"声明级分析"取代多数投票。
- **关键数据**：HaluEval 幻觉率相对降低 41.7%；TruthfulQA +7.5 分；自建 MDR-500 质量分 95.4%（超最佳单模型 9.2 分）；**token 成本 4.2×**；消融实验：同模型集成（3×GPT-5.5）远逊异构议会——异构性是收益来源。
- **与用户技能重合点**：三席异构并行独立作答（≈F1 盲辩+F2 模型异构）；输出保留分歧与少数观点（≈F5 的"不抹平分歧"精神）；成本开销披露（≈F7）。
- **缺什么**：无交叉批评轮（单轮综合，辩手之间互不见对方论证后的再交锋）；无表决协议（综合模型独断）；无代码库/file:line 证据要求；无僵局处理；非 skill 形态（论文+参考实现，面向问答/事实性而非 bug 诊断）。

### 3.2 ReConcile（2023/ACL 2024）——最接近的经典先行工作

- **名称/年份**：ReConcile: Round-Table Conference Improves Reasoning via Consensus among Diverse LLMs，Chen et al.，arXiv 2309.13007，ACL 2024。https://arxiv.org/abs/2309.13007 ｜代码 https://github.com/dinobby/ReConcile
- **协议摘要**：多模型多 agent 圆桌会议——各 agent 先独立生成答案+置信度+CoT 解释；随后多轮讨论，每轮每 agent 看到**其他所有 agent 的答案、解释、置信度**及"答案修正类人类示范"，学习说服他人；共识达成（全员同答案）或轮数上限后，用**置信度加权投票**产出团队答案。
- **与用户技能重合点**：异构模型（ChatGPT/Bard/Claude2，可换 GPT-4/LLaMA-2/DeepSeekMath）+ 多轮交叉说服 + 置信度加权表决——这就是用户六阶段协议的"R1 独立作答→交叉批评→表决"骨架，2023 年已定型；作者证明"模型多样性是性能提升的关键"（直接支持用户刻意选不同模型）。
- **缺什么**：目标是封闭式推理题（数学/常识/NLI），不是代码库 bug 诊断；无 file:line 证据纪律；置信度是模型自报（Du et al. 证明 LLM 自报置信度往往虚高）；表决是单一门槛的加权投票，无"根因 vs 修复方案"分层规则；无只读代码库实证、无成本基线、无审计流。

### 3.3 Du et al. Multiagent Debate（2023/ICML 2024）——MAD 开山之作

- **名称/年份**：Improving Factuality and Reasoning in Language Models through Multiagent Debate，arXiv 2305.14325，ICML 2024。https://arxiv.org/abs/2305.14325
- **协议摘要**：多个 LLM 实例先各自作答，然后每轮把他人回答拼进上下文更新自己的答案，多轮后"群体几乎总是收敛到单一且更准确的共识答案"；总结他人回答可进一步提效。主体实验用**同模型多实例**，附 chatGPT×Bard 跨模型小实验（联合辩论 17/20 > 单模型 14/20 或 11/20）。
- **与用户技能重合点**：R1 独立作答→多轮互评→收敛的完整原型。
- **缺什么**：同模型为主（正是用户设计要防的"同模型趋同"）；无表决（靠收敛）；作者观察到"不确定的事实上各 agent 答案分歧，辩论总使 agent 改变立场收敛到某一个事实——不一定正确"（这句是后续批评文的种子）。

### 3.4 Liang et al. MAD / 发散思维（2023/EMNLP 2024）——含"裁判不公"警告

- **名称/年份**：Encouraging Divergent Thinking in Large Language Models through Multi-Agent Debate，arXiv 2305.19118，EMNLP 2024。官方实现即 Skytliang/Multi-Agents-Debate。https://arxiv.org/abs/2305.19118 ｜https://github.com/Skytliang/Multi-Agents-Debate
- **协议摘要**：两辩手（天使/魔鬼"针锋相对"）+ 裁判；裁判有两种模式——判别式（本轮是否已可得解，自适应提前终止）与抽取式（超轮数后强制从辩史抽答案）。定义 Degeneration-of-Thought（DoT）问题：自我反思一旦建立自信就无法产生新思路。
- **与用户技能重合点**：反 DoT 动机即用户盲辩+异构的动机之一；裁判自适应终止 ≈ 用户"条件触发"思想。
- **缺什么/重要警示**：作者实证"适度针锋即可、必须每点都反对反而两极分化"；**"若辩手用不同 LLM，LLM 裁判可能不公平"**——直接警示用户"协调者中立主持人"角色的实现难度（你的协调者不下场辩论+亲自实证是对症的，但需注意综合/表决阶段对自家文本的隐性偏好）。

### 3.5 Debate or Vote（NeurIPS 2025 Spotlight）——必须直面的反方证据

- **名称/年份**：Debate or Vote: Which Yields Better Decisions in Multi-Agent Large Language Models?，Choi/Zhu/Li（UW-Madison），NeurIPS 2025 Spotlight，arXiv 2508.17536。https://arxiv.org/abs/2508.17536 ｜代码 https://github.com/deeplearning-wisc/debate-or-vote
- **核心结论**：把 MAD 拆成"多数投票"与"辩论"两个成分，7 个基准上**多数投票贡献了 MAD 的大部分收益，多数情况下无辩论的投票与 MAD 打平**。理论上将辩论建模为 Dirichlet-Compound-Multinomial 贝叶斯更新过程，证明 agent 对正确答案的信念是**鞅**——辩论本身不改变期望正确率（纠偏与被带偏对称）。干预实验：让 agent 以 30% 概率采纳上一轮多数答案（MAD-Follower）等"朝纠偏方向偏置"的修改可超越 vanilla MAD。
- **对用户技能的含义**：你的"交叉批评轮"若只是嘴仗，学术证据说它期望收益≈0。你的设计中真正对症的是：**协调者用 read/grep 亲自实证分歧点**（引入外部确定性证据=打破鞅）、file:line 证据强制（约束信念更新方向）、以及"盲辩 R1 之后的独立多样本"本身（投票收益来源）。建议：考虑内置一个廉价的"仅 R1+表决"模式作为基线（Council Mode 亦是单轮派）；把实证环节视为协议的核心收益引擎而非附属检查。

### 3.6 Voting or Consensus（ACL 2025 Findings）——表决协议的系统研究

- **名称/年份**：Voting or Consensus? Decision-Making in Multi-Agent Debate，Kaesberg et al.（lkaesberg/decision-protocols 为其官方仓库），ACL 2025 Findings，arXiv 2502.19130。https://aclanthology.org/2025.findings-acl.606/ ｜https://github.com/lkaesberg/decision-protocols
- **协议摘要/结论**：控制变量对比 7 种决策协议（简单/排名/累积/赞成投票 4 种投票制；多数/绝对多数/一致同意 3 种共识制）。**知识型任务共识制更优（+2.8%，一致同意对"不可回答"样本尤其强）；推理型任务投票制更优（+13.2%）**。共识制平均 1.42 轮出结论、投票制 3.38 轮。**增加 agent 数量提升性能，投票前增加讨论轮次反而降低性能**（疑似 problem drift）。提出 AAD（各 agent 交互前独立起草）与 CI（限制通信提升答案多样性），分别 +3.3%/+7.4%。
- **对用户技能的含义**：① 你的场景（根因诊断=知识型+推理型混合）用"根因=全员非反对（近似一致同意）、修复方案=无反对即可"的**分层门槛**与该文"按任务类型选协议"的结论方向一致，且比它更细（按结论类型而非任务类型分层——这是先行工作里没有看到的）；② "≤3 轮"与"多 agent 优于多轮次"结论吻合；③ AAD=你的盲辩 R1 的学术对应物，有 +3.3% 的实证支持。

### 3.7 Should we be going MAD?（ICML 2024）——MAD 批评文

- **名称/年份**：Smit et al.（InstaDeep），ICML 2024，arXiv 2311.17371。https://arxiv.org/abs/2311.17371
- **核心结论**：原始实现的 MAD 系统**并不能稳定超过 self-consistency / 集成等非辩论基线**，且对超参高度敏感；但通过提示调节"agent 间同意强度"（agreement intensity）可使 Multi-Persona 从最差变最佳。MAD 的 API 调用更多、token 与成本更高。
- **对用户技能的含义**：用户设计中"盲辩（独立性）+异构模型+不强制收敛"防"过早收敛/趋同/同模型退化"的三板斧与本文及 Debate or Vote 的批评方向一致；"同意强度"提示工程是可直接借鉴的调参手段（防止三席过快和解或永不和解）。

### 3.8 MAST：Why Do Multi-Agent LLM Systems Fail?（NeurIPS 2025 D&B）——失败模式分类学

- **名称/年份**：Cemri et al.（Berkeley/字节等），NeurIPS 2025 Datasets & Benchmarks，arXiv 2503.13657。https://arxiv.org/abs/2503.13657 ｜https://github.com/multi-agent-systems-failure-taxonomy/MAST
- **核心结论**：1600+ 标注 trace、14 种失败模式分 3 类：系统设计问题（违规/重复/上下文丢失）、**agent 间失配**（错误假设继续跑、任务脱轨、隐瞒信息、忽略他人输入、言行不一）、**任务验证不足**（过早终止、无/不完整验证、错误验证）。关键洞察：仅靠最终阶段低层校验不够，**需要多层验证**；"verify 器存在不是银弹"。
- **对用户技能的含义**：为你的六阶段纪律提供了分类学背书——协调者亲自实证、file:line 证据、反对无证据降级为保留，正是对 FC2（inter-agent misalignment）与 FC3（verification）的针对性设计。报告里引用 MAST 可增强说服力。

### 3.9 mABC（EMNLP 2024 Findings）——RCA 场景的多 agent 投票先行者

- **名称/年份**：mABC: Multi-Agent Blockchain-inspired Collaboration for Root Cause Analysis in Micro-Services Architecture，arXiv 2404.12135。https://arxiv.org/abs/2404.12135 ｜https://github.com/zwpride/mABC
- **协议摘要**：微服务根因分析。7 个专业 agent（告警接收/调度/数据侦探/依赖探索/概率神谕/故障映射/方案工程师）沿 Agent Workflow 协作；**区块链式投票**：任一 agent 的答案可被链上其他 agent 发起投票（For/Abstain/Against），按贡献指数×专业指数加权，票未过则答案重新生成。
- **与用户技能重合点**：RCA 场景 + 多 agent + For/Abstain/Against 三态投票——与你的"同意/反对/保留"表决几乎同构（且早两年）。
- **缺什么**：权重靠历史表现累积（适合长期运行系统而非单次诊断会话）；无盲辩、无异构模型宿主、无 file:line、无僵局降级（未过票就无限重答）；非 skill 形态。

### 3.10 2025-2026 多 agent RCA/SRE 论文群（思想同域、形态不同）

均为多 agent LLM 做根因分析/事件响应的近期工作，但走的是"编排/工具/搜索"路线而非"辩论+表决"路线：

- **Flow-of-Action**（WWW Companion 2025，arXiv 2502.08224）：SOP 约束的 ReAct 多 agent（MainAgent+辅助 agent），SOP 流程+动作集机制抗幻觉，RCA 准确率 35.5%→64.0%。https://arxiv.org/abs/2502.08224
- **LATS-RCA**（2026，arXiv 2605.03505）：把 RCA 形式化为反思引导的树搜索（MCTS+LLM 反思），LO2 基准 91.3% vs 单 agent ReAct 39.8%；生产环境降至 60-70%，单事件平均 75 次 API 调用/220K token/13 分钟（成本披露的好范例）。https://arxiv.org/abs/2605.03505
- **OpsHarness**（2026，arXiv 2608.25661）：自进化 RCA 外壳，兼容通用 agent（Codex/Claude Code）而非重造专用 agent，强调把经验沉淀为可复用知识；59.0% top-1，比裸通用 agent +63.4%。https://arxiv.org/abs/2608.25661
- **GALA**（ASE 2026，arXiv 2608.08968）：图增强 LLM agent，服务依赖图约束探索、多模态证据定位。https://arxiv.org/abs/2608.08968
- **KRCA**（快手，2026，arXiv 2607.01788）：主从多 agent+分层记忆+RAG 验证因果，生产部署 6 个月、诊断时间 -77.3%。https://arxiv.org/abs/2607.01788
- **Graph Traversal Agent**（2026，arXiv 2606.08590）：明确综述了 mABC（投票）、STRATUS、Flow-of-Action，并引 MAST 与"cloud-RCA 专项失败分析（arXiv 2602.09937：agent 在 cloud RCA 上系统性失败于不完整探索与幻觉证据解读）"，其立场是"验证与审计是暴露失败模式的机制，而非多 agent 架构天然优越的证据"——与 Debate or Vote 呼应。https://arxiv.org/abs/2606.08590

### 3.11 其他经典（简要）

- **ChatEval**（ICLR 2024，arXiv 2308.07201）：多 agent 辩论做文本评估；**多样性 persona 必要——同一角色描述会退化**；通信策略（one-by-one/同时/带总结器）影响效果。https://arxiv.org/abs/2308.07201
- **Exchange-of-Thought**（EMNLP 2023）：跨模型通信四范式（Memory/Report/Relay/Debate，对应总线/星/环/树拓扑）+ 置信度评估抗错误推理链传染；多数共识终止。https://aclanthology.org/2023.emnlp-main.936/
- **Mixture-of-Agents**（Together AI，ICLR 2025，arXiv 2406.04692）：分层 proposer→aggregator 迭代聚合，"LLM 的协作性"现象（看到他模型输出会变好，即使对方更弱）；**异构模型输出贡献显著大于同模型**。https://arxiv.org/abs/2406.04692 ｜https://github.com/togethercomputer/moa
- 通用框架（AutoGen/LangGraph/CrewAI/AgentVerse/MetaGPT/ChatDev）：提供多 agent 编排原语（会话图、角色、子 agent），**辩论/表决/共识协议需自行实现**，均非"装上即用的共识诊断 skill"（AgentVerse 论文里实现过 MAD 模式，ChatDev 有程序员-评审员对抗角色，属框架内示例而非可复用协议）。

---

## 4. 开源工具

### 4.1 rahultapase/llm-consensus ——"LLM 议会"Web 应用（重点核实）

- **链接**：https://github.com/rahultapase/llm-consensus （MIT，4★，18 commits，2026）
- **协议**：三阶段——① First opinions：查询并行发给 2-5 个 OpenRouter 模型，各自独立作答（≈盲辩 R1）；② Review：每个 LLM 看到**匿名化**的其他 LLM 回答（防偏袒），按准确性与洞察排名；③ Final response：指定"主席"模型综合全部回答与同行排名产出最终答案。
- **与用户技能重合点**：独立首答（F1）、多模型异构（模型层 F2 的简化版）、匿名互评、主席综合（=不投票的 Council Mode 式收敛）。
- **缺什么**：无多轮交叉批评（一轮排名即止）、无表决、无僵局处理、无代码库/证据概念（纯问答场景）、无成本披露、Web 应用形态（Next.js+FastAPI+Supabase，需自部署），**不可装入 OpenCode**。定位：与 Council Mode 论文同构的社区玩具实现，证明"议会"模式已民间复刻。

### 4.2 ACPX（openclaw/acpx）——ACP 协议层多 agent 编排（重点核实）

- **链接**：https://acpx.sh/CLI.html ｜casys.ai 三篇官方博文（2026-05~08）：https://casys.ai/blog/acpx-multi-agent-orchestration 、https://casys.ai/blog/multi-agent-workflows-without-the-bill
- **能力**：headless ACP 客户端：结构化 JSON-RPC 会话（session new/ensure/resume）、命名会话按 (agent 命令, cwd, name) 作用域、提示队列、协作取消、权限模式（默认批准读、非交互拒绝）、`--no-fs` 能力开关、文本/JSON/quiet 输出。内置 adapter 覆盖 Codex/Claude/Gemini/OpenCode 等 15+。`compare` 子命令串行跑多个 agent 并输出 wall_ms/状态/token 字段的机器可比记录——**这是工具层最接近用户"成本披露+基线对照"的东西**。
- **方法论文（casys.ai）与用户协议的直接呼应**："Multi-agent orchestration is not a model tournament. It is a control loop: one orchestrator defines the work, bounded workers execute it, evidence gates the result"——六阶段工作流（Orchestrate→Contract→Execute→**Prove**→Review→Merge），证据分层表（ACP NDJSON 证明客户端观察过什么、**不证明 worker 陈述为真**；git diff 证明改了什么、不证明改对了）；"Treat every worker verdict as an unverified claim"、"model diversity is not proof by itself; the reviewer needs the same base commit, contract, diff, and evidence, and its findings need reproduction too"。
- **与用户技能重合点**：ACP 多宿主调用（=你 dsh/omp 通道的生态基础）、只读权限模式（F6）、结构化会话与审计（F9 的雏形）、compare 成本记录（F7 的雏形）、"worker 结论=未验证断言"的实证纪律（F3 协调者亲自实证的同款哲学）。
- **缺什么**：无辩论/表决/共识协议（纯传输与编排层）；Casys-AI 的配套 skill（agentic-procedures 的 `pair-codex`/`acpx-workflows`，含"multi-axis review/audit, find→verify, adversarial verify"模式）最接近但仍以工作流而非表决协议为核。

### 4.3 omux ——注意：任务书中的描述无法核实（重点核实，结论为"张冠李戴"）

任务书称"omux（sst/opencode 生态的 ACP 多代理终端，quad/pair/review 模式——代理互相批判）。**查证结果：不存在这样的 omux。** 实际存在的是：

- **Happenmass/omux**（94★，v4.0.0，2026）：tmux 元 agent，编排 Claude Code/Codex 并行执行；v3.0 起主打**跨厂商 execute-then-review**（Claude 实现、Codex 独立审查 diff，角色可互换），卖点即"Fresh eyes can't come from the same head"——同上下文自我审查有锚定偏置，异厂商冷读审查才是结构上无法被同会话替代的校验。含 MainAgent 按适配器特长路由、状态正则检测+廉价 LLM 兜底分类。https://github.com/Happenmass/omux
- **finger-gun/omux（OpenMUX）**（10★）：macOS 原生终端工作区（工作区/分屏/插件/Agent Sessions，支持 OpenCode/KiloCode/OMP 会话索引），无辩论协议。https://github.com/finger-gun/omux
- 真正的"ACP 多代理终端三层栈"（Daniel Vaughan，2026-04）：**cmux**（视觉层，macOS 终端，13.3k★）+ **ACPX**（协议层）+ **OMX**（编排层，Oh My codeX，19.6k★，Codex 包装：`$ralplan` 共识规划带权衡分析、`$team N:executor` 并行执行、33 个专项 agent prompt）。https://codex.danielvaughan.com/2026/04/09/cmux-acpx-omx-three-layers-multi-agent-ux/
- OpenCode 生态内真正对应"多模型 agent 编排"的是 **oh-my-openagent（OmO，37.6k★）**：OpenCode 插件，11 个专家 agent 跨 Claude/GPT/Gemini/Kimi/GLM 路由，`review-work` skill 是 5 agent 并行评审（全票 PASS 才过，含 INCONCLUSIVE 态）。https://github.com/zhjai/agent-arena 的对照表及 the4thpath 评论：https://www.the4thpath.com/2026/03/oh-my-openagent-omo-full-review-multi.html
- **结论**：用户记忆中的"omux quad/pair/review"大概率是 omux/OMX/omo/cmux 几个名字的混淆。最接近"代理互相批判"的实为 Happenmass/omux 的 execute-then-review（两席单向）与 OmO review-work（5 席全票门）。

### 4.4 claude-squad / vibe-kanban ——并行会话管理器，无辩论协议

- **claude-squad**（AGPL-3.0）：tmux+git worktree 多 agent 并行会话 TUI，每个 agent 独立 worktree。https://github.com/smtg-ai/claude-squad
- **vibe-kanban**（BloopAI，Apache-2.0，~27k★；公司 2026-04 关闭后社区维护、纯本地）：kanban 板+每卡一 workspace 一 agent，10+ agent 支持（含 OpenCode）。https://github.com/BloopAI/vibe-kanban
- **判断**：均为"并行跑多个 agent + 人工审查 diff"的**会话隔离器**，agent 之间零辩论、零表决、零共识机制。与用户技能不同层。

### 4.5 代码评审向多 agent 工具（协议近邻）

- **umputun/revmux**：多 agent 代码评审，find（多个 claude 并行+codex 同侪，**刻意不让 codex 看到前者结果以防锚定**）→ synthesize（按 (file, line±2) 去重，**多源相互印证提升置信度**）→ verify（按目录分组的验证 agent，结论含 confirmed/refined/rejected/immaterial/pre-existing）；全程归档（每个 agent 的完整 prompt、逐字输出、每阶段 findings、重试决策）可审计；以 Claude Code/Codex skill 双形态发布。https://github.com/umputun/revmux
- **spencermarx/open-code-review**（301★）：8 阶段多 agent 代码评审（并行独立评审→聚合→**Discourse**：AGREE/CHALLENGE/CONNECT/SURFACE 四种固定回应类型，被挑战且未辩护的发现降置信度，多数 AGREE 升置信度→综合）；28 个 persona、多模型团队、冗余评审；**明确兼容 Claude Code/OpenCode/Cursor（tags: opencode, claude-skills）**。https://github.com/spencermarx/open-code-review
- **判断**：这两个是"评审场景"里离用户协议最近的工程实现（独立首答+交叉挑战+置信度调整+审计），但目标函数是"找 code 问题"而非"根因共识"；表决是置信度数值调整而非显式分层规则；无僵局协议。

---

## 5. Agent Skill 生态：现成同功能 skill 有没有？

**结论：有高度近邻（agent-arena），无完整等价物。** 以下按接近度排序：

### 5.1 zhjai/agent-arena ——最近的现成轮子（重点）

- **链接**：https://github.com/zhjai/agent-arena （MIT，25★，v0.2.8，2026；中英双语）
- **定位**："Evidence-first multi-agent debate skill: get a second opinion by pitting Codex × Claude Code (or GLM/DeepSeek/Qwen) to independently review, red-team & judge high-stakes code and architecture decisions."
- **协议**（skill 形式，面向 Claude Code/Codex/OpenCode/OpenClaw/Copilot 等）：核心口号 **"independent heterogeneous agents first, debate later, evidence before consensus, dissent preserved"**——与用户共识技能的设计哲学几乎逐字相同。`full_arena` 模式 = 独立生成 → 声明抽取 → **证据检查** → 批评 → 修订 → **盲评** → 综合。专门有 **`bug_root_cause_arena`（比较根因假设与决定性检查）** 模式。十项核心原则包括：讨论前独立性（agent 必须先产出初始答案再看他人）、**证据高于共识（LLM 互相同意不是证明）**、确定性检查高于模型判断（测试/源码/文档/日志/基准 > 观点）、异构必须是真的（不同模型家族/harness/工具/prompt/证据路径；明确支持 GLM/DeepSeek/Qwen 等替代后端）、**不强制共识（不确定时保留强少数意见）**、暴露异议（最终答案必须含最佳反驳）、诚实降级、按风险选模式、高风险人类检查点、上下文最小化但不致盲。
- **工程纪律值得借鉴**：participant_route 预检（command -v + 最小无害调用+模型家族校验）、`.arena/config.yaml`+逐轮 checkpoint（run_state/blocking_findings/open_disagreements/retry 预算）、`error_max_turns` 的完整诊断分类（启动失败 vs 预算饥饿 vs 结构性故障；一次无损自动重试、有损动作必须用户批准）、协调者侧上下文预算（大输出落盘+读回结构化摘要，防 compaction 循环）、隐私与只读权限模式（`--permission-mode plan --allowedTools 'Read,Glob,Grep'`）。
- **与用户技能重合点**：F1（独立性明文）、F2（真异构，且比用户更进一步——harness 层+模型层都要求）、F3 部分（证据高于共识+groundcheck 预检事实门）、F5（不强制共识+保留异议）、F6（只读权限模式）、F8（明确支持 OpenCode）。
- **缺什么**：以**双席位**（Codex×Claude）为主而非三席位；无显式表决协议（judge+synthesis 收尾）；无分层门槛；无成本基线对照（只记录单次调用 duration/cost）；无 HTML 双面报告/审计流；无分级追问。另注意：它是**协议 skill 而非可执行编排器**（自述"does not install, authenticate, or automatically call external agents"），落地仍靠宿主 agent 执行。

### 5.2 sethwebster/consensus ——同名 CLI+skill

- **链接**：https://github.com/sethwebster/consensus
- **协议**：把一个 prompt 并行 fan-out 给机器上所有 AI CLI（claude/codex/gemini/cursor-agent/**opencode**/ollama），复用各 CLI 已有登录，再由指定模型综合为单一答案；综合文本可带 **Dissent（少数派论证）/Unresolved（无多数）** 段，要求"永远显式呈现，不许静默丢弃"。支持 `--no-synth`（只拿原始独立答案）、`--cwd`（带入项目上下文或隔离）、`-o` 落盘完整转录。
- **与用户技能重合点**：F1（并行独立）+F2（全 CLI 面板，含 opencode）+F5 的异议保留（Dissent/Unresolved 段）；任何能跑 shell 的 agent（含 OpenCode）都能驱动它。
- **缺什么**：单轮 fan-out，无交叉批评轮、无表决、无证据纪律、无僵局处理（Unresolved 即终点）、无成本对照。

### 5.3 dmitriyyukhanov/cross-review ——证据优先的双模型裁决

- **链接**：https://www.skillsdirectory.com/skills/dmitriyyukhanov-cross-review （Claude Code skill）
- **协议**：Claude 与 Codex **同时独立**评审（"Neither model sees the other's review until triage"）；分歧三段解决：triage → 交叉验证（**每个模型验证对方的单源发现**，CONFIRM/REJECT/REFINE 须带代码证据）→ 证据研究（文档/代码检查，"resolved-by-evidence 须引用来源：doc URL、**code file:line**"）；仅真正无法裁决的分歧升级用户；循环直到干净或达轮上限。
- **与用户技能重合点**：F1+F2+F3（file:line 级证据裁决）+F5 的"不可裁决交用户"；明文规则"Do NOT resolve disagreements by opinion"。
- **缺什么**：双席位；无显式表决（证据裁决替代）；目标是"评审已有工作"非根因诊断；无成本披露/审计流。

### 5.4 其他生态位内 skill（简要，均有可验证 README/SKILL.md）

| Skill | 一句话定位 | 与共识技能的距离 |
|---|---|---|
| **Trail of Bits second-opinion**（https://trailofbits.com/skills/second-opinion/） | Claude Code 官方级插件：并行跑 Codex/Gemini CLI 独立评审 diff，side-by-side 呈现，"where they agree, findings are higher confidence"；Codex `--sandbox read-only` | 独立+只读+并行，但无辩论轮无表决，评审专用 |
| **AlessioZazzarini/debate-kit**（https://github.com/AlessioZazzarini/debate-kit） | "Cross-model adversarial review skill：spawn 外部 LLM 挑战你的 plans、bug diagnoses、代码" | 有对抗批评，无双向辩论/表决 |
| **amElnagdy/review-skills（debate-review）**（https://github.com/amelnagdy/review-skills） | 两模型对 PR 辩论：主评审→第二评审驳斥→主评审终裁；幸存发现 posted as agreed，被驳但坚持的 posted as **contested（附双方理由）**；relays 强制 `--read-only` | 双席辩论+只读+同意/争议两级结论，但面向 PR 评审 |
| **craigkitterman/cross-model-code-review-skill** | 多模型冗余评审+共识矩阵（Claude/Codex/Gemini 逐域打分，spread>2 预警）+置信度分级（2+ 模型同发现=HIGH）+迭代至共识批准（≤3 轮） | 共识矩阵+置信度分级+迭代门槛，评审场景 |
| **wenyuChiou/agent-collab-skills（agent-debate）**（https://skillsmp.com/creators/wenyuchiou/agent-collab-skills/skills-agent-debate） | 有界对抗评审：独立 reviewer 钢人各自立场、无工具 synthesizer 对比证据、人类决策者终裁；**明文禁止"多数投票作为证据或验收机制"** | 反表决路线的哲学对照组（值得在报告中引用其论点） |
| **parlance-labs/super-oracle**（https://github.com/parlance-labs/super-oracle） | Claude/Codex/OpenCode 三方同题评审→各自对照他人报告做一轮精炼（只保留能支撑的发现）→一方综合；DEGRADED 标记不视为收敛 | 三席独立+一轮交叉+综合，无表决无僵局协议 |
| **bayramannakov/agent-tower-plugin**（skills.sh） | /tower:council"多 agent 议会：并行意见+综合"，可配置共识阈值/轮数/角色 | 议会形态，协议细节薄 |
| **judge-with-debate**（mcpmarket） | 三独立裁判 agent 多轮辩论至加权共识，评分须带代码引用 | MAD 模式直接移植，面向评估 |
| **pmatos/skills（codex-2nd-opinion）** | Codex 第二意见：结构化对比（同意点/分歧点/诚实评估/建议路径） | 单对单对照 |
| **obra/superpowers**（https://github.com/obra/superpowers） | 大型工程技能库（本仓库已收录）；**没有**跨模型共识/辩论 skill——issue #730（2026-03，已核对）"Cross-model collaboration via external CLI tools for review and second opinions"：评审管线与实现同模型家族="带额外步骤的自我评审"，请求外部异构模型第二意见，**状态为 Closed as not planned**（维护者不打算实现）——需求真实存在、且最大技能库明确不打算填补 | 官方生态位空缺的直接证据（比"开放请求"更强：被明确拒绝，缺口由设计保留） |

---

## 6. 对比总表

✓=具备；△=部分具备/变体；✗=不具备。列=用户技能关键特性。

| 先行工作 | 盲辩R1 | 异构模型宿主 | 交叉批评须file:line | 分层表决规则 | 僵局不强制收敛 | 只读代码库实证 | 成本披露 | 可直接装入OpenCode |
|---|---|---|---|---|---|---|---|---|
| **用户 consensus skill** | ✓ | ✓（CLI+ACP×2 三宿主） | ✓ | ✓（根因/修复两级） | ✓ | ✓ | ✓（含单agent基线） | ✓ |
| Du et al. MAD 2023 | ✓ | ✗（同模型为主） | ✗ | ✗ | ✗（总收敛） | ✗ | ✗ | ✗ |
| Liang et al. MAD 2023 | ✓ | △（同 backbone 最佳） | ✗ | ✗（裁判自适应终止） | △ | ✗ | ✗ | ✗ |
| ReConcile 2023/24 | ✓ | ✓（模型层） | ✗ | △（置信度加权，单一门槛） | ✗ | ✗ | ✗ | ✗ |
| ChatEval 2024 | ✗ | △（persona） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Exchange-of-Thought 2023 | ✓ | ✓ | ✗ | △（置信度） | △ | ✗ | ✗ | ✗ |
| MoA 2024/25 | ✓（首层独立） | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Should we be going MAD 2024 | —（评估研究） | — | — | — | — | — | △（成本对比） | ✗ |
| mABC 2024 | ✗ | ✗ | ✗ | △（For/Abstain/Against 加权，单一门槛） | ✗（未过票重答） | ✗ | ✗ | ✗ |
| Debate or Vote 2025 | —（反方证据：辩论≈鞅） | — | — | — | — | — | — | ✗ |
| Voting or Consensus 2025 | ✓（AAD） | ✗ | ✗ | △（7 协议含一致同意，按任务类型） | △（approval voting 59% 无结论） | ✗ | ✗ | ✗ |
| MAST 2025 | —（失败模式分类学） | — | — | — | — | — | — | ✗ |
| **Council Mode 2026** | ✓（并行独立） | ✓（三家前沿模型，API 层） | ✗（无交叉轮） | ✗（综合非表决） | △（分歧/独特发现保留于输出） | ✗ | ✓（4.2× 分析） | ✗ |
| Flow-of-Action / LATS-RCA / OpsHarness 等 2025-26 | ✗ | ✗ | ✗ | ✗ | ✗ | △（只读证据收集） | △（LATS-RCA 报 API/token/分钟） | ✗ |
| llm-consensus | ✓（Stage1） | ✓（OpenRouter 多模型+匿名评审） | ✗ | ✗（主席综合） | ✗ | ✗（无代码库概念） | ✗ | ✗（Web 应用） |
| **ACPX** | △（exec 独立会话） | ✓（15+ adapter） | ✗ | ✗ | ✗ | ✓（权限模式） | ✓（compare: wall_ms/token） | △（CLI，可被 skill 驱动） |
| Happenmass/omux | △ | ✓（claude+codex） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗（独立工具） |
| OmO (oh-my-openagent) | ✗（内部编排） | ✓（多模型路由） | ✗ | △（review-work 全票门） | ✗ | ✗ | △（token 消耗警示） | ✓（OpenCode 插件） |
| claude-squad / vibe-kanban | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗（会话管理器） |
| revmux | ✓（finders 互不见） | ✓（claude+codex） | △（verify 阶段证据） | ✗（synthesis） | △（verdicts 含 rejected） | ✓ | △（归档可复盘） | △（Claude/Codex skill） |
| open-code-review | ✓（Phase4 独立） | △（多模型可选） | ✗ | △（置信度调整） | ✗ | ✗ | ✗ | △（OpenCode 兼容） |
| **agent-arena** | ✓（明文原则#1） | ✓（真异构+替代后端） | △（证据高于共识+groundcheck） | ✗（judge+synthesis） | ✓（保留异议） | ✓（只读权限模式） | △（单调用 duration/cost） | ✓（明文支持） |
| sethwebster/consensus | ✓ | ✓（全 CLI 含 opencode） | ✗ | ✗ | △（Dissent/Unresolved 段） | ✗ | ✗ | △（shell 可驱动） |
| cross-review | ✓ | ✓（Claude+Codex） | ✓（resolved-by-evidence 引 file:line） | ✗（证据裁决） | △（needs-decision 交用户） | ✓ | ✗ | △（Claude Code skill） |
| Trail of Bits second-opinion | ✓（并行） | ✓（Codex+Gemini） | ✗ | ✗ | ✗ | ✓（read-only sandbox） | ✗ | △（Claude/Codex 插件） |

**读表结论**：没有任何一行打满。学术侧最接近的是 Council Mode（盲辩+异构+成本，但无批评轮/表决）与 ReConcile（骨架全但无证据纪律/分层）；工具/skill 侧最接近的是 **agent-arena**（8 项中 4✓2△）与 **cross-review**（file:line 证据纪律最完整但双席位无表决）。用户技能的组合（尤其 F3+F4+F7+F9 的组合）在全部先行工作中未出现。

---

## 7. 结论与建议

### 7.1 值得从先行工作借鉴的协议细节

1. **直面 Debate or Vote 的鞅定理**（https://arxiv.org/abs/2508.17536）：纯辩论轮不提升期望正确率。你的"协调者亲自实证分歧点"是对症设计（外部确定性证据打破鞅），建议把它在文档里升格为协议的核心收益引擎，并考虑内置"R1+表决"廉价基线模式（也是 Council Mode 的单轮路线），让用户能按成本选择。
2. **Voting or Consensus 的协议选择结论**（https://aclanthology.org/2025.findings-acl.606/）：知识型用共识、推理型用投票；**加 agent 优于加轮次**；AAD（交互前独立起草）+3.3%。你的分层门槛（根因=近似一致同意 / 修复=无反对）与"按结论类型分层"可引用该文背书；≤3 轮设计亦吻合。
3. **MAD 失败模式清单**：Liang et al.（裁判对异构辩手可能不公 → 提示协调者综合时需防对自家通道输出的隐性偏好；https://arxiv.org/abs/2305.19118）、Should we be going MAD（同意强度可调；https://arxiv.org/abs/2311.17371）、MAST（14 失败模式/验证不足类，https://arxiv.org/abs/2503.13657）——在 skill 文档中引用可把你的每条纪律（盲辩/异构/不强制收敛/证据强制）逐条挂到学术失败模式上。
4. **agent-arena 的工程纪律**（https://github.com/zhjai/agent-arena）：participant 预检（最小无害调用+模型家族校验）、逐轮 checkpoint（含 retry 预算与 open_disagreements 字段）、error_max_turns 三分类诊断（启动失败/预算饥饿/结构性故障；一次无损重试、有损动作须用户批准）、协调者上下文预算（大输出落盘+读回摘要，防 compaction 吞掉辩论状态）。这些是三宿主调用稳定性最直接可抄的作业。
5. **revmux 的防锚定编排**（https://github.com/umputun/revmux）：同侪评审员不先看他人结果（防锚定）、按 (file,line±2) 去重、多源相互印证才升置信度——与盲辩+交叉批评互补的证据聚合细节。
6. **mABC 的三态投票与权重**（https://arxiv.org/abs/2404.12135）：For/Abstain/Against 与你的 同意/反对/保留 同构；其"贡献×专业"动态权重适合你未来做"分级追问时按历史命中率给席位加权"。
7. **LATS-RCA 的成本披露格式**（https://arxiv.org/abs/2605.03505）："平均 75 次 API 调用 / 220K token / 13 分钟"——单事件级成本计量的学术范例，可并进你的 report.json。

### 7.2 先行工作中没有看到的点（真正新颖处）

1. **宿主级三席异构**（CLI 子进程 + 两个 ACP 协议宿主）：先行工作的异构几乎都停在模型层（Council Mode/ReConcile/MoA）或双 harness（agent-arena/cross-review）。三通道三宿主的"异构最大化"没有先例，且 ACP（JSON-RPC、权限模式、会话生命周期）带来的结构化审计是 API 调用型先行工作不具备的。
2. **分层表决规则**（根因=全员非反对；修复=无反对+多候选并列）：Voting or Consensus 是按**任务类型**选协议，mABC/ReConcile 是单一门槛；按**结论类型**在同一会话内分层未见。
3. **中立协调者亲自实证**：cross-review 的证据研究由参战模型执行、revmux 的 verify 是独立第三阶段；"主持人自己 read/grep 裁决分歧点"这一角色分工（结合 Debate-or-Vote 的鞅洞察）是罕见且理论动机充分的组合。
4. **成本披露含单 agent 基线对照**：ACPX compare 记录 wall_ms/token 但不做"本会话 vs 单 agent"的对照叙事；Council Mode 只给 4.2× 总开销。
5. **双面报告+审计流**（HTML 短幻灯片 deck + report.json + events.ndjson）：revmux/agent-arena 有归档与 checkpoint，但无面向用户的"每页一个关键点"deck 产物（封面/根因/三席泳道轨迹/证据/分歧/修复/保留/成本）。
6. **僵局降级输出分歧报告交用户裁决**：agent-arena"不强制共识+保留异议"最接近，但未作为显式的僵局终态协议（Voting or Consensus 里 approval voting 59% 无结论是被当作失败报告的）。

### 7.3 继续造 vs 采纳 vs 混合

- **不建议整体采纳任何现成轮子**：agent-arena 覆盖度最高但缺表决/分层/成本基线/报告产物，且偏双席位、偏"评审"而非"根因诊断会话"；sethwebster/consensus 无辩论轮；cross-review 无表决且是 Claude Code skill。没有一个能替换你的六阶段协议。
- **不建议从零闭门造**：思想层 2023-2026 已充分研究（你防的每个失败模式都有论文命名；你的每条纪律都有近邻印证）；工程层 agent-arena/ACPX/revmux 已把预检、checkpoint、防锚定、成本计量趟过一遍。
- **建议：混合路线**——① 保留自研协议主干，把 7.1 的七项细节吸收进 skill 文档与实现（引用原文，增强可信度）；② 把 agent-arena 设为最近邻基准：在 README 中列"与 agent-arena 的差异表"（三席 vs 双席、显式分层表决 vs judge+synthesis、成本基线 vs 单调用记录、双面报告 vs checkpoint），并在实测中与"仅 R1+多数表决"基线、单 agent 基线三方对照（直接回应 Debate-or-Vote 的批评）；③ 生态位判断：obra/superpowers 的 issue #730（已核对，2026-03 提出后 **Closed as not planned**——维护者明确不实现跨模型第二意见）证明该需求在最大技能库中是**被明确留下的空位**——你的 skill 若开源，填补的是真实空缺，但 agent-arena 已在旁边，差异化叙事要落在"根因诊断专用 + 分层表决 + 协调者实证 + 成本基线"上；④ 长期可考虑把 mABC 式席位权重（历史命中率）加进分级追问。

---

## 8. 完整链接列表

### 学术论文
- Council Mode (arXiv 2604.02923): https://arxiv.org/abs/2604.02923 ｜ v4（原名 Council Mode，已核实）：https://arxiv.org/html/2604.02923v4 ｜ v5（2026-09-26 改题重写为 An Inspectable LLM Council for Multi-Model Research Answer Aggregation）
- Debate or Vote (NeurIPS 2025 Spotlight, arXiv 2508.17536): https://arxiv.org/abs/2508.17536 ｜ https://papers.nips.cc/paper_files/paper/2025/hash/934252acd87f254d5d4672fbde283bd2-Abstract-Conference.html ｜代码 https://github.com/deeplearning-wisc/debate-or-vote
- Voting or Consensus (ACL 2025 Findings, arXiv 2502.19130): https://aclanthology.org/2025.findings-acl.606/ ｜ https://arxiv.org/abs/2502.19130 ｜代码 https://github.com/lkaesberg/decision-protocols
- ReConcile (arXiv 2309.13007, ACL 2024): https://arxiv.org/abs/2309.13007 ｜ https://aclanthology.org/2024.acl-long.381/ ｜代码 https://github.com/dinobby/ReConcile
- Du et al. Multiagent Debate (arXiv 2305.14325, ICML 2024): https://arxiv.org/abs/2305.14325 ｜ https://proceedings.mlr.press/v235/du24e.html ｜项目页 https://composable-models.github.io/llm_debate/
- Liang et al. Encouraging Divergent Thinking / MAD (arXiv 2305.19118, EMNLP 2024): https://arxiv.org/abs/2305.19118 ｜ https://aclanthology.org/2024.emnlp-main.992/ ｜实现 https://github.com/Skytliang/Multi-Agents-Debate
- Should we be going MAD? (arXiv 2311.17371, ICML 2024): https://arxiv.org/abs/2311.17371 ｜ https://proceedings.mlr.press/v235/smit24a.html
- MAST: Why Do Multi-Agent LLM Systems Fail? (arXiv 2503.13657, NeurIPS 2025 D&B): https://arxiv.org/abs/2503.13657 ｜ https://github.com/multi-agent-systems-failure-taxonomy/MAST
- mABC (arXiv 2404.12135, EMNLP 2024 Findings): https://arxiv.org/abs/2404.12135 ｜ https://aclanthology.org/2024.findings-emnlp.232/ ｜代码 https://github.com/zwpride/mABC
- ChatEval (arXiv 2308.07201, ICLR 2024): https://arxiv.org/abs/2308.07201 ｜代码 https://github.com/chanchimin/ChatEval
- Exchange-of-Thought (EMNLP 2023): https://aclanthology.org/2023.emnlp-main.936/
- Mixture-of-Agents (arXiv 2406.04692, ICLR 2025): https://arxiv.org/abs/2406.04692 ｜代码 https://github.com/togethercomputer/moa ｜博客 https://www.together.ai/blog/together-moa
- Flow-of-Action (WWW Companion 2025, arXiv 2502.08224): https://arxiv.org/abs/2502.08224
- LATS-RCA (2026, arXiv 2605.03505): https://arxiv.org/abs/2605.03505
- OpsHarness (2026, arXiv 2608.25661): https://arxiv.org/abs/2608.25661
- GALA (ASE 2026, arXiv 2608.08968): https://arxiv.org/abs/2608.08968
- KRCA (2026, arXiv 2607.01788): https://arxiv.org/abs/2607.01788
- Graph Traversal Agent (2026, arXiv 2606.08590): https://arxiv.org/abs/2606.08590
- Why do AI agents systematically fail at cloud RCA (arXiv 2602.09937): https://arxiv.org/abs/2602.09937

### 开源工具
- rahultapase/llm-consensus: https://github.com/rahultapase/llm-consensus ｜Demo https://llm-consensus-taupe.vercel.app/
- Skytliang/Multi-Agents-Debate: https://github.com/Skytliang/Multi-Agents-Debate
- ACPX（openclaw/acpx）: https://acpx.sh/CLI.html ｜ https://casys.ai/blog/acpx-multi-agent-orchestration ｜ https://casys.ai/blog/multi-agent-workflows-without-the-bill ｜ https://casys.ai/blog/acpx-0-9-0-10-acp-fidelity
- Casys-AI/agentic-procedures（pair-codex / acpx-workflows skill）: https://github.com/Casys-AI/agentic-procedures
- Happenmass/omux: https://github.com/Happenmass/omux
- finger-gun/omux（OpenMUX）: https://github.com/finger-gun/omux
- cmux / ACPX / OMX 三层栈综述（Daniel Vaughan, 2026-04）: https://codex.danielvaughan.com/2026/04/09/cmux-acpx-omx-three-layers-multi-agent-ux/
- cmux（oh-my-openagent 集成）: https://cmux.com/blog/cmux-omo ｜ https://cmux.com/docs/agent-integrations/oh-my-opencode
- oh-my-openagent (OmO) 评论（37.6k★，11 agent 多模型路由）: https://www.the4thpath.com/2026/03/oh-my-openagent-omo-full-review-multi.html ｜review-work skill https://cdn.jsdelivr.net/npm/oh-my-opencode@4.19.4/dist/skills/review-work/SKILL.md
- claude-squad: https://github.com/smtg-ai/claude-squad
- vibe-kanban: https://github.com/BloopAI/vibe-kanban
- AgentMux: https://github.com/markuswondrak/AgentMux
- acp-bridge: https://github.com/allvegetable/acp-bridge
- OCMux（opencode-multiplexer）: https://npmx.dev/package/opencode-multiplexer
- umputun/revmux: https://github.com/umputun/revmux
- spencermarx/open-code-review: https://github.com/spencermarx/open-code-review

### Skill 生态
- zhjai/agent-arena: https://github.com/zhjai/agent-arena ｜SKILL.md https://github.com/zhjai/agent-arena/blob/main/skills/agent-arena/SKILL.md
- sethwebster/consensus: https://github.com/sethwebster/consensus ｜skill https://github.com/sethwebster/consensus/blob/main/skill/SKILL.md
- dmitriyyukhanov/cross-review: https://www.skillsdirectory.com/skills/dmitriyyukhanov-cross-review
- Trail of Bits second-opinion: https://trailofbits.com/skills/second-opinion/ ｜ https://github.com/trailofbits/skills ｜SKILL.md https://raw.githubusercontent.com/trailofbits/skills/main/plugins/second-opinion/skills/second-opinion/SKILL.md
- AlessioZazzarini/debate-kit: https://github.com/AlessioZazzarini/debate-kit
- amElnagdy/review-skills（debate-review/babysit-pr）: https://github.com/amelnagdy/review-skills
- craigkitterman/cross-model-code-review-skill: http://github.com/craigkitterman/cross-model-code-review-skill
- wenyuChiou/agent-collab-skills（agent-debate）: https://skillsmp.com/creators/wenyuchiou/agent-collab-skills/skills-agent-debate
- parlance-labs/super-oracle: https://github.com/parlance-labs/super-oracle
- bayramannakov/agent-tower-plugin: https://skills.sh/bayramannakov/agent-tower-plugin/agent-tower-plugin
- judge-with-debate: https://mcpmarket.com/tools/skills/judge-with-debate
- pmatos/skills（codex-2nd-opinion）: https://github.com/pmatos/skills
- obra/superpowers（issue #730 跨模型第二意见 feature request）: https://github.com/obra/superpowers/issues/730 ｜ https://github.com/obra/superpowers
- skills.sh 市场: https://skills.sh

---

### 附注（诚实声明）

1. 任务书中"sst/opencode 生态的 omux（quad/pair/review 模式）"**未能核实**：GitHub 上两个 omux（Happenmass/omux、finger-gun/omux/OpenMUX）均无 quad/pair/review 辩论模式；sst 组织本身（anomalyco/sst）与该工具无关。最接近该描述的实际是 ACPX+cmux+OMX 三层栈（Daniel Vaughan 综述）与 OmO 的多 agent 评审门。建议在最终报告/README 中更正此引用来源。
2. 任务书中"Debate or Vote 被引 118"未逐条核实引用数（Google Scholar 动态数据），已核实的是其 **NeurIPS 2025 Spotlight** 身份与官方代码库。
3. 通用框架（AutoGen/LangGraph/CrewAI/AgentVerse/MetaGPT/ChatDev）按任务要求仅判断"是否原生提供辩论+表决+共识原语"，未深挖文档：结论为提供编排原语、协议需自实现，其中 AgentVerse 论文含 MAD 示例、ChatDev 含程序员-评审员对抗角色。
