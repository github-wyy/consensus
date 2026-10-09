# consensus 开源加固实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agent-arena 三项工程纪律（席位预检 / 逐轮 checkpoint / 失败三分类诊断）深融进 consensus skill 的协议与实现，补齐开源基建（README 学术论证 / LICENSE / 可移植性），产出开源就绪仓库。

**Architecture:** 新仓库 `github-wyy/consensus` 为唯一真源，`~/.agents/skills/consensus` 软链过去。三个新纯函数模块（preflight/diagnose/checkpoint）+ run.mjs 编排升级 + 协议文档与 README 同步。ACP 客户端与渲染层不动。

**Tech Stack:** Node ESM（.mjs），零 npm 依赖，node:test，ACP（JSON-RPC over stdio）+ CLI 子进程双通道。

**Spec:** `docs/specs/2026-10-04-consensus-opensource-hardening-design.md`

## Global Constraints

- Node ESM `.mjs`；**零 npm 依赖**；测试只用 `node:test`
- run 契约永不 reject：失败 settle 成 `{stopReason, output, diagnostic}`；STOP_MAP 不变（end_turn→completed / max_tokens→max-tokens / refusal→refusal / cancelled→aborted）
- 注释与文档中文；Conventional Commits，禁止 AI 署名行
- 提交的代码里不得残留 `/Users/yangyang` 硬编码（作者环境走 `~/.config/consensus/config.yaml`）
- 每席每轮 attempts ≤ 2；预算放宽因子 `budgetBumpFactor` 默认 1.5；状态文件名保留 `state.json`
- `lib/acp-client.mjs`、`lib/render-report.mjs`、`lib/report-template.html` 本次不改
- env 变量名固定：`CONSENSUS_BIN_OPENCODE` / `CONSENSUS_BIN_DSH` / `CONSENSUS_BIN_OMP`

## Review Focus

1. **两种超时文案都要命中 budget-starved**：ACP 侧诊断是 `prompt 超时 600000ms`，CLI 侧是 `超时 600000ms`——classify 必须两者都归预算饥饿 → `test/diagnose.test.mjs`
2. **completed 但输出为空**（CLI stdout 空 / ACP 无 chunk）必须归 structural 并缺席，不得计为成功 → `test/diagnose.test.mjs`（emptyOutput 分支）
3. **rounds 累积不丢历史**：连续两次 mergeRound 后第一轮记录仍在（旧 writeState 覆盖式会丢）→ `test/checkpoint.test.mjs`
4. **--divergences-file 缺省时 openDisagreements 不被清空** → `test/checkpoint.test.mjs`
5. **usage 缺失容错**：oc-spawn 无 token 统计，accumulateCost 仍累加 calls、tokens 容 null 不 NaN → `test/checkpoint.test.mjs`

---

### Task 1: 基线导入

**Files:**
- Create: 仓库根 `SKILL.md`、`SKILL_BODY.md`、`lib/`（acp-client/cli-client/investigators/run/render-report.mjs、report-template.html）、`docs/research/community-prior-art.md`、`.gitignore`

**Interfaces:**
- Produces: 与 `~/.agents/skills/consensus` 完全一致的基线（后续任务在此之上改造）。

- [ ] **Step 1: 复制基线文件入仓库**

```bash
SRC=~/.agents/skills/consensus; DST=/Users/yangyang/go/src/github.com/github-wyy/consensus
cp $SRC/SKILL.md $SRC/SKILL_BODY.md $DST/
mkdir -p $DST/lib $DST/docs/research
cp $SRC/lib/*.mjs $SRC/lib/report-template.html $DST/lib/
cp $SRC/research/community-prior-art.md $DST/docs/research/
```

- [ ] **Step 2: 写 `.gitignore`**

内容固定：`.consensus/`、`.DS_Store`、`node_modules/`。

- [ ] **Step 3: 验证基线完整**

