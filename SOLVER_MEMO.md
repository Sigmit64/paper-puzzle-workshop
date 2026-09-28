# Solver 开发备忘录

更新时间：2026-09-27（Asia/Shanghai）

## 当前状态

- `ruleset.txt` 的 159 条规则均已注册、实现并进入覆盖审计：涂黑 39/39、回路 46/46、填数 42/42、分区 32/32。
- `npm run build` 通过。
- `npm run test:solver` 通过：151 个端到端求解案例、32 个显式分区约束案例、8 个锚点/不规则拓扑案例。
- 求解器至多寻找两个不同答案，区分无解、多解、唯一解和超时；无解与多解均为 0 分，唯一解只获得基础分。
- 未注册规则仍会返回 `unsupported`，不会被静默忽略。
- 四类求解器在既有最多两个答案的搜索中保留最多两个 `PuzzleSolutionLayers`；未证明状态不携带伪答案。
- 数字线索 UI 统一接受 0–9，reducer 拒绝非整数和范围外注入；catalog min/max 仅为元数据。
- 卡牌 tooltip 与图鉴共用完成答案 SVG，通过 `ruleKey → SOLVER_COVERAGE.ordinal → RULESET[ordinal-1]` 映射。
- 提交模态保存提交时盘面快照，唯一解直接展示，多解点击“我不信”后展示解一、解二。

## Z3 Pages 兼容性探针（非正式求解器）

- `z3-solver@5.2.0` 仅用于 `/z3-probe/` 的独立实验页面，不进入游戏首屏，也不迁移任何 159 条正式规则。
- 探针在用户点击后于应用级 Worker 中加载官方 `z3-built.js`/`z3-built.wasm`，执行一个有限域模型：第一次 `sat` 投影 `x=0,y=1`，加入阻断后第二次 `unsat`。
- 官方包使用线程 WASM，需要 `SharedArrayBuffer` 与 COOP/COEP；GitHub Pages 源站响应头未由本项目控制。探针用固定版本 `coi-serviceworker@0.1.7` 在 `/z3-probe/` 范围内注册 Service Worker，首次访问自动重载并为受控响应补头；正常游戏入口不注册。若隔离仍失败则显示 `BLOCKED_HEADERS`。
- 当前 production 构建尺寸：官方 `z3-built.wasm` 34,938,413 bytes（约 8.0 MB gzip）、官方 JS 353,813 bytes、应用级 Worker 162,713 bytes。移动网络、低端设备和冷启动延迟是后续迁移的明确风险；这些尺寸不进入正常游戏首屏下载。
- `npm run test:z3-probe` 覆盖 Node 模型 smoke、线程清理、Service Worker 及许可证、probe HTML/worker/JS/WASM 产物、scope 边界以及根路径和模拟 `/repo/` 的资源解析。临时 Playwright 1.63.0 / Chromium 153.0.8010.12 实测 localhost production server：带源站 COOP/COEP 为 PASS（233.0/60.9/38.8 ms、总计 372.1 ms）；无源站 headers、由 scope-limited Service Worker 隔离也为 PASS（214.5/61.5/37.3 ms、总计 358.7 ms）。真实 Pages 全新浏览器 context 也为 PASS：首次访问自动重载，随后 `crossOriginIsolated=true`，初始化 3295.9 ms、check 62.0/38.9 ms、总计 3828.7 ms，无网络或控制台错误；正常游戏入口未注册 Service Worker，也未加载 Z3。该数据只是单次真实网络样本，不是稳定性能基准。

## 求解器结构

- `src/game/solver.ts`：159 条规则注册、盘面编译、提交检查、计分和四类求解器分派。
- `src/game/solver-loop.ts`：格中心单回路搜索；支持转弯、内外判定、臂长、直线段与外提示。
- `src/game/solver-shade.ts`：黑白布尔域、连通性、蛇、连通组、射线、边/点/外提示。
- `src/game/solver-number.ts`：0（留空）及 1–N 数值域、Latin 约束、四则运算、点与摩天楼线索。
- `src/game/solver-region.ts`：规范化区域标签搜索、区域形状/对称/全等、边界和外提示；并导出显式分区验证器供精确测试。
- `src/game/puzzle-model.ts`：cell/edge/vertex/exterior 统一锚点、删除保护、跨缺口外提示观察。
- `src/game/solver-coverage.ts`：`ruleset.txt` 序号到已注册且已测试规则键的权威映射。
- `scripts/solver-smoke.mjs`：求解、计数、形状、锚点和删除格回归测试。

## 已确认并固化的特殊语义

- 删除格会切断普通邻接、连续黑段/同区段和回路线段，但外提示仍观察完整行列。
- “接触”含正交与对角；“相邻”仅指正交。
- 蛇至少包含两个黑格，且不能分叉、成环或对角自接触。
- Land Measurement 只沿黑格正交行走、包含起终点；不连通等价于无穷大，任何有限线索都不成立。
- 回路线段长度为经过格数减一；Balance Loop 使用格中心到下一转弯的两臂长度。
- 填数四则运算中的差为绝对差，除法必须整除；只有一个数字时直接取该数，没有数字时不成立。
- 两组对角线约束分别计算，且每条对角线至少包含一个数字。
- 区域“形状相同”的全局判断允许平移、旋转和翻转；明确写“旋转平移”的线索不允许翻转；“平移全等”保持方向。
- 同色多点规则少于两个对应颜色点时不计分。

