# 谜题记录簿

一个可直接部署到 GitHub Pages 的单人纸笔谜题构筑卡牌游戏框架。

后续开发请先阅读 [`CODEX_CLI_HANDOFF.md`](./CODEX_CLI_HANDOFF.md)：其中汇总了已确认的完整游戏规则、当前进度、未决事项、WSL 迁移注意事项，以及可直接交给 Codex CLI 的启动提示词。

## 技术栈

- **Vite**：开发服务器与静态构建，启动快、配置少。
- **React + TypeScript**：用组件表达卡牌，用类型清晰管理牌堆、手牌和解题区状态。
- **原生 CSS**：无需 UI 框架，用纸张纹理、手写字体和不规则边框塑造笔记手绘风。
- **GitHub Actions + GitHub Pages**：推送到 `main` 后自动构建并部署纯静态站点。

这个项目暂时不需要路由、后端、数据库或游戏引擎。规则、状态机和求解器均与 React 组件分离，方便逐步加入新的玩法与线索解释。

## 本地运行

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
npm run preview
```

求解器冒烟测试：

```bash
npm run test:solver
```

## Z3 GitHub Pages 兼容性探针（实验性）

`/z3-probe/` 是与正常游戏界面隔离的诊断页面。它固定使用官方 `z3-solver@5.2.0`（MIT），只有点击按钮后才加载应用级 Worker 和官方 Emscripten JS/WASM 资产；页面另有一个 production 8×8 loop smoke 按钮，复用正式 loop client/Worker/46-key encoder。页面提供 Z3 与 `coi-serviceworker@0.1.7` 的 MIT 许可证链接。

构建、运行 Node 侧最小模型（第一次 `sat`，加入规范答案阻断后第二次 `unsat`），并审计构建产物：

```bash
npm run test:z3-probe
```

页面会显示 `isSecureContext`、`crossOriginIsolated`、`SharedArrayBuffer`、WebAssembly、Worker、Service Worker 控制状态和当前路径。`PASS` 必须同时满足这些能力、Z3 初始化成功以及 `sat → blocking unsat`；`BLOCKED_HEADERS` 表示 Service Worker 尝试后仍缺少 `crossOriginIsolated`/`SharedArrayBuffer`，`FAIL_ASSET`、`FAIL_INIT`、`FAIL_SOLVE` 和 `UNKNOWN` 分别表示资产、初始化、求解或未知结果问题。

当前 production 构建中，官方 `z3-built.wasm` 为 34,938,413 bytes（约 8.0 MB gzip），官方 JS 为 353,813 bytes，应用级 Worker 为 162,713 bytes。WASM 下载和冷启动对移动网络、低端设备和首个点击延迟有明显风险；本探针不会把这些成本带入游戏首屏，但不能代表正式求解器迁移后的性能。

GitHub Pages 不会由本仓库工作流设置 COOP/COEP 响应头。项目根入口和 `/z3-probe/` 都加载同一个根 scope 的 `coi-bootstrap.js`；它只调用浏览器原生 `navigator.serviceWorker.register` 注册官方 `coi-serviceworker@0.1.7`，不改写该 API。首次访问会至多自动重载一次，由 Service Worker 为整个项目受控响应补充 COOP/COEP。若注册失败或浏览器不支持相应能力，正式 loop Worker 会在后台明确回退 legacy；其它玩法仍可用。这是一层客户端兼容方案，不等价于源站直接发送安全头。

要在本地做带正确响应头的对照（production `dist`，只读静态服务器）：

```bash
npm run build
npm run preview:probe -- --port=4173
```

访问 `http://127.0.0.1:4174/z3-probe/` 可复现带根 scope Service Worker 的本地验证。外置 Chromium 实测通过：首次访问 root game 自动 reload 后 `crossOriginIsolated=true`、controller 存在且 UI 正常；main/probe 首屏均无 Z3/Worker 请求；production 8×8 smoke cold/warm 分别约 1545.6/1032.6 ms，均返回 `multiple`、`backend=z3`、2 solutions，并请求 `z3-built.js/.wasm`。阻断 Service Worker 的 context 仍无 page/console/http error，小 2×2 提交由同一 Worker 返回 `unique`、`backend=legacy-fallback`；bootstrap 验证原生 `navigator.serviceWorker.register` 的 source/name/length 未改变。这只是本机浏览器样本，不是 Pages 性能基准。

## 部署到 GitHub Pages

1. 创建 GitHub 仓库并将代码推送到 `main` 分支。
2. 在仓库的 **Settings → Pages → Build and deployment** 中，将 Source 设为 **GitHub Actions**。
3. 工作流会自动构建 `dist` 并发布；也可以在 Actions 页面手动运行。

Vite 已使用相对资源路径，因此用户主页仓库和普通项目仓库都可部署，无需手动修改仓库名。

## 当前框架

