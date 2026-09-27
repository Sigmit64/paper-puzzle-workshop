import { clueEntryForMechanic, getCard } from "./catalog";
import { solveLoop } from "./solver-loop";
import { solveNumber } from "./solver-number";
import { solveRegion } from "./solver-region";
import type { CompiledPuzzle, SolveOutcome } from "./solver-model";
import { solveShade } from "./solver-shade";
import type { BoardMechanic, BoardState, EvaluationResult } from "./types";

export type { CompiledPuzzle } from "./solver-model";

export interface RuleCompilerRegistration {
  key: string;
  supportedMechanic: BoardMechanic;
  scope: "global" | "clue";
  description: string;
}

// 每条注册项都是一个已落地的约束编译器。没有注册的规则会阻止提交，而不会被当作无解。
export const RULE_COMPILER_REGISTRY: RuleCompilerRegistration[] = [
  { key: "loop.single-cycle", supportedMechanic: "loop", scope: "global", description: "所有选中边构成一条单一闭合回路。" },
  { key: "loop.unvisited-not-adjacent", supportedMechanic: "loop", scope: "global", description: "任意两个正交相邻格不能同时未被回路经过。" },
  { key: "loop.visit-all-unclued-cells", supportedMechanic: "loop", scope: "global", description: "回路经过所有没有格内线索的格子。" },
  { key: "loop.cell-number.orthogonal-unvisited", supportedMechanic: "loop", scope: "clue", description: "数字格不经过，数字等于正交相邻未经过格数量。" },
  { key: "loop.cell-number.eight-visited", supportedMechanic: "loop", scope: "clue", description: "数字格不经过，统计八邻经过格。" },
  { key: "loop.cell-number.eight-turns", supportedMechanic: "loop", scope: "clue", description: "数字格不经过，统计八邻转弯格。" },
  { key: "loop.cell-number.eight-unvisited", supportedMechanic: "loop", scope: "clue", description: "数字格不经过，统计八邻未经过格。" },
  { key: "loop.cell-number.four-visited", supportedMechanic: "loop", scope: "clue", description: "数字格不经过，统计四邻经过格。" },
  { key: "loop.cell-number.four-turns", supportedMechanic: "loop", scope: "clue", description: "数字格不经过，统计四邻转弯格。" },
  { key: "loop.cell-number.inside-vertex-count", supportedMechanic: "loop", scope: "clue", description: "统计格子四个顶点中位于回路内部的数量。" },
  { key: "loop.cell-number.outward-segment-length-sum", supportedMechanic: "loop", scope: "clue", description: "数字格不经过，统计四邻背离线索延伸的直线回路段总长度。" },
  { key: "loop.cell-number.arm-length-sum", supportedMechanic: "loop", scope: "clue", description: "数字等于从线索格向回路两端直到下一转弯的臂长之和。" },
  { key: "loop.edge-number.segment-length", supportedMechanic: "loop", scope: "clue", description: "回路经过数字边，数字等于包含该边的最大直线回路段长度。" },
  { key: "loop.edge-number.outward-segment-length-sum", supportedMechanic: "loop", scope: "clue", description: "回路不经过数字边，统计两侧背离边线延伸的直线回路段总长度。" },
  { key: "loop.edge-number.visited-cell-count", supportedMechanic: "loop", scope: "clue", description: "边线数字统计两侧经过格。" },
  { key: "loop.vertex-number.visited-cell-count", supportedMechanic: "loop", scope: "clue", description: "格点数字统计周围四个经过格。" },
  { key: "loop.vertex-number.used-edge-count", supportedMechanic: "loop", scope: "clue", description: "格点数字统计周围四条回路边。" },
  { key: "loop.vertex-number.turn-count", supportedMechanic: "loop", scope: "clue", description: "格点数字统计周围四个转弯格。" },
  { key: "loop.cell-dot.visited", supportedMechanic: "loop", scope: "clue", description: "回路必须经过格内点。" },
  { key: "loop.cell-dot.unvisited", supportedMechanic: "loop", scope: "clue", description: "回路必须避开格内点。" },
  { key: "loop.cell-dot.unvisited-component-center-symmetric", supportedMechanic: "loop", scope: "clue", description: "点所在未经过格连通组以点为中心中心对称。" },
  { key: "loop.cell-dot.unvisited-component-axis-symmetric", supportedMechanic: "loop", scope: "clue", description: "点所在未经过格连通组关于穿过点的轴对称。" },
  { key: "loop.cell-dot.equal-arm-lengths", supportedMechanic: "loop", scope: "clue", description: "点沿回路两个方向到下一转弯的臂长相等。" },
  { key: "loop.cell-dot.unequal-arm-lengths", supportedMechanic: "loop", scope: "clue", description: "点沿回路两个方向到下一转弯的臂长不等。" },
  { key: "loop.cell-dot.arm-length-difference-one", supportedMechanic: "loop", scope: "clue", description: "点沿回路两个方向到下一转弯的臂长相差一。" },
  { key: "loop.cell-dot.straight", supportedMechanic: "loop", scope: "clue", description: "回路经过点并直行。" },
  { key: "loop.cell-dot.turn", supportedMechanic: "loop", scope: "clue", description: "回路经过点并转弯。" },
  { key: "loop.cell-dot.masyu-white", supportedMechanic: "loop", scope: "clue", description: "点处直行，前后至少一格转弯。" },
  { key: "loop.cell-dot.masyu-black", supportedMechanic: "loop", scope: "clue", description: "点处转弯，前后两格直行。" },
  { key: "loop.cell-dot.pearl-black", supportedMechanic: "loop", scope: "clue", description: "点前后两格都转弯。" },
  { key: "loop.cell-dot.pearl-white", supportedMechanic: "loop", scope: "clue", description: "点前后两格都直行。" },
  { key: "loop.edge-dot.traversed", supportedMechanic: "loop", scope: "clue", description: "回路使用点所在边线。" },
  { key: "loop.edge-dot.not-traversed", supportedMechanic: "loop", scope: "clue", description: "回路不使用点所在边线。" },
  { key: "loop.edge-dot.segment-midpoint", supportedMechanic: "loop", scope: "clue", description: "回路使用点所在边线，点为最大直线回路段中点。" },
  { key: "loop.edge-dot.split-cell-count-difference-one", supportedMechanic: "loop", scope: "clue", description: "边上点两侧直到转弯的经过格数相差一。" },
  { key: "loop.edge-dot.split-cell-count-ratio-two", supportedMechanic: "loop", scope: "clue", description: "边上点两侧直到转弯的经过格数为二倍关系。" },
  { key: "loop.edge-dot.same-cell-orientation", supportedMechanic: "loop", scope: "clue", description: "边线两侧格均经过且同为转弯或直行。" },
  { key: "loop.edge-dot.opposite-cell-orientation", supportedMechanic: "loop", scope: "clue", description: "边线两侧格均经过且一转弯一直行。" },
  { key: "loop.vertex-dot.outside", supportedMechanic: "loop", scope: "clue", description: "格点位于回路外。" },
  { key: "loop.vertex-dot.inside", supportedMechanic: "loop", scope: "clue", description: "格点位于回路内。" },
  { key: "loop.edge-dot.exactly-one-cell-visited", supportedMechanic: "loop", scope: "clue", description: "边上点两侧恰好一个格子被经过。" },
  { key: "loop.vertex-dot.more-visited", supportedMechanic: "loop", scope: "clue", description: "格点周围经过格多于未经过格。" },
  { key: "loop.vertex-dot.more-unvisited", supportedMechanic: "loop", scope: "clue", description: "格点周围未经过格多于经过格。" },
  { key: "loop.exterior-number.visited-cell-count", supportedMechanic: "loop", scope: "clue", description: "外提示统计整行或整列经过格。" },
  { key: "loop.exterior-number.parallel-segment-count", supportedMechanic: "loop", scope: "clue", description: "外提示统计行列内平行直线回路段数。" },
  { key: "loop.exterior-number.longest-parallel-segment", supportedMechanic: "loop", scope: "clue", description: "外提示给出行列内最长平行直线回路段长度。" },
  { key: "loop.exterior-number.shortest-parallel-segment", supportedMechanic: "loop", scope: "clue", description: "外提示给出行列内最短平行直线回路段长度。" },
  { key: "loop.white-dot.straight", supportedMechanic: "loop", scope: "clue", description: "回路经过白点并直行。" },
  { key: "loop.black-dot.turn", supportedMechanic: "loop", scope: "clue", description: "回路经过黑点并转弯。" },
  { key: "number.latin-1-to-n-full", supportedMechanic: "number", scope: "global", description: "所有格填 1–N，行列内数字不重复。" },
  { key: "number.latin-1-to-n-minus-one", supportedMechanic: "number", scope: "global", description: "允许留空，行列不重复且各自包含 1–N−1。" },
  { key: "number.latin-1-to-n-minus-two", supportedMechanic: "number", scope: "global", description: "允许留空，行列不重复且各自包含 1–N−2。" },
  { key: "number.digit-cells-connected-no-equal-adjacency", supportedMechanic: "number", scope: "global", description: "数字格连通且正交相邻数字不同。" },
  { key: "number.cell-number.fixed", supportedMechanic: "number", scope: "clue", description: "格内数字固定该格取值。" },
  { key: "number.edge-number.sum", supportedMechanic: "number", scope: "clue", description: "边线数字为两侧非空数字之和。" },
  { key: "number.edge-number.difference", supportedMechanic: "number", scope: "clue", description: "边线数字为两侧非空数字绝对差。" },
  { key: "number.edge-number.product", supportedMechanic: "number", scope: "clue", description: "边线数字为两侧非空数字之积。" },
  { key: "number.edge-number.contains", supportedMechanic: "number", scope: "clue", description: "边线两侧至少一格含指定数字。" },
  { key: "number.edge-number.arithmetic", supportedMechanic: "number", scope: "clue", description: "边线两侧数字可经加减乘或整除得到线索。" },
  { key: "number.vertex-number.sum", supportedMechanic: "number", scope: "clue", description: "格点数字为周围非空数字之和。" },
  { key: "number.vertex-number.contains", supportedMechanic: "number", scope: "clue", description: "格点周围至少一格含指定数字。" },
  { key: "number.vertex-number.diagonal-sums", supportedMechanic: "number", scope: "clue", description: "两组对角非空数字之和分别等于线索。" },
  { key: "number.vertex-number.diagonal-differences", supportedMechanic: "number", scope: "clue", description: "两组对角非空数字绝对差分别等于线索。" },
  { key: "number.vertex-number.diagonal-arithmetic", supportedMechanic: "number", scope: "clue", description: "两组对角数字分别可经四则运算得到线索。" },
  { key: "number.cell-dot.empty", supportedMechanic: "number", scope: "clue", description: "点所在格留空。" },
  { key: "number.cell-dot.filled", supportedMechanic: "number", scope: "clue", description: "点所在格填数。" },
  { key: "number.cell-dot.odd", supportedMechanic: "number", scope: "clue", description: "点所在格填写奇数。" },
  { key: "number.cell-dot.even", supportedMechanic: "number", scope: "clue", description: "点所在格填写偶数。" },
  { key: "number.cell-dot.same-color-equal", supportedMechanic: "number", scope: "clue", description: "所有同色格内点填相同数字。" },
  { key: "number.cell-dot.greater-than-neighbors", supportedMechanic: "number", scope: "clue", description: "点内数字大于所有相邻非空数字。" },
  { key: "number.cell-dot.less-than-neighbors", supportedMechanic: "number", scope: "clue", description: "点内数字小于所有相邻非空数字。" },
  { key: "number.edge-dot.both-filled", supportedMechanic: "number", scope: "clue", description: "边上点两侧都填数。" },
  { key: "number.edge-dot.exactly-one-filled", supportedMechanic: "number", scope: "clue", description: "边上点两侧恰一格填数。" },
  { key: "number.edge-dot.both-empty", supportedMechanic: "number", scope: "clue", description: "边上点两侧都留空。" },
  { key: "number.edge-dot.difference-one", supportedMechanic: "number", scope: "clue", description: "边上点两侧数字差一。" },
  { key: "number.edge-dot.ratio-two", supportedMechanic: "number", scope: "clue", description: "边上点两侧数字为二倍关系。" },
  { key: "number.edge-dot.sum-five", supportedMechanic: "number", scope: "clue", description: "边上点两侧数字和为五。" },
  { key: "number.edge-dot.sum-ten", supportedMechanic: "number", scope: "clue", description: "边上点两侧数字和为十。" },
  { key: "number.edge-dot.same-color-equal-sums", supportedMechanic: "number", scope: "clue", description: "所有同色边上点两侧数字和相同。" },
  { key: "number.vertex-dot.more-even", supportedMechanic: "number", scope: "clue", description: "格点周围偶数格多于奇数格。" },
  { key: "number.vertex-dot.more-odd", supportedMechanic: "number", scope: "clue", description: "格点周围奇数格多于偶数格。" },
  { key: "number.vertex-dot.more-empty", supportedMechanic: "number", scope: "clue", description: "格点周围留空格多于数字格。" },
  { key: "number.vertex-dot.more-filled", supportedMechanic: "number", scope: "clue", description: "格点周围数字格多于留空格。" },
  { key: "number.vertex-dot.clockwise-increasing", supportedMechanic: "number", scope: "clue", description: "格点周围四数可从某处起顺时针递增。" },
  { key: "number.vertex-dot.counterclockwise-increasing", supportedMechanic: "number", scope: "clue", description: "格点周围四数可从某处起逆时针递增。" },
  { key: "number.vertex-dot.exactly-one-consecutive-pair", supportedMechanic: "number", scope: "clue", description: "格点周围四数恰有一对差一。" },
  { key: "number.vertex-dot.at-least-two-consecutive-pairs", supportedMechanic: "number", scope: "clue", description: "格点周围四数至少两对差一。" },
  { key: "number.exterior-number.first-number", supportedMechanic: "number", scope: "clue", description: "外提示给出观察方向第一个非空数字。" },
  { key: "number.exterior-number.skyscraper-count", supportedMechanic: "number", scope: "clue", description: "外提示给出可见摩天楼数量。" },
  { key: "number.exterior-number.skyscraper-sum", supportedMechanic: "number", scope: "clue", description: "外提示给出可见摩天楼数字之和。" },
  { key: "number.exterior-number.first-two-contain", supportedMechanic: "number", scope: "clue", description: "外提示数字出现在前两个有效格之一。" },
  { key: "region.connected", supportedMechanic: "region", scope: "global", description: "每个区域正交连通。" },
  { key: "region.rectangles", supportedMechanic: "region", scope: "global", description: "每个区域都是矩形。" },
  { key: "region.center-symmetric", supportedMechanic: "region", scope: "global", description: "每个区域都是中心对称图形。" },
  { key: "region.exactly-one-cell-clue", supportedMechanic: "region", scope: "global", description: "每个区域恰有一个格内线索。" },
  { key: "region.all-shapes-distinct", supportedMechanic: "region", scope: "global", description: "所有区域形状在平移旋转翻转意义下互异。" },
  { key: "region.cell-number.area", supportedMechanic: "region", scope: "clue", description: "格内数字为所在区域面积。" },
  { key: "region.cell-number.adjacent-boundary-count", supportedMechanic: "region", scope: "clue", description: "格内数字为该格相邻区域边界数。" },
  { key: "region.cell-number.neighboring-region-count", supportedMechanic: "region", scope: "clue", description: "格内数字为所在区域的邻区数。" },
  { key: "region.cell-number.perimeter", supportedMechanic: "region", scope: "clue", description: "格内数字为所在区域周长。" },
  { key: "region.edge-number.area-sum", supportedMechanic: "region", scope: "clue", description: "数字边分区，数字为两区面积和。" },
  { key: "region.edge-number.area-difference", supportedMechanic: "region", scope: "clue", description: "数字边分区，数字为两区面积绝对差。" },
  { key: "region.edge-number.boundary-length", supportedMechanic: "region", scope: "clue", description: "数字边为分区边，数字为同向连续分割线长度。" },
  { key: "region.vertex-number.distinct-region-count", supportedMechanic: "region", scope: "clue", description: "格点数字为周围不同区域数。" },
  { key: "region.vertex-number.region-area-sum", supportedMechanic: "region", scope: "clue", description: "格点数字为周围不同区域面积和。" },
  { key: "region.vertex-number.distinct-shape-count", supportedMechanic: "region", scope: "clue", description: "格点数字为周围不同区域形状数。" },
  { key: "region.cell-dot.orthogonal-neighborhood-same-region", supportedMechanic: "region", scope: "clue", description: "点格及正交邻格同区。" },
  { key: "region.cell-dot.center-symmetric-about-point", supportedMechanic: "region", scope: "clue", description: "点所在区域以格中心中心对称。" },
  { key: "region.cell-dot.axis-symmetric-through-point", supportedMechanic: "region", scope: "clue", description: "点所在区域关于穿过格中心的轴对称。" },
  { key: "region.cell-dot.same-color-rotationally-congruent", supportedMechanic: "region", scope: "clue", description: "同色点所在区域允许旋转平移后全等。" },
  { key: "region.cell-dot.same-color-translation-congruent", supportedMechanic: "region", scope: "clue", description: "同色点所在区域平移全等。" },
  { key: "region.edge-dot.boundary", supportedMechanic: "region", scope: "clue", description: "点所在边线为分区边界。" },
  { key: "region.edge-dot.rotationally-congruent-regions", supportedMechanic: "region", scope: "clue", description: "点分隔的两区允许旋转平移后全等。" },
  { key: "region.edge-dot.mirrored-regions", supportedMechanic: "region", scope: "clue", description: "点分隔的两区关于边线互为镜像。" },
  { key: "region.edge-dot.center-symmetric-about-point", supportedMechanic: "region", scope: "clue", description: "点位于区域内部且是区域中心对称点。" },
  { key: "region.edge-dot.axis-symmetric-through-point", supportedMechanic: "region", scope: "clue", description: "点位于区域内部且在区域对称轴上。" },
  { key: "region.vertex-dot.three-lines", supportedMechanic: "region", scope: "clue", description: "格点恰有三条分区线。" },
  { key: "region.vertex-dot.four-lines", supportedMechanic: "region", scope: "clue", description: "格点恰有四条分区线。" },
  { key: "region.vertex-dot.zero-lines", supportedMechanic: "region", scope: "clue", description: "格点没有分区线。" },
  { key: "region.vertex-dot.center-symmetric-about-point", supportedMechanic: "region", scope: "clue", description: "格点周围同区且为区域中心对称点。" },
  { key: "region.vertex-dot.axis-symmetric-through-point", supportedMechanic: "region", scope: "clue", description: "格点周围同区且位于区域对称轴。" },
  { key: "region.exterior-number.distinct-region-count", supportedMechanic: "region", scope: "clue", description: "外提示统计整行或列的不同区域数。" },
  { key: "region.exterior-number.longest-run", supportedMechanic: "region", scope: "clue", description: "外提示为最长连续同区段长度。" },
  { key: "region.exterior-number.shortest-run", supportedMechanic: "region", scope: "clue", description: "外提示为最短连续同区段长度。" },
  { key: "region.given-edge.boundary", supportedMechanic: "region", scope: "clue", description: "给定内部边线为分区边界。" },
  { key: "shade.connected", supportedMechanic: "shade", scope: "global", description: "所有涂黑格正交连通。" },
  { key: "shade.white-connected", supportedMechanic: "shade", scope: "global", description: "所有留白格正交连通。" },
  { key: "shade.no-black-2x2", supportedMechanic: "shade", scope: "global", description: "完整 2×2 区域不能全部涂黑。" },
  { key: "shade.no-white-2x2", supportedMechanic: "shade", scope: "global", description: "完整 2×2 区域不能全部留白。" },
  { key: "shade.no-monochrome-run-3", supportedMechanic: "shade", scope: "global", description: "行列内不能连续出现三个同色格。" },
  { key: "shade.no-monochrome-run-4", supportedMechanic: "shade", scope: "global", description: "行列内不能连续出现四个同色格。" },
  { key: "shade.equal-row-column-counts", supportedMechanic: "shade", scope: "global", description: "所有行列具有相同的涂黑格数量。" },
  { key: "shade.black-cells-do-not-touch", supportedMechanic: "shade", scope: "global", description: "涂黑格不能正交或对角接触。" },
  { key: "shade.single-snake", supportedMechanic: "shade", scope: "global", description: "至少两个黑格形成单一、不分叉、不成环且不自接触的蛇。" },
  { key: "shade.cell-number.neighborhood-nine", supportedMechanic: "shade", scope: "clue", description: "数字等于自身及周围八格中的涂黑格数量。" },
  { key: "shade.cell-number.orthogonal-black", supportedMechanic: "shade", scope: "clue", description: "数字格留白，数字等于正交相邻涂黑格数量。" },
  { key: "shade.cell-number.orthogonal-plus-self-black", supportedMechanic: "shade", scope: "clue", description: "数字等于自身和正交相邻涂黑格数量。" },
  { key: "shade.cell-number.surrounding-eight-black", supportedMechanic: "shade", scope: "clue", description: "数字格留白，数字等于周围八格中的涂黑格数量。" },
  { key: "shade.cell-number.canal-view", supportedMechanic: "shade", scope: "clue", description: "数字格留白，统计四向连续黑格前缀的总长度。" },
  { key: "shade.cell-number.kurodoko", supportedMechanic: "shade", scope: "clue", description: "数字格留白，统计包含自身的四向可见白格。" },
  { key: "shade.cell-number.white-component-size", supportedMechanic: "shade", scope: "clue", description: "数字格留白，数字等于所在白格连通组大小。" },
  { key: "shade.cell-number.kurotto", supportedMechanic: "shade", scope: "clue", description: "数字格留白，统计接触到的不同黑格连通组大小之和。" },
  { key: "shade.edge-number.black-count", supportedMechanic: "shade", scope: "clue", description: "内部边线数字统计两侧涂黑格数量。" },
  { key: "shade.edge-number.component-size-sum", supportedMechanic: "shade", scope: "clue", description: "边线两侧一黑一白，数字为两个同色连通组大小之和。" },
  { key: "shade.edge-number.component-size-difference", supportedMechanic: "shade", scope: "clue", description: "边线两侧一黑一白，数字为两个同色连通组大小的绝对差。" },
  { key: "shade.vertex-number.black-count", supportedMechanic: "shade", scope: "clue", description: "内部格点数字统计周围四个涂黑格。" },
  { key: "shade.vertex-number.land-measurement", supportedMechanic: "shade", scope: "clue", description: "格点周围为棋盘格，数字为两黑格间最短黑格路径的格数。" },
  { key: "shade.exterior-number.black-count", supportedMechanic: "shade", scope: "clue", description: "外提示数字统计整行或整列涂黑格数量。" },
  { key: "shade.exterior-number.black-segment-count", supportedMechanic: "shade", scope: "clue", description: "外提示统计黑格段数量，删除格分段。" },
  { key: "shade.exterior-number.longest-black-segment", supportedMechanic: "shade", scope: "clue", description: "外提示统计最长黑格段。" },
  { key: "shade.exterior-number.first-black-segment", supportedMechanic: "shade", scope: "clue", description: "外提示统计从提示方向看到的第一段黑格长度。" },
  { key: "shade.white-dot.unshaded", supportedMechanic: "shade", scope: "clue", description: "白点格不能涂黑。" },
  { key: "shade.black-dot.shaded", supportedMechanic: "shade", scope: "clue", description: "黑点格必须涂黑。" },
  { key: "shade.cell-dot.component-center-symmetric", supportedMechanic: "shade", scope: "clue", description: "点所在同色连通组以点为中心中心对称。" },
  { key: "shade.cell-dot.component-axis-symmetric", supportedMechanic: "shade", scope: "clue", description: "点所在同色连通组关于穿过点的某条网格对称轴轴对称。" },
  { key: "shade.cell-dot.exactly-one-white-neighbor", supportedMechanic: "shade", scope: "clue", description: "点的正交邻格中恰有一个白格。" },
  { key: "shade.edge-dot.both-white", supportedMechanic: "shade", scope: "clue", description: "边上白点两侧都为白格。" },
  { key: "shade.edge-dot.exactly-one-black", supportedMechanic: "shade", scope: "clue", description: "边上点两侧恰好一黑一白。" },
  { key: "shade.edge-dot.both-black", supportedMechanic: "shade", scope: "clue", description: "边上黑点两侧都为黑格。" },
  { key: "shade.edge-dot.opposite-congruent-components", supportedMechanic: "shade", scope: "clue", description: "边两侧一黑一白，所在同色组允许旋转平移后全等。" },
  { key: "shade.edge-dot.opposite-mirrored-components", supportedMechanic: "shade", scope: "clue", description: "边两侧一黑一白，所在同色组关于边线互为镜像。" },
  { key: "shade.vertex-dot.more-black-than-white", supportedMechanic: "shade", scope: "clue", description: "格点周围黑格多于白格。" },
  { key: "shade.vertex-dot.more-white-than-black", supportedMechanic: "shade", scope: "clue", description: "格点周围白格多于黑格。" },
  { key: "shade.vertex-dot.checkerboard", supportedMechanic: "shade", scope: "clue", description: "格点周围两黑两白且形成棋盘格。" },
];

