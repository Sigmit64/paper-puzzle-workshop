# Solver 开发备忘录

更新时间：2026-09-29（Asia/Shanghai）

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

- `z3-solver@5.2.0` 用于 `/z3-probe/` 诊断页和正式 loop Worker；不进入游戏首屏，也不迁移 shade/number/region。
- 探针在用户点击后于应用级 Worker 中加载官方 `z3-built.js`/`z3-built.wasm`，执行一个有限域模型：第一次 `sat` 投影 `x=0,y=1`，加入阻断后第二次 `unsat`。
- 官方包使用线程 WASM，需要 `SharedArrayBuffer` 与 COOP/COEP；GitHub Pages 源站响应头未由本项目控制。项目根入口与 `/z3-probe/` 共同加载根 scope 的 `coi-serviceworker@0.1.7`，首次访问自动重载并为受控响应补头；隔离失败时正式 loop Worker 明确回退 legacy，probe 显示 `BLOCKED_HEADERS`。
- 当前 production 构建尺寸：官方 `z3-built.wasm` 34,938,413 bytes（约 8.0 MB gzip）、官方 JS 353,813 bytes、probe Worker 162,713 bytes、正式 loop Worker 约 292 KB。移动网络、低端设备和冷启动延迟是明确风险；这些 Z3/Worker 重资产不进入正常游戏首屏下载。
- `npm run test:z3-probe` 覆盖 Node 模型 smoke、线程清理、Service Worker 及许可证、probe HTML/worker/JS/WASM 产物、scope 边界以及根路径和模拟 `/repo/` 的资源解析。外置 Chromium 本地实测通过：root game 首次 SW reload 后 `crossOriginIsolated=true`、controller/UI 正常；main/probe 首屏无 Z3/Worker 请求；production 8×8 cold/warm 分别 `1545.6/1032.6ms`，均 `multiple`, `backend=z3`, 两份解有效并请求 JS/WASM；阻断 SW 时无 page/console/http error，2×2 经同一 Worker 返回 `unique`, `backend=legacy-fallback`，且 bootstrap 未改变原生 register identity。浏览器数字只是本机样本，不是 Pages 性能基准。

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

## 回路 Z3 Phase A（完整 46-key encoder，Node/WSL）

- 入口是 `src/game/solver-loop-z3.ts`，接受现有 `CompiledPuzzle` 回路模型；注册表中的 46 个显式 loop keys（另含隐含 `loop.single-cycle` 与两个历史 white/black alias）均经过 `LOOP_Z3_RULES` dispatch，未知 active key 明确抛出 `LoopZ3UnsupportedError`。正式提交由 `src/game/loop-z3-client.ts` lazy 创建 `src/game/loop-z3-worker.ts`，正常 Z3 结果走正式 UI；资产/初始化/unsupported/Worker 求解协议失败在同一 Worker 显式回退 `legacy-fallback`。Z3 JS/WASM 不进入游戏首屏。
- SMT 以 active topology 的 0/2 度边变量、连通流和有限 cyclic rank 同时证明单一回路。rank 不是模型取出后的排序：每个选中边必须连接相邻 rank，所有 `0..|V|-1` rank 必须被占用，因此删除格不会被跨越、多个子环不能满足模型。所有 active rule 均在 SMT 直接约束，validator 不参与求解循环。
- 已直接编码的规则族包括：全局相邻未访问/访问所有无提示格；四邻/八邻访问、未访问、转弯计数；inside parity 与格内四顶点计数；arm length、edge split/midpoint/segment、outward line runs；visited/unvisited、straight/turn、Masyu、pearls、traversed、same/opposite orientation、exactly-one；vertex inside/outside/majority/counts；未访问 component 的中心/轴对称；exterior visited count 与平行段 count/longest/shortest。线段和 component 均有有限 SMT 展开，不由 JS 二次过滤。
- `npm run test:loop-z3` 输出 `coverage: 46/46`：每个 key 都通过真实 `compileBoard` card carrier 构造并实际求解，与 legacy 分类对照。state-2 回归明确区分 `orthogonal-unvisited`（只计普通 state-1 未经过格）与 `eight-unvisited`（复用 legacy `binaryClues`，计所有 `!visited`，包含 state-2 clue 格）；另有无 value Masyu carrier、exterior grouping、solutionLimit=1、subtour、删除列 gap，以及同一真实 carrier 的 control/target mutation 对照：inside、center symmetry、equal-arm、edge midpoint、exterior-longest 均在去除目标约束时保持 SAT（或多解），加入与固定环冲突的目标约束后变为 UNSAT。现有 `test:solver` 仍为 151/151、规则覆盖 159/159。
- 固定 benchmark fixture 为 `loop-z3-8x8-benchmark`，seed `8x8-hamiltonian-serpentine-v1`，完整 8×8 active topology、64 cells；使用 visit-all-unclued、white-dot straight、black-dot turn、traversed 与 not-traversed 五种规则/线索类型，答案边没有被逐条写入。运行：`npm run test:loop-z3`、`npm run benchmark:loop-z3`。
- Phase A benchmark 环境为 Node `v20.20.2`、`z3-solver 5.2.0`、Linux x64，legacy/Z3 预算均 2500 ms，legacy ground-truth 额外 10000 ms。最终 raw：legacy `2500.124,2500.030,2500.061,2500.075,2500.068,2500.020,2500.040` ms（全 timeout）；Z3 `146.680,174.930,560.008,647.501,730.494,738.598,436.513` ms（全 multiple，两次 check）。Z3 init `100.592 ms`，encoder build `146.893 ms`，cold legacy `2500.207 ms/timeout`、cold Z3 `1019.390 ms/multiple`；warm median/p95 为 Z3 `560.008/738.598 ms`，legacy `2500.061/2500.124 ms`。七次 Z3 均返回两份不同完整 edge assignments，独立 pure validator 对每份均 PASS；legacy 10 s ground truth 仍 timeout（约 22.50M nodes），所以不声称 legacy 完成态或精确 speedup，仅报告相对生产预算下界 `2500/560.008 = 4.46×`；init+encode 约 `247.485 ms`，break-even 约 1 次 solve。决策 `CONTINUE_MIGRATION`，因为下界超过 3×且 Z3 multiple 已由完整阻断检查与两份独立有效 edge 解证明；这不是浏览器 Pages 性能结论。
- `validateLoopSolution` 是 legacy final gate 和 benchmark/Z3 evidence 的共享纯 validator；它不参与 Z3 求解循环，SMT 规则语义独立成立。