Run: `diff -r $SRC $DST --exclude=.git --exclude=research` 加 `git status --short`
Expected: 除 research/（已移入 docs/）外无差异；untracked 文件齐全。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore(global): 导入 consensus skill 基线"
```

---

### Task 2: lib/preflight.mjs（席位路由预检）

**Files:**
- Create: `lib/preflight.mjs`
- Test: `test/preflight.test.mjs`

**Interfaces:**
- Produces:
  - `resolveBin(seatKey, cfg, { env })` → `string|null`（同步：env `CONSENSUS_BIN_*` > cfg roster[].bin > `command -v` 同步探测；全 miss 返回 null）
  - `loadCache(workspace)` / `saveCache(workspace, entries)` → 读写 `.consensus/preflight.json`
  - `cacheFresh(workspace)` → `boolean`（缓存存在且每条 `fs.existsSync(resolvedBin)`）
  - `probeSeat(seatDef, { cwd, deep })` → `Promise<{ok, resolvedBin, model, error}>`（ACP 席=完整 initialize+session/new+dispose 握手零 token；CLI 席默认 `<bin> --version`，deep=true 时最小 prompt"只回复 OK"）
  - `preflightAll(seats, workspace, { deep, refresh })` → `Promise<{entries: Array, bySeat: Object}>`（refresh=true 或缓存失效时重探并写缓存）
- Consumes: `investigators.mjs` 的 seat 结构（Task 5 后含 `bin` 字段）；ACP 握手复用 `acp-client.mjs` 的 `AcpClient`（不改其文件）。

- [ ] **Step 1: 写失败测试**

`test/preflight.test.mjs`（node:test）：① env 覆盖 config 与 which；② config roster[].bin 次之；③ 全 miss → null；④ cacheFresh 在 resolvedBin 不存在时返回 false；⑤ saveCache→loadCache 往返一致。env 用注入对象测，which 探测用真实 `command -v ls` 这类必然存在的命令。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/preflight.test.mjs`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `lib/preflight.mjs`**

按 Interfaces 四个导出实现；`command -v` 用 `execSync`（每次命令只调一次，性能可接受）；probe 的 ACP 分支构造一次性 AcpClient（start→newSession→dispose）；错误消息含 resolvedBin 便于排查。

- [ ] **Step 4: 运行测试通过**

Run: `node --test test/preflight.test.mjs`
Expected: PASS 全绿。

- [ ] **Step 5: Commit**

```bash
git add lib/preflight.mjs test/preflight.test.mjs
git commit -m "feat(lib): 席位路由预检——三级解析/缓存失效/最小无害探测"
```

---

### Task 3: lib/diagnose.mjs（失败三分类）

**Files:**
- Create: `lib/diagnose.mjs`
- Test: `test/diagnose.test.mjs`

**Interfaces:**
- Produces: `classify({ stage, stopReason, diagnostic, emptyOutput })` → `{ class, retry, hint }`
  - `class ∈ 'launch-failure' | 'budget-starved' | 'structural'`
  - `retry ∈ 'same-channel' | 'fallback-channel' | 'same-channel-budget' | 'none'`（fallback 仅对 ACP 席适用，由调用方按席位通道裁定）
- Consumes: 现有两客户端的失败形态（stage 由调用方标注：ACP initialize/session/new 失败与 CLI exit≠0 为 `launch`，其余 `runtime`）。

- [ ] **Step 1: 写失败测试（表驱动全分支）**

用例固定：`{launch,error}`→launch-failure/fallback-channel；`{runtime,error,'prompt 超时 600000ms'}`→budget-starved/same-channel-budget；`{runtime,error,'超时 600000ms'}`→budget-starved；`{runtime,'max-tokens'}`→budget-starved；`{runtime,'refusal'}`→structural/none；`{runtime,'completed',emptyOutput:true}`→structural/none；`{runtime,error,'prompt 错误: …'}`→structural/none。

- [ ] **Step 2: 运行确认失败** → Run: `node --test test/diagnose.test.mjs`，Expected: FAIL。

- [ ] **Step 3: 实现 classify（纯函数，超时匹配用 `/超时|timed?\s*out/i` 兼容两种文案）**

- [ ] **Step 4: 运行测试通过** → `node --test test/diagnose.test.mjs` 全绿。

- [ ] **Step 5: Commit** → `feat(lib): 失败三分类诊断——launch/budget/structural 与重试策略映射`

---

### Task 4: lib/checkpoint.mjs（累积式状态）

**Files:**
- Create: `lib/checkpoint.mjs`
- Test: `test/checkpoint.test.mjs`

**Interfaces:**
- Produces:
  - `newState({ ts, workspace, question, roster })` → 初始 state（rounds 空数组、openDisagreements 空数组、cost 零值）
  - `mergeRound(state, round)` → 新 state（rounds **追加** `{phase, startedAt, wallMs, divergences, seats}`；不覆盖历史）
  - `applyDivergences(state, divergencesOrNull)` → null 时**不动 openDisagreements**；非 null 时写入末轮 divergences 并**整体替换** openDisagreements
  - `accumulateCost(state, { calls, tokens, wallMs })` → calls/wallMs 累加，tokens 缺失时保持原值不 NaN