function baseScore(board: BoardState) {
  const clueIds = new Set(board.clues.map((clue) => clue.id));
  const requiresSameColorPair = new Set([
    "number.cell-dot.same-color-equal",
    "number.edge-dot.same-color-equal-sums",
    "region.cell-dot.same-color-rotationally-congruent",
    "region.cell-dot.same-color-translation-congruent",
  ]);
  return board.clueCards
    .filter((card) => card.placedClueId && clueIds.has(card.placedClueId))
    .reduce((sum, card) => {
      const definition = clueEntryForMechanic(card, board.mechanic);
      if (!definition) return sum;
      const ruleKey = board.mechanic ? definition.clue?.ruleKeys?.[board.mechanic] : undefined;
      if (ruleKey && requiresSameColorPair.has(ruleKey) && definition.clue) {
        const matchingClues = board.clues.filter((clue) => clue.kind === definition.clue!.kind).length;
        if (matchingClues < 2) return sum;
      }
      return sum + (definition.score ?? 0);
    }, 0);
}

function unsupported(board: BoardState, detail: string): EvaluationResult {
  return { boardName: board.name, status: "unsupported", baseScore: baseScore(board), awardedScore: 0, detail };
}

export function compileBoard(board: BoardState): CompiledPuzzle | EvaluationResult {
  if (!board.mechanic || board.globalCards.length === 0) {
    return unsupported(board, "盘面缺少主要玩法或全局规则，不能提交。");
  }
  const mechanic = board.mechanic;
  const activeClueDefinitions = board.clueCards.flatMap((card) => {
    const definition = clueEntryForMechanic(card, mechanic);
    return definition ? [{ card, definition }] : [];
  });
  for (const clue of board.clues) {
    const explained = activeClueDefinitions.some(({ definition }) => definition.clue?.kind === clue.kind);
    if (!explained) return unsupported(board, "盘面上存在没有任何线索牌解释的线索。");
  }

  const implicitGlobalKeys = mechanic === "loop" ? ["loop.single-cycle"] : [];
  const globalRuleKeys = [
    ...implicitGlobalKeys,
    ...board.globalCards.map((card) => getCard(card.definitionId).ruleKey).filter(Boolean) as string[],
  ];
  const clueRules = activeClueDefinitions.flatMap(({ card, definition }) => {
    if (!definition.clue || !board.clues.some((clue) => clue.kind === definition.clue!.kind)) return [];
    const key = definition.clue.ruleKeys?.[mechanic];
    return [{
      key: key ?? `${mechanic}.${definition.clue.kind}.unimplemented`,
      clueKind: definition.clue.kind,
      sourceCardInstanceId: card.instanceId,
    }];
  });

  const registry = new Map(RULE_COMPILER_REGISTRY.map((item) => [item.key, item]));
  const missing = [...globalRuleKeys, ...clueRules.map((rule) => rule.key)].filter((key) => {
    const registration = registry.get(key);
    return !registration || registration.supportedMechanic !== mechanic;
  });
  if (missing.length) return unsupported(board, `尚未实现这些规则解释：${[...new Set(missing)].join("、")}。`);
  return {
    board,
    mechanic,
    globalRuleKeys: [...new Set(globalRuleKeys)],
    clueRules,
    solutionLimit: 2,
    timeBudgetMs: 2500,
  };
}