## 回路 Z3 Phase B（浏览器 Worker 正式提交）

- 根 `index.html` 与 `/z3-probe/index.html` 共同加载根 scope 的自有 `coi-bootstrap.js`；bootstrap 只调用原生 `navigator.serviceWorker.register` 注册同一份官方 `coi-serviceworker.js`，不执行或改写该 API。构建产物保留官方 JS/WASM 与许可证。首次无 controller 时至多自动 reload 一次，未持久化的 UI 状态可能丢失；这是 GitHub Pages 客户端补头方案的已知风险。
- 主线程只执行唯一 `compileBoard`，发送 plain `CompiledPuzzle` structured-clone payload。loop 首次提交 lazy 创建 Worker；Worker 缓存官方 browser Z3 API，requestId 保证单飞、stale response 忽略，组件卸载 terminate 并忽略结果。Z3 unknown/timeout 返回既有 timeout；初始化、unsupported 或 Worker 求解协议失败返回 `backend=legacy-fallback` 和诊断。Worker 不用 JS validator 过滤 Z3 候选。
- `npm run test:loop-z3-client` 覆盖 success、stale、duplicate、malformed/messageerror、同一 client 的 Worker crash→重建、创建异常→重试、可注入短 watchdog→terminate/reset→重试、无 Worker API 和 terminate；`npm run test:loop-z3-browser` 是构建后静态资源/懒加载审计。`npm run test:z3-probe` 还审计根/项目 mount 资源链、main 首屏不含 `z3-built`/`z3-solver`/encoder 实现、lazy loop Worker 及 probe Worker 资产。`/z3-probe/` 的 production 8×8 smoke 按钮复用同一正式 client/Worker，并验证 multiple 与两份 valid solution；真实 Playwright 结果需按当前浏览器依赖环境单独记录。
- shade/number/region 仍保持同步 legacy 路径；正式 loop 的浏览器冷启动、WASM 下载和 warm solve 不可用 Phase A Node/WSL 数字直接宣传为 Pages 性能。
- Phase B 返工后的 Node benchmark（Node `v20.20.2`, `z3-solver 5.2.0`, Linux x64）仍为 `CONTINUE_MIGRATION`：Z3 init/encoder `109.154/126.116ms`，cold legacy/Z3 `2500.209ms timeout` / `1057.000ms multiple`；legacy 7 次 `2500.065,2500.055,2500.074,2500.032,2500.155,2500.092,2500.105ms`，Z3 7 次 `144.639,180.691,512.407,717.932,758.547,816.970,443.152ms`，warm median/p95 `512.407/816.970ms`，相对生产预算下界 `4.879×`，break-even 约 1 次。legacy 10s verification 仍 timeout（22.45M nodes）；这仍不是精确 speedup 或浏览器性能结论。