- Consumes: 无（纯函数）。

- [ ] **Step 1: 写失败测试**

覆盖 Review Focus 3/4/5：两次 mergeRound 首轮仍在；divergences null 不清空、非 null 整体替换；accumulateCost 混合有/无 tokens 的调用序列。

- [ ] **Step 2: 运行确认失败** → FAIL。

- [ ] **Step 3: 实现四个纯函数（返回新对象，不改入参）**

- [ ] **Step 4: 运行测试通过** → 全绿。

- [ ] **Step 5: Commit** → `feat(lib): 累积式 checkpoint——轮次追加/分歧替换/成本累积`

---

### Task 5: 可移植性接线（investigators + cli-client）

**Files:**
- Modify: `lib/investigators.mjs`（删 OC_BIN/DSH_CLI/OMP_BIN 常量；model 默认全 null；cmd getter 用 `this.bin`）
- Modify: `lib/cli-client.mjs`（ocSpawn/dshHeadless/ompOnce 接收 `bin`/`model` 参数，删内部路径）
- Modify: `lib/run.mjs`（buildRoster 后用 `resolveBin` 填 seats[].bin；promptSeat 传 bin/model）
- Test: 并入 `test/preflight.test.mjs`（buildRoster 的 bin 解析与 env 覆盖）

**Interfaces:**
- Consumes: Task 2 `resolveBin`。
- Produces: `buildRoster(cfg, { env })` 返回的每个 seat 含 `bin: string|null` 与 `model: string|null`（null=随宿主默认）；三席位 cmd getter 形如 `[this.bin, '--profile', 'acp']`。

- [ ] **Step 1: 扩展测试**（buildRoster：cfg roster bin 命中；env 覆盖；全 miss 时 bin=null 且不抛错）

- [ ] **Step 2: 运行确认失败** → FAIL。

- [ ] **Step 3: 改三个文件**（tkehubKey 保留为凭据透传；模型默认 null 后 ocSpawn 的 cmd 在 model null 时不带 --model；dsh/omp 同理不带 --model）

- [ ] **Step 4: 运行全套测试** → `node --test test/` 全绿；`node --check lib/*.mjs` 无语法错。

- [ ] **Step 5: Commit** → `refactor(lib): 去硬编码——bin/model 三级解析接线，作者环境外移配置`

---

### Task 6: run.mjs 编排升级（checkpoint/重试/预检/分歧写回/成本）

**Files:**
- Modify: `lib/run.mjs`

**Interfaces:**
- Consumes: Task 2 `preflightAll/cacheFresh`；Task 3 `classify`；Task 4 `newState/mergeRound/applyDivergences/accumulateCost`。
- Produces:
  - `preflight` 子命令：`node run.mjs preflight [--workspace d] [--deep] [--refresh]` → stdout JSON `{entries, bySeat}`
  - `blind` 流程：预检（缓存新鲜则跳过探测）→ 预检失败席位缺席并记 `{stopReason:'absent-preflight', diagnosis}` → 盲辩 → mergeRound
  - `round`/`vote` 新增可选 `--divergences-file <f>`（一行一个分歧点）→ applyDivergences
  - `promptSeat` 重试闭环：失败 → classify → 按 `{launch: ACP→fallback-channel 换 CLI 回落并标记 channelFallback=true / CLI→same-channel；budget: same-channel-budget（timeout × budgetBumpFactor）；structural: none}` 重试一次；结果带 `attempts/diagnosis/channelFallback/usage`（ACP usage 在 dispose 前从 client 读出）
  - 每次调用后 `accumulateCost`（calls 按尝试次数，tokens best-effort）；writeState 落累积 state

- [ ] **Step 1: 实现 promptSeat 重试闭环**（attempts≤2；两客户端已有结果形态不变，外面包一层）

- [ ] **Step 2: 实现预检集成与 preflight 子命令**

- [ ] **Step 3: 实现状态升级**（cmdBlind/cmdRoundLike 全部走 checkpoint helpers；divergences-file 读取；cost 累积；status 输出含 openDisagreements 与 cost）

- [ ] **Step 4: 验证**

Run: `node --test test/`（全绿）+ `node --check lib/run.mjs` + `node lib/run.mjs status --workspace .`（空运行列表不报错）
Expected: 三项全部通过。