## 后续维护要求

- 新增或改写规则时，同时更新卡牌定义、注册表、求解约束、测试和 `solver-coverage.ts`。
- 对表述仍可能有歧义的规则，先补充规则文本与测试样例，再修改求解器；不要靠默认猜测改变既有语义。
- 大盘面可能在 2.5 秒证明时限内返回 `timeout`；这表示未证明结论，不会误判无解或完成盘面。

## 回路 Z3 迁移可行性 pilot（Node/WSL）

- 入口是 `src/game/solver-loop-z3.ts`，只接受现有 `CompiledPuzzle` 的回路模型；正式 `evaluateBoard` 仍调用 `solver-loop.ts`，Z3 不进入游戏首屏或正式 solver bundle。
- 精确编码的 pilot 子集为：隐含的 `loop.single-cycle`、`loop.visit-all-unclued-cells`、格内 `visited`/`unvisited`、格内 `straight`/`turn`（含 white-dot/black-dot 两个既有规则键）、边线 `traversed`/`not-traversed`。任一其它 active loop rule 会抛出 `LoopZ3UnsupportedError`，不会静默忽略。
- 单回路不是模型投影后的 JS 过滤：每个 active cell 的度为 0 或 2，边变量直接代表选中边；唯一动态 root 加整数有向流在 SMT 内约束所有 visited cell 可由同一 root 到达，因此分离子环为 UNSAT。第二次 check 阻断完整 edge assignment（全部 edge vars），返回至多两个不同 signature。
- `src/game/loop-pilot-validator.ts` 是与 Z3 无关的纯 validator；benchmark/test 对 legacy 与 Z3 的 candidate 共同调用它，重新检查完整拓扑、0/2 度、单连通回路、pilot clues 和完整 edge signature。Z3 只有在两份不同 edge assignment 均 validator PASS 时才计为已证明 multiple；重复、缺失、非法边或验证失败会使 benchmark 非零退出。
- 对 pilot-compatible `CompiledPuzzle`，legacy `solver-loop.ts` 在把候选加入 `solutions`/`solutionLayers` 之前也调用同一个 validator；原有 46-rule `validateCycle` 仍作为搜索剪枝，非-pilot 模型路径和默认求解预算不变。方向谓词由 validator 导出并与 legacy 路径共享。
- 固定 fixture 为 `loop-z3-8x8-benchmark`，seed `8x8-hamiltonian-serpentine-v1`，完整 8×8 active topology、64 cells；使用 visit-all-unclued、white-dot straight、black-dot turn、traversed 与 not-traversed 五种规则/线索类型，答案边没有被逐条写入。运行：`npm run test:loop-z3`、`npm run benchmark:loop-z3`。
- 决策阈值预先定义为：相同预算下，Z3 warm solve median 至少达到 legacy 已完成耗时的 3×，且分类与完整 edge signature 一致。若 legacy 在生产预算和额外 ground-truth 预算都 timeout，则不伪造精确 speedup，而使用 `legacyProductionBudget / Z3WarmMedian` 作为相对生产预算的保守下界；两份独立有效 Z3 解足以证明 multiple。`DO_NOT_MIGRATE` 是性能/证据决策，不是 harness 失败；Z3 unknown/timeout、pilot unsupported、验证失败或已证明分类/signature 不一致才使 benchmark 非零退出。

最近一次基线环境为 Node `v20.20.2`、`z3-solver 5.2.0`、Linux x64，legacy 与 Z3 的生产预算均为 2500 ms，另有一次 10000 ms legacy ground-truth 尝试。Z3 engine init `105.268 ms`，encoder build `130.669 ms`；cold solve：legacy `2500.204 ms/timeout`，Z3 `750.534 ms/multiple`（两次 check），之后双方各有一次 warmup。七次 legacy 原始耗时（ms）为 `2500.063, 2500.032, 2500.027, 2500.073, 2500.069, 2500.092, 2500.130`，全部 `timeout`；七次 Z3 原始耗时（ms）为 `120.781, 579.528, 476.612, 365.518, 578.651, 734.085, 204.206`，全部 `multiple`、每次两次 check，且每次两份 signature 均 distinct、validator PASS。nearest-rank median/p95：legacy `2500.069/2500.130 ms`，Z3 warm `476.612/734.085 ms`；由于 legacy 未完成，不声称 `5.25×` 为真实 speedup，只报告相对生产预算下界 `2500 / 476.612 = 5.25×`。初始化与 encoder 成本约 `235.9 ms`，按预算下界估算约 1 次 solve break-even。legacy 在额外 10000 ms 验证预算仍 timeout（22,825,473 explored nodes），所以没有 legacy 完成态可比较；但 multiple 已由两份独立 validator PASS 的完整 Z3 edge solutions 直接证明。基于“至少 3× 下界且 multiple 证据完整”的门槛，决策为 `CONTINUE_MIGRATION`，仍不能据此直接宣称浏览器 Pages 性能或覆盖全部 46 条规则。
- 上述是同一 Node/WSL 进程内的工程 benchmark，不是浏览器 Pages 性能；冷初始化、WASM 下载和浏览器线程隔离成本未计入 warm solve。环境噪声可能影响毫秒级样本，原始 JSON 由 benchmark 命令稳定输出；该 pilot 也没有覆盖其余 36 条 loop 规则。