- 三个不同尺寸和规则容量的盘面。
- Koburin 初始规则选择与强制数字线索放置。
- 回合、抽牌、手牌、弃牌、商店刷新和弃牌换购。
- 全局规则牌、线索牌、工具牌的数据驱动定义。
- 线索牌叠放或覆盖，以及四类移除工具。
- 盘面使用有效格集合表示；移除格子后可形成不规则盘面。
- 提交后进行完整性检查并至多寻找两个答案；只有唯一解得分。
- 基础分为所有有效线索卡分值之和；只有唯一解获得基础分，无解和多解均为 0 分。
- `ruleset.txt` 中的 159 条规则会自动解析为稳定的规则 ID、载体、玩法、点颜色适用范围与计分生效条件。
- 游戏内“规则图鉴”提供全部规则的 4×4 局部答案示例、分类筛选和结构自检；访问 `?view=rules` 可直接审查。
- 已结算盘面会刷新为相同大小的空白盘面。
- 数字线索输入统一为 0–9；catalog 的 min/max 只保留为规则元数据。
- 求解结果携带最多两个可渲染答案层，提交结果以模态显示；多解需点击“我不信”后显示“解一”“解二”。
- 游戏卡牌悬浮预览复用规则图鉴完成答案 SVG，并按 `ruleKey → SOLVER_COVERAGE → RULESET` 明确映射。

## 代码结构

- `src/game/types.ts`：领域模型与游戏动作。
- `src/game/catalog.ts`：卡牌定义及各玩法下的解释文案。
- `src/game/geometry.ts`：矩形和不规则盘面的格子、邻接关系。
- `src/game/puzzle-model.ts`：面向未来求解器的盘面快照、答案层和格/边/内部格点/外提示锚点；同时定义删除格子的保护规则。
- `src/game/ruleset.ts`：把 `ruleset.txt` 解析为数据化规则表。
- `src/game/examples.ts`：规则示例的小盘面与完成答案生成器。
- `src/game/ruleset-audit.ts`：159 条示例的锚点、答案层和同色点计分前提检查。
- `src/game/engine.ts`：纯 reducer 游戏状态机。
- `src/game/solver.ts`：规则编译注册表、提交检查和统一求解入口。
- `src/game/solver-model.ts`：编译结果与搜索结果协议。
- `src/game/solver-loop.ts`：不规则盘面的单回路、Koburin 数字与转弯/直行点求解。
- `src/game/solver-loop-z3.ts`：完整 46-key loop SMT encoder；只由 lazy loop Worker 导入。
- `src/game/loop-z3-client.ts`、`src/game/loop-z3-worker.ts`：正式 loop 提交的 requestId 协议、Z3 初始化复用、stale/duplicate/crash 处理与同 Worker legacy fallback。
- `src/game/solver-shade.ts`：涂黑连通、九宫格数字与黑白点求解。
- `src/App.tsx`：React 交互界面。
- `src/Rulebook.tsx`：游戏内规则示例图鉴。

## 正式回路提交与浏览器资源

正式 loop 提交先在主线程通过唯一的 `compileBoard` 路径编译，再将纯结构化克隆安全的 `CompiledPuzzle` 发送给 lazy Worker。Worker 首次 loop 提交才加载根 scope 下的 `assets/z3-built.js/.wasm` 并初始化 Z3；后续提交复用初始化 API。Z3 的 unknown/timeout 映射为现有“未证明”，不会偷偷改用更长预算；资产、初始化、unsupported 或 Worker 求解协议失败则在同一 Worker 明确回退 `legacy-fallback`，结果诊断显示在提交模态中。

提交期间 UI 显示 busy 状态；native `disabled`/`inert` 与 handler guard 同时阻止键盘、改盘、换牌、商店、结束回合和重复提交。提交快照绑定 state identity、serial、board revision、requestId 与组件生命周期，任何竞态状态变化都会丢弃 response，不显示旧 modal 或计分。唯一解、多解（“我不信”）、无解、计分和刷新盘面的既有行为保持不变。shade/number/region 仍使用同步 legacy solver。根 COI shim 约 2.27 KB，Z3 JS/WASM 不在正常游戏首屏请求链；WASM 下载、初始化和以下 Node benchmark 都不代表浏览器性能。首次根 scope Service Worker reload 可能丢失未持久化的当前 UI 状态，这是 Pages 客户端 shim 的已知风险。

异步协议测试：

```bash
npm run test:loop-z3-client
```

当前求解层支持涂黑、回路、填数和分区四种答案域，并已为 `ruleset.txt` 的 159 条规则建立卡牌解释、约束编译器与覆盖审计。搜索器至多寻找两个不同答案，能区分无解、多解、唯一解与超时；未注册的未来规则会返回 `unsupported` 并保留原盘面，不会被误判为无解。删除格、四类线索锚点以及跨缺口外提示均使用统一盘面模型。

规则分值目前统一为 `null`（界面显示“分值未定”），没有擅自补设数值。同色点类规则携带“至少两个同色点才计分”的元数据；线索不足时其计分贡献应为 0。外提示锚点独立于有效格集合，因此会观察整行/整列；边和内部格点锚点必须接触完整的有效格，所接触格不能被移除。