- [ ] **Step 5: Commit** → `feat(run): 编排升级——预检集成/重试闭环/累积 checkpoint/分歧写回/成本累积`

---

### Task 7: 协议文档同步

**Files:**
- Modify: `SKILL_BODY.md`（§0 加"席位路由预检"小节；§1 阶段 1 前插预检步、阶段 3 轮末 `--divergences-file` 写回、阶段 5 cost 取自 checkpoint；§1.5 命令表加 `preflight` 与 `--divergences-file`；§5 降级表前加三分类表并标注"降级必须披露 channelFallback，永不静默"）
- Modify: `SKILL.md`（纪律清单加预检条目；阵容表 model 改"null=随宿主默认"）

**Interfaces:** Consumes Task 2/3/6 的实际行为（文档如实描述实现）。

- [ ] **Step 1: 按要点改两份文档**（决策编号体系沿用：新增规则追加"决策 14"起）

- [ ] **Step 2: 验证** → `grep -c "预检\|三分类\|divergences-file" SKILL_BODY.md` ≥ 6；人工通读无前后矛盾。

- [ ] **Step 3: Commit** → `docs(protocol): 三纪律入协议——预检/checkpoint/三分类诊断与披露规则`

---

### Task 8: README / LICENSE / config.example.yaml

**Files:**
- Create: `README.md`（中文为主，九节骨架：定位 / 为什么存在 / 协议与工程纪律 / **协议设计依据**（每条纪律→学术出处，核心=鞅定理→证据纪律与协调者实证是收益引擎）/ 近邻差异表 / 快速开始 / 配置参考 / 限制与诚实披露 / 致谢引用）
- Create: `LICENSE`（MIT，Copyright (c) 2026 github-wyy）
- Create: `config.example.yaml`（三席配置逐项注释；含非 tkehub 环境示例与作者环境注释样例）

**Interfaces:** 引用链接唯一来源 `docs/research/community-prior-art.md` §8（已核实，含 Council Mode v5 勘误）。

- [ ] **Step 1: 写三个文件**（差异表取调研报告 §6 近邻行：agent-arena / cross-review / sethwebster-consensus / Trail of Bits second-opinion）

- [ ] **Step 2: 验证** → README 中所有 arXiv/GitHub 链接能在 `docs/research/community-prior-art.md` §8 找到对应；`grep -c "arxiv" README.md` ≥ 5。

- [ ] **Step 3: Commit** → `docs(readme): 学术论证与近邻差异表，开源门面就绪`

---

### Task 9: 软链替换 + 作者配置迁移 + 冒烟

**Files:**
- Create: `~/.config/consensus/config.yaml`（作者环境：老硬编码值迁移——三席 bin 真实路径 + tke 模型名）
- 操作: `~/.agents/skills/consensus` → 备份后换软链

**Interfaces:** Consumes 全部前序任务。

- [ ] **Step 1: 写作者全局配置**（bin 用旧硬编码值：`/Users/yangyang/.opencode/bin/opencode`、`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`、`/Users/yangyang/.bun/bin/omp`；model：oc-spawn `tke/deepseek-flash-latest`、dsh `tke/deepseek-pro-latest`、omp null）

- [ ] **Step 2: 换软链**（`mv ~/.agents/skills/consensus ~/.agents/skills/consensus.bak-20261004 && ln -s <repo> ~/.agents/skills/consensus`）

- [ ] **Step 3: 验证软链**（readlink 生效；`cat ~/.agents/skills/consensus/SKILL.md` 可读；`node ~/.agents/skills/consensus/lib/run.mjs status` 正常返回）

- [ ] **Step 4: 冒烟——真实预检**

Run: `node lib/run.mjs preflight --workspace .`
Expected: 三席 ok:true（或 dsh/omp 环境问题时如实 absent 并可诊断）；`.consensus/preflight.json` 生成。

- [ ] **Step 5: 冒烟——真实盲辩**

Run: `node lib/run.mjs blind --workspace . --question-file /tmp/q.txt`（q.txt 放一个极小问题，如"1+1 等于几？"）
Expected: 返回 JSON 含三席 reports 与 rounds[0]；`.consensus/runs/<ts>/state.json` 的 rounds 长度 1、cost.calls ≥ 3。

- [ ] **Step 6: 收尾验证**

Run: `node --test test/` 全绿 + `git log --oneline` 提交序列完整 + `git status` 干净。
Expected: 全部通过；skill 经软链仍可被 opencode 加载（SKILL.md 经路径可读即视为通过，回落方案见 spec §8）。