function resultWithStats(
  board: BoardState,
  outcome: SolveOutcome,
  status: EvaluationResult["status"],
  detail: string,
  awardedScore: number,
): EvaluationResult {
  return {
    boardName: board.name,
    status,
    baseScore: baseScore(board),
    awardedScore,
    detail,
    solverStats: {
      solutionsFound: outcome.count,
      exploredNodes: outcome.exploredNodes,
      elapsedMs: Math.round(outcome.elapsedMs * 10) / 10,
    },
  };
}

export function evaluateBoard(board: BoardState): EvaluationResult {
  const compiled = compileBoard(board);
  if ("status" in compiled) return compiled;
  const solved = compiled.mechanic === "loop"
    ? solveLoop(compiled)
    : compiled.mechanic === "shade"
      ? solveShade(compiled)
      : compiled.mechanic === "number"
        ? solveNumber(compiled)
        : solveRegion(compiled);
  const base = baseScore(board);
  if (solved.timedOut && solved.count < 2) {
    return resultWithStats(board, solved, "timeout", "求解在时间预算内未能证明结论；盘面保持原样，可调整后重新提交。", 0);
  }
  if (solved.count === 0) return resultWithStats(board, solved, "unsat", "盘面无解。", 0);
  if (solved.count === 1) return resultWithStats(board, solved, "unique", "盘面具有唯一解，获得基础分。", base);
  return resultWithStats(board, solved, "multiple", "盘面有多个解，不获得分数。", 0);
}
