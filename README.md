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

`/z3-probe/` 是与正常游戏入口隔离的实验页面。它固定使用官方 `z3-solver@5.2.0`（MIT），只有点击按钮后才加载应用级 Worker 和官方 Emscripten JS/WASM 资产；它不迁移或调用游戏的 159 条正式规则。页面提供 Z3 与 `coi-serviceworker@0.1.7` 的 MIT 许可证链接。

构建、运行 Node 侧最小模型（第一次 `sat`，加入规范答案阻断后第二次 `unsat`），并审计构建产物：

```bash
npm run test:z3-probe
```

页面会显示 `isSecureContext`、`crossOriginIsolated`、`SharedArrayBuffer`、WebAssembly、Worker、Service Worker 控制状态和当前路径。`PASS` 必须同时满足这些能力、Z3 初始化成功以及 `sat → blocking unsat`；`BLOCKED_HEADERS` 表示 Service Worker 尝试后仍缺少 `crossOriginIsolated`/`SharedArrayBuffer`，`FAIL_ASSET`、`FAIL_INIT`、`FAIL_SOLVE` 和 `UNKNOWN` 分别表示资产、初始化、求解或未知结果问题。

当前 production 构建中，官方 `z3-built.wasm` 为 34,938,413 bytes（约 8.0 MB gzip），官方 JS 为 353,813 bytes，应用级 Worker 为 162,713 bytes。WASM 下载和冷启动对移动网络、低端设备和首个点击延迟有明显风险；本探针不会把这些成本带入游戏首屏，但不能代表正式求解器迁移后的性能。

GitHub Pages 不会由本仓库工作流设置 COOP/COEP 响应头。探针因此在自身 `/z3-probe/` 范围注册 `coi-serviceworker`：首次访问会自动重载，由 Service Worker 为受控响应补充 COOP/COEP。该注册不会覆盖正常游戏入口；若注册失败或浏览器不支持相应能力，探针仍判为 `BLOCKED_HEADERS`。这是一层客户端兼容方案，不等价于源站直接发送安全头。

要在本地做带正确响应头的对照（production `dist`，只读静态服务器）：

```bash
npm run build
npm run preview:probe -- --port=4173
```

访问 `http://127.0.0.1:4173/z3-probe/`，服务器附加 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp`，并为 WASM 返回 `application/wasm`。也可用 `npm run preview` 作为无源站特殊头的对照。使用临时 Playwright 1.63.0 / Chromium 153.0.8010.12（外置临时库）实测：带源站 headers 为 `PASS`，初始化 233.0 ms、两次 check 60.9/38.8 ms、总计 372.1 ms；加入 scope-limited Service Worker 后，无源站 headers 同样为 `PASS`（214.5/61.5/37.3 ms、总计 358.7 ms）。真实部署 `https://sigmit64.github.io/paper-puzzle-workshop/z3-probe/` 也已在全新浏览器 context 中通过：首次访问自动重载，随后 `crossOriginIsolated=true`，初始化 3295.9 ms、两次 check 62.0/38.9 ms、总计 3828.7 ms，无 HTTP、控制台或页面错误；正常游戏入口没有 Service Worker 注册或 Z3 请求。这只是一次真实网络样本，不是稳定性能基准。

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
- `src/game/solver-shade.ts`：涂黑连通、九宫格数字与黑白点求解。
- `src/App.tsx`：React 交互界面。
- `src/Rulebook.tsx`：游戏内规则示例图鉴。

当前求解层支持涂黑、回路、填数和分区四种答案域，并已为 `ruleset.txt` 的 159 条规则建立卡牌解释、约束编译器与覆盖审计。搜索器至多寻找两个不同答案，能区分无解、多解、唯一解与超时；未注册的未来规则会返回 `unsupported` 并保留原盘面，不会被误判为无解。删除格、四类线索锚点以及跨缺口外提示均使用统一盘面模型。

规则分值目前统一为 `null`（界面显示“分值未定”），没有擅自补设数值。同色点类规则携带“至少两个同色点才计分”的元数据；线索不足时其计分贡献应为 0。外提示锚点独立于有效格集合，因此会观察整行/整列；边和内部格点锚点必须接触完整的有效格，所接触格不能被移除。
