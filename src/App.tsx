import { useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cardEntries, clueEntryForMechanic, getCard } from "./game/catalog";
import { createInitialGame, gameReducer } from "./game/engine";
import { parseCellId } from "./game/geometry";
import { anchorKindForClue, clueAnchorOf, validateInternalAnchor } from "./game/puzzle-model";
import { compileBoard, evaluateCompiledBoard } from "./game/solver";
import type { LoopZ3Client } from "./game/loop-z3-client";
import { SOLVER_COVERAGE } from "./game/solver-coverage";
import { RULESET, type RuleEntry } from "./game/ruleset";
import { createRuleExample } from "./game/examples";
import { ExampleBoard } from "./Rulebook";
import type { BoardMechanic, BoardState, CardDefinition, CardInstance, CellId, ClueAnchor, DraftPoint, EvaluationResult, GameState, ShopOffer } from "./game/types";
import type { PuzzleSolutionLayers } from "./game/puzzle-model";
import { displayRuleText } from "./rule-display";

const MECHANIC_NAMES: Record<BoardMechanic, string> = { shade: "涂黑", loop: "回路", number: "填数", region: "分区" };
const KIND_NAMES = { global: "全局规则", clue: "线索", tool: "工具" } as const;
const CLUE_NAMES: Record<string, string> = {
  "cell-number": "格内数字", "white-dot": "格内白点", "black-dot": "格内黑点",
  "edge-white-dot": "边上白点", "edge-black-dot": "边上黑点",
  "vertex-white-dot": "格点白点", "vertex-black-dot": "格点黑点",
  "edge-number": "边上数字", "vertex-number": "格点数字", "exterior-number": "外提示数", "given-edge": "给定边",
};
type Dispatch = React.Dispatch<Parameters<typeof gameReducer>[1]>;
type DraftTool = "pointer" | "pencil" | "eraser";

function entriesFor(card: Pick<CardInstance, "definitionId" | "entryDefinitionIds">) {
  return cardEntries(card);
}

function cardTitle(card: Pick<CardInstance, "definitionId" | "entryDefinitionIds">) {
  const entries = entriesFor(card);
  const first = entries[0];
  return first.kind === "clue" && first.clue ? CLUE_NAMES[first.clue.kind] : first.name;
}

function ruleForDefinition(definition: CardDefinition, mechanic?: BoardMechanic): RuleEntry | undefined {
  const key = definition.ruleKey ?? (mechanic ? definition.clue?.ruleKeys?.[mechanic] : undefined);
  const coverage = key ? SOLVER_COVERAGE.find((entry) => entry.ruleKey === key) : undefined;
  return coverage ? RULESET[coverage.ordinal - 1] : undefined;
}

function RuleTooltip({ card, mechanic, previewMechanic }: { card: Pick<CardInstance, "definitionId" | "entryDefinitionIds">; mechanic: BoardMechanic | null; previewMechanic?: BoardMechanic }) {
  const entries = entriesFor(card);
  const selectedMechanic = mechanic ?? previewMechanic;
  if (!entries.length) return null;
  const hostRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const closeTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number }>({ left: 12, top: 12, maxHeight: 240 });
  useEffect(() => {
    const host = hostRef.current;
    const trigger = host?.parentElement;
    if (!trigger) return undefined;
    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(620, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const safe = 12;
      const aboveSpace = Math.max(0, rect.top - safe);
      const belowSpace = Math.max(0, window.innerHeight - rect.bottom - safe);
      if (aboveSpace >= belowSpace) setPosition({ left, bottom: Math.max(safe, window.innerHeight - rect.top + safe), maxHeight: Math.max(80, aboveSpace - 8) });
      else setPosition({ left, top: Math.min(window.innerHeight - safe, rect.bottom + safe), maxHeight: Math.max(80, belowSpace - 8) });
    };
    const show = () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); place(); setOpen(true); };
    const hide = () => { closeTimer.current = window.setTimeout(() => setOpen(false), 140); };
    trigger.addEventListener("mouseenter", show);
    trigger.addEventListener("mouseleave", hide);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { trigger.removeEventListener("mouseenter", show); trigger.removeEventListener("mouseleave", hide); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); if (closeTimer.current) window.clearTimeout(closeTimer.current); };
  }, []);
  const cancelClose = () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); };
  const hidePortal = () => { closeTimer.current = window.setTimeout(() => setOpen(false), 140); };
  const content = <span className="rule-tooltip portal-tooltip" role="tooltip" id={tooltipId} style={{ left: position.left, top: position.top, bottom: position.bottom, maxHeight: position.maxHeight }} onMouseEnter={cancelClose} onMouseLeave={hidePortal}>
    {entries.map((definition) => { const entryMechanic = selectedMechanic && definition.kind === "clue" && definition.supportedMechanics.includes(selectedMechanic) ? selectedMechanic : definition.supportedMechanics[0]; const rule = ruleForDefinition(definition, entryMechanic); return <span className="tooltip-entry" key={definition.id}><strong>{definition.name}</strong><b>{definition.kind === "tool" ? "工具" : definition.kind === "global" ? "全局规则" : MECHANIC_NAMES[entryMechanic!]}</b><span>{rule ? displayRuleText(rule.text) : definition.kind === "clue" && entryMechanic ? definition.clue?.interpretations[entryMechanic] ?? definition.summary : definition.summary}</span>{rule ? <ExampleBoard example={createRuleExample(rule)} /> : definition.kind !== "tool" && <em>该内建玩法暂无规则图鉴条目。</em>}</span>; })}
  </span>;
  return <><span ref={hostRef} className="tooltip-registration" aria-hidden="true" />{open && createPortal(content, document.body)}</>;
}

function SolutionBoard({ board, solution }: { board: BoardState; solution: PuzzleSolutionLayers }) {
  const size = 32, pad = 18;
  const regionAt = (row: number, column: number) => solution.regions?.[`${row}:${column}` as CellId];
  return <svg className="solution-board" viewBox={`0 0 ${board.columns * size + pad * 2} ${board.rows * size + pad * 2}`} role="img" aria-label={`${board.name}提交时答案`}>
    {board.activeCells.map((cell) => { const [row, column] = cell.split(":").map(Number); const region = solution.regions?.[cell]; return <rect key={cell} className={`solution-cell ${solution.shading?.[cell] === "black" ? "solution-black" : ""} ${region ? `solution-region-${region}` : ""}`} x={pad + column * size} y={pad + row * size} width={size} height={size} />; })}
    {Object.entries(solution.regions ?? {}).flatMap(([cell, region]) => { const [row, column] = cell.split(":").map(Number); const x = pad + column * size, y = pad + row * size; const sides = [{ k: "t", show: row === 0 || regionAt(row - 1, column) !== region, x1: x, y1: y, x2: x + size, y2: y }, { k: "l", show: column === 0 || regionAt(row, column - 1) !== region, x1: x, y1: y, x2: x, y2: y + size }, { k: "r", show: column === board.columns - 1 || regionAt(row, column + 1) !== region, x1: x + size, y1: y, x2: x + size, y2: y + size }, { k: "b", show: row === board.rows - 1 || regionAt(row + 1, column) !== region, x1: x, y1: y + size, x2: x + size, y2: y + size }]; return sides.filter((side) => side.show).map((side) => <line className="solution-border" key={`${cell}-${side.k}`} x1={side.x1} y1={side.y1} x2={side.x2} y2={side.y2} />); })}
    {(solution.loop ?? []).map((segment, index) => { const [fr, fc] = segment.from.split(":").map(Number), [tr, tc] = segment.to.split(":").map(Number); return <line className="solution-loop" key={index} x1={pad + (fc + .5) * size} y1={pad + (fr + .5) * size} x2={pad + (tc + .5) * size} y2={pad + (tr + .5) * size} />; })}
    {Object.entries(solution.numbers ?? {}).map(([cell, value]) => { const [row, column] = cell.split(":").map(Number); return <text className="solution-number" key={cell} x={pad + (column + .5) * size} y={pad + (row + .5) * size + 5}>{value || ""}</text>; })}
    {board.clues.map((clue) => { const anchor = clueAnchorOf(clue); if (!anchor) return null; let x = pad, y = pad; if (anchor.kind === "cell") { const [row, column] = anchor.cell.split(":").map(Number); x += (column + .5) * size; y += (row + .5) * size; } else if (anchor.kind === "edge") { x += (anchor.orientation === "vertical" ? anchor.column : anchor.column + .5) * size; y += (anchor.orientation === "horizontal" ? anchor.row : anchor.row + .5) * size; } else if (anchor.kind === "vertex") { x += anchor.column * size; y += anchor.row * size; } else { x += anchor.side === "left" ? -10 : anchor.side === "right" ? board.columns * size + 10 : (anchor.index + .5) * size; y += anchor.side === "top" ? -10 : anchor.side === "bottom" ? board.rows * size + 10 : (anchor.index + .5) * size; } const color = clue.kind.includes("white") ? "white" : clue.kind.includes("black") ? "black" : undefined; return <g key={clue.id} className={`solution-clue ${color ?? "number"}`}><circle cx={x} cy={y} r={color ? 5 : 7} />{!color && <text x={x} y={y + 3}>{clue.value}</text>}</g>; })}
  </svg>;
}

function EvaluationModal({ modal, onClose, returnFocusRef }: { modal: { board: BoardState; result: EvaluationResult }; onClose: () => void; returnFocusRef: React.RefObject<HTMLButtonElement | null> }) {
  const { board, result } = modal; const [showMultiple, setShowMultiple] = useState(false); const showSolutions = result.status === "unique" || (result.status === "multiple" && showMultiple); const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; dialog.showModal(); const first = dialog.querySelector<HTMLElement>("button"); first?.focus(); const onKeyDown = (event: KeyboardEvent) => { if (event.key !== "Tab") return; const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")]; if (!focusable.length) return; const firstFocusable = focusable[0], lastFocusable = focusable[focusable.length - 1]; if (event.shiftKey && document.activeElement === firstFocusable) { event.preventDefault(); lastFocusable.focus(); } else if (!event.shiftKey && document.activeElement === lastFocusable) { event.preventDefault(); firstFocusable.focus(); } }; dialog.addEventListener("keydown", onKeyDown); return () => { dialog.removeEventListener("keydown", onKeyDown); if (dialog.open) dialog.close(); }; }, []);
  const close = () => { if (dialogRef.current?.open) dialogRef.current.close(); onClose(); window.setTimeout(() => returnFocusRef.current?.focus(), 0); };
  return <dialog ref={dialogRef} className={`evaluation-modal evaluation-modal-${result.status}`} onCancel={(event) => { event.preventDefault(); close(); }} aria-labelledby="evaluation-title"><button className="modal-close" onClick={close} aria-label="关闭提交结果">×</button><p className="eyebrow">提交结果</p><h2 id="evaluation-title">{result.status === "unique" ? "唯一解" : result.status === "multiple" ? "多解" : result.status === "unsat" ? "无解" : result.status === "timeout" ? "未证明" : "不支持"}</h2><p>{result.detail}</p>{result.solverStats?.backend && <p className="solver-diagnostic">求解后端：{result.solverStats.backend}{result.solverStats.diagnostic ? ` · ${result.solverStats.diagnostic}` : ""}</p>}{result.status === "unique" && <div className="celebration" aria-label="庆祝">✦　✓　✦</div>}{result.status === "multiple" && !showMultiple && <button className="primary-button disbelief-button" onClick={() => setShowMultiple(true)}>我不信</button>}{showSolutions && result.solutions?.length ? <div className="solution-compare">{result.solutions.map((solution, index) => <figure key={index}><figcaption>{result.status === "multiple" ? (index === 0 ? "解一" : "解二") : "唯一解"}</figcaption><SolutionBoard board={board} solution={solution} /></figure>)}</div> : null}<div className="modal-score">基础分 {result.baseScore} · 获得 {result.awardedScore}</div><button className="modal-dismiss" onClick={close}>关闭</button></dialog>;
}

function BoardView({ board, state, dispatch, previewMechanic, onPreviewMechanic }: { board: BoardState; state: GameState; dispatch: Dispatch; previewMechanic?: BoardMechanic; onPreviewMechanic: (mechanic: BoardMechanic) => void }) {
  const [draftTool, setDraftTool] = useState<DraftTool>("pointer");
  const [previewStroke, setPreviewStroke] = useState<DraftPoint[] | null>(null);
  const width = board.columns * 50;
  const height = board.rows * 50;
  const margin = 28;
  const pendingForBoard = state.pending?.boardId === board.id;
  const pendingCard = state.pending?.kind === "place-clue" ? state.pending.card : undefined;
  const pendingDefinition = pendingCard ? clueEntryForMechanic(pendingCard, board.mechanic) : undefined;
  const pendingIsNumber = state.pending?.kind === "place-clue" && entriesFor(state.pending.card).some((entry) => entry.clue && ["cell-number", "edge-number", "vertex-number", "exterior-number"].includes(entry.clue.kind));
  const pendingValue = state.pending?.kind === "place-clue" ? state.pending.value : undefined;
  const pendingAnchorKind = pendingDefinition?.clue ? anchorKindForClue(pendingDefinition.clue.kind) : undefined;
  const pendingToolEffect = state.pending?.kind === "use-tool" ? state.pending.effect : undefined;
  const clueCell = (clue: BoardState["clues"][number]) => {
    const anchor = clueAnchorOf(clue);
    return anchor?.kind === "cell" ? anchor.cell : undefined;
  };

  useEffect(() => {
    if (state.pending) setDraftTool("pointer");
  }, [state.pending]);

  function anchorPoint(anchor: ClueAnchor): [number, number] {
    if (anchor.kind === "cell") {
      const { row, column } = parseCellId(anchor.cell);
      return [column * 50 + 25, row * 50 + 25];
    }
    if (anchor.kind === "edge") return anchor.orientation === "vertical" ? [anchor.column * 50, anchor.row * 50 + 25] : [anchor.column * 50 + 25, anchor.row * 50];
    if (anchor.kind === "vertex") return [anchor.column * 50, anchor.row * 50];
    if (anchor.side === "top") return [anchor.index * 50 + 25, -18];
    if (anchor.side === "bottom") return [anchor.index * 50 + 25, height + 18];
    if (anchor.side === "left") return [-18, anchor.index * 50 + 25];
    return [width + 18, anchor.index * 50 + 25];
  }

  function placementAnchors(): ClueAnchor[] {
    if (!pendingForBoard || state.pending?.kind !== "place-clue" || !pendingAnchorKind) return [];
    const anchors: ClueAnchor[] = [];
    if (pendingAnchorKind === "cell") return board.activeCells.map((cell) => ({ kind: "cell", cell }));
    if (pendingAnchorKind === "edge") {
      for (let row = 0; row < board.rows; row += 1) for (let column = 1; column < board.columns; column += 1) anchors.push({ kind: "edge", orientation: "vertical", row, column });
      for (let row = 1; row < board.rows; row += 1) for (let column = 0; column < board.columns; column += 1) anchors.push({ kind: "edge", orientation: "horizontal", row, column });
    } else if (pendingAnchorKind === "vertex") {
      for (let row = 1; row < board.rows; row += 1) for (let column = 1; column < board.columns; column += 1) anchors.push({ kind: "vertex", row, column });
    } else {
      for (let index = 0; index < board.columns; index += 1) anchors.push({ kind: "exterior", side: "top", index }, { kind: "exterior", side: "bottom", index });
      for (let index = 0; index < board.rows; index += 1) anchors.push({ kind: "exterior", side: "left", index }, { kind: "exterior", side: "right", index });
    }
    return anchors.filter((anchor) => validateInternalAnchor(board, anchor));
  }

  function handleCell(cell: CellId) {
    if (!pendingForBoard) return;
    if (state.pending?.kind === "place-clue" && pendingAnchorKind === "cell") dispatch({ type: "place-pending-clue", anchor: { kind: "cell", cell } });
    else if (pendingToolEffect === "remove-cell") dispatch({ type: "apply-tool", targetId: cell });
    else if (pendingToolEffect === "remove-clue") {
      const clue = board.clues.find((item) => clueCell(item) === cell);
      if (clue) dispatch({ type: "apply-tool", targetId: clue.id });
    }
  }

  function pointFromEvent(event: React.PointerEvent<SVGRectElement>): DraftPoint | null {
    const svg = event.currentTarget.ownerSVGElement;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    try {
      const screenPoint = svg.createSVGPoint();
      screenPoint.x = event.clientX;
      screenPoint.y = event.clientY;
      const point = screenPoint.matrixTransform(ctm.inverse());
      return Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
    } catch {
      return null;
    }
  }

  function eraseAt(point: DraftPoint) {
    dispatch({ type: "erase-draft-at", boardId: board.id, x: point.x, y: point.y, radius: 11 });
  }

  const pathFor = (points: DraftPoint[]) => points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");

  return (
    <section className="board-workspace">
      <div className="board-canvas-panel">
        <div className="board-heading"><span><strong>{board.name}</strong><small>{board.rows}×{board.columns} · {board.activeCells.length} 格</small></span><span className="mechanic-tag">{board.mechanic ? MECHANIC_NAMES[board.mechanic] : "尚无主规则"}</span></div>
        <div className="draft-toolbar" aria-label="草稿工具">
          <button className={draftTool === "pointer" ? "active-tool" : ""} onClick={() => setDraftTool("pointer")} disabled={!!state.pending}>选择</button>
          <button className={draftTool === "pencil" ? "active-tool" : ""} onClick={() => setDraftTool("pencil")} disabled={!!state.pending}>✎ 铅笔</button>
          <button className={draftTool === "eraser" ? "active-tool" : ""} onClick={() => setDraftTool("eraser")} disabled={!!state.pending}>⌫ 橡皮</button>
          <button onClick={() => dispatch({ type: "clear-draft", boardId: board.id })} disabled={!board.draftStrokes.length}>清稿</button><span>{board.draftStrokes.length} 笔</span>
        </div>
        <svg className={`puzzle-grid draft-${draftTool}`} viewBox={`${-margin} ${-margin} ${width + margin * 2} ${height + margin * 2}`} role="img" aria-label={`${board.name}盘面`}>
          {board.activeCells.map((cell) => {
            const { row, column } = parseCellId(cell);
            const clue = board.clues.find((item) => clueCell(item) === cell);
            const isTarget = pendingForBoard && ((state.pending?.kind === "place-clue" && pendingAnchorKind === "cell") || pendingToolEffect === "remove-cell" || (pendingToolEffect === "remove-clue" && !!clue));
            return <g key={cell} className={isTarget ? "grid-cell targetable" : "grid-cell"} onClick={() => handleCell(cell)}><rect x={column * 50 + 1} y={row * 50 + 1} width="48" height="48" />{clue?.kind === "cell-number" && <text x={column * 50 + 25} y={row * 50 + 33}>{clue.value}</text>}{clue?.kind === "white-dot" && <circle className="white-dot" cx={column * 50 + 25} cy={row * 50 + 25} r="11" />}{clue?.kind === "black-dot" && <circle className="black-dot" cx={column * 50 + 25} cy={row * 50 + 25} r="11" />}</g>;
          })}
          {board.clues.flatMap((clue) => {
            const anchor = clueAnchorOf(clue);
            if (!anchor || anchor.kind === "cell") return [];
            const [x, y] = anchorPoint(anchor);
            const removable = pendingForBoard && state.pending?.kind === "use-tool" && state.pending.effect === "remove-clue";
            const dotColor = clue.kind.includes("white-dot") ? "white" : clue.kind.includes("black-dot") ? "black" : undefined;
            return [<g key={clue.id} className={`anchor-clue ${dotColor ? `${dotColor}-anchor-dot` : ""} ${removable ? "targetable" : ""}`} onClick={() => removable && dispatch({ type: "apply-tool", targetId: clue.id })}><circle cx={x} cy={y} r={dotColor ? 7 : 10} />{!dotColor && <text x={x} y={y + 5}>{clue.value}</text>}</g>];
          })}
          {placementAnchors().map((anchor) => { const [x, y] = anchorPoint(anchor); return <circle key={JSON.stringify(anchor)} className="anchor-target" cx={x} cy={y} r="11" onClick={() => dispatch({ type: "place-pending-clue", anchor })} />; })}
          <g className="draft-layer">{board.draftStrokes.map((stroke) => <path key={stroke.id} d={pathFor(stroke.points)} />)}{previewStroke && <path className="draft-preview" d={pathFor(previewStroke)} />}</g>
          {draftTool !== "pointer" && <rect className="draft-hit-area" x={-margin} y={-margin} width={width + margin * 2} height={height + margin * 2} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); const point = pointFromEvent(event); if (!point) return; if (draftTool === "pencil") setPreviewStroke([point]); else eraseAt(point); }} onPointerMove={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const point = pointFromEvent(event); if (!point) return; if (draftTool === "pencil") setPreviewStroke((current) => current ? [...current, point] : [point]); else eraseAt(point); }} onPointerUp={(event) => { if (draftTool === "pencil" && previewStroke?.length) dispatch({ type: "add-draft-stroke", boardId: board.id, stroke: { id: `draft-${Date.now()}`, points: previewStroke } }); setPreviewStroke(null); event.currentTarget.releasePointerCapture(event.pointerId); }} />}
        </svg>
      </div>

      <aside className="played-rules-panel">
        <div className="capacity-row"><span>规则容量</span><strong>{board.globalCards.length + board.clueCards.length}/{board.ruleCapacity}</strong></div>
        <div className="capacity-track"><span style={{ width: `${Math.min(100, ((board.globalCards.length + board.clueCards.length) / board.ruleCapacity) * 100)}%` }} /></div>
        <h3>已打出的卡牌</h3>
        {!board.mechanic && board.clueCards.length > 0 && <div className="preview-mechanic-picker" aria-label="玩法预览选择"><span>玩法预览（仅预览，不建立玩法）</span><div>{(Object.keys(MECHANIC_NAMES) as BoardMechanic[]).map((mechanic) => <button key={mechanic} className={previewMechanic === mechanic ? "selected-preview" : ""} onClick={() => onPreviewMechanic(mechanic)}>{MECHANIC_NAMES[mechanic]}</button>)}</div></div>}
        {state.pending?.kind === "place-clue" && pendingForBoard && <section className="pending-panel"><div><p className="eyebrow">放置线索</p><h2>{cardTitle(state.pending.card)}</h2><p>{board.mechanic ? pendingDefinition?.summary : "盘面尚无主规则；线索会先放置，玩法解释稍后确定。"}</p></div>{pendingIsNumber && <div className="number-picker" aria-label="线索数字（0–9）">{Array.from({ length: 10 }, (_, value) => <button key={value} className={pendingValue === value ? "active-number" : ""} onClick={() => dispatch({ type: "set-pending-clue-value", value })}>{value}</button>)}</div>}</section>}
        <div className="played-card-list">
          {board.globalCards.map((card) => <button key={card.instanceId} className="played-card global-chip" onClick={() => state.pending?.kind === "use-tool" && state.pending.effect === "remove-global-card" && dispatch({ type: "apply-tool", targetId: card.instanceId })}><span>{getCard(card.definitionId).name}</span><small>{getCard(card.definitionId).summary}</small><RuleTooltip card={card} mechanic={board.mechanic} previewMechanic={previewMechanic} /></button>)}
          {board.clueCards.map((card) => <button key={card.instanceId} className={`played-card clue-chip ${card.placedClueId ? "" : "inactive-chip"}`} onClick={() => state.pending?.kind === "use-tool" && state.pending.effect === "remove-clue-card" && dispatch({ type: "apply-tool", targetId: card.instanceId })}><span>{cardTitle(card)} · {entriesFor(card).length} 词条</span><small>{board.mechanic ? clueEntryForMechanic(card, board.mechanic)?.summary ?? "无该玩法解释" : previewMechanic ? clueEntryForMechanic(card, previewMechanic)?.summary ?? "无该玩法解释" : "等待选择预览玩法"}</small><RuleTooltip card={card} mechanic={board.mechanic} previewMechanic={previewMechanic} /></button>)}
          {!board.globalCards.length && !board.clueCards.length && <p className="empty-copy">这里还是一张空白稿纸。可以先打出线索牌，再决定主要玩法。</p>}
        </div>
      </aside>
    </section>
  );
}

function HandCard({ card, state, dispatch }: { card: CardInstance; state: GameState; dispatch: Dispatch }) {
  const definition = getCard(card.definitionId);
  const entries = entriesFor(card);
  const selected = state.selectedForTrade.includes(card.id);
  const board = state.boards.find((item) => item.id === state.selectedBoardId)!;
  const clueKind = entries.find((entry) => entry.clue)?.clue?.kind;
  const replaceTarget = definition.kind === "clue" ? board.clueCards.find((item) => entriesFor(item).some((entry) => entry.clue?.kind === clueKind)) : undefined;
  return (
    <article className={`hand-card kind-${definition.kind} ${selected ? "trade-selected" : ""}`}>
      <div className="card-topline"><span>{KIND_NAMES[definition.kind]}</span><strong>{definition.kind === "clue" ? `${entries.length} 词条` : ""}</strong></div>
      <h3>{cardTitle(card)}</h3>
      {definition.kind === "clue" ? <div className="entry-list">{entries.map((entry) => { const mechanic = entry.supportedMechanics[0]; return <p key={entry.id}><b>{mechanic && MECHANIC_NAMES[mechanic]}</b>{entry.summary}</p>; })}</div> : <p className="single-summary">{definition.summary}</p>}
      <RuleTooltip card={card} mechanic={board.mechanic} />
      <div className="card-actions"><button onClick={() => dispatch({ type: "play-card", cardInstanceId: card.id })} disabled={!!state.pending || state.phase !== "playing"}>打出</button>{replaceTarget && <button onClick={() => dispatch({ type: "play-card", cardInstanceId: card.id, replaceInstanceId: replaceTarget.instanceId })} disabled={!!state.pending}>覆盖</button>}<button className={selected ? "selected-action" : ""} onClick={() => dispatch({ type: "toggle-trade-card", cardInstanceId: card.id })} disabled={!!state.pending}>{selected ? "已选" : "交易"}</button></div>
    </article>
  );
}

function ShopCard({ offer, state, dispatch }: { offer: ShopOffer; state: GameState; dispatch: Dispatch }) {
  const definition = getCard(offer.definitionId);
  const card = { definitionId: offer.definitionId, entryDefinitionIds: offer.entryDefinitionIds };
  return <button className="shop-offer" onClick={() => dispatch({ type: "buy-offer", offerId: offer.id })} disabled={state.selectedForTrade.length < offer.cost || !!state.pending}><span><strong>{cardTitle(card)}</strong><small>{definition.kind === "clue" ? `${entriesFor(card).length} 个玩法词条` : definition.summary}</small></span><b>弃 {offer.cost}</b><RuleTooltip card={card} mechanic={null} /></button>;
}

export default function App() {
  const [state, dispatch] = useReducer(gameReducer, undefined, createInitialGame);
  const [activeTab, setActiveTab] = useState<string>("small");
  const [previewMechanics, setPreviewMechanics] = useState<Partial<Record<string, BoardMechanic>>>({});
  const [evaluationModal, setEvaluationModal] = useState<{ board: BoardState; result: EvaluationResult } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const loopClientRef = useRef<LoopZ3Client | undefined>(undefined);
  const submissionToken = useRef(0);
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const selectedBoard = state.boards.find((board) => board.id === state.selectedBoardId)!;
  const visibleBoard = state.boards.find((board) => board.id === activeTab) ?? selectedBoard;
  const shopGroups = useMemo(() => (["global", "clue", "tool"] as const), []);

  useEffect(() => { if (state.pending) setActiveTab(state.pending.boardId); }, [state.pending]);
  useEffect(() => () => { submissionToken.current += 1; loopClientRef.current?.terminate(); }, []);

  function switchBoard(boardId: string) {
    if (state.pending || isSubmitting) return;
    dispatch({ type: "select-board", boardId });
    setActiveTab(boardId);
  }

  async function submitBoard() {
    if (state.pending || isSubmitting) return;
    const board = selectedBoard;
    const token = ++submissionToken.current;
    const submittedState = state;
    const submittedSerial = state.serial;
    const submittedRevision = board.revision;
    setEvaluationModal(null);
    setIsSubmitting(true);
    try {
      const compiled = compileBoard(board);
      const result = "status" in compiled
        ? compiled
        : compiled.mechanic === "loop"
          ? await (loopClientRef.current ??= new (await import("./game/loop-z3-client")).LoopZ3Client()).solve(compiled)
          : evaluateCompiledBoard(compiled);
      const currentBoard = latestStateRef.current.boards.find((candidate) => candidate.id === board.id);
      if (submissionToken.current !== token || latestStateRef.current !== submittedState || latestStateRef.current.serial !== submittedSerial || currentBoard?.revision !== submittedRevision) return;
      setEvaluationModal({ board, result });
      dispatch({ type: "resolve-board", boardId: board.id, result });
    } catch (error) {
      if (submissionToken.current !== token || latestStateRef.current !== submittedState || latestStateRef.current.serial !== submittedSerial) return;
      setEvaluationModal({ board, result: { boardName: board.name, status: "timeout", baseScore: 0, awardedScore: 0, detail: `后台求解器发生错误，盘面未结算，可重试。${error instanceof Error ? ` ${error.message}` : ""}`, solverStats: { solutionsFound: 0, exploredNodes: 0, elapsedMs: 0, diagnostic: "worker-error" } } });
    } finally {
      if (submissionToken.current === token) setIsSubmitting(false);
    }
  }

  const guardedDispatch: Dispatch = (action) => { if (!isSubmitting) dispatch(action); };

  return (
    <main className={`game-shell${isSubmitting ? " is-solving" : ""}`} aria-busy={isSubmitting}>
      <header className="topbar"><div><p className="eyebrow">纸笔谜题构筑游戏</p><h1>谜题工坊</h1></div><div className="game-stats"><a className="rulebook-link" href="?view=rules">规则图鉴</a><span>回合 <strong>{state.round}/{state.maxRounds}</strong></span><span>总分 <strong>{state.score}</strong></span><span>牌堆 <strong>{state.deck.length}</strong></span></div></header>
      <section className="message-strip" aria-live="polite" inert={isSubmitting || undefined}><span className="scribble">✎</span><span>{isSubmitting ? "正在后台求解回路，请稍候…" : state.message}</span>{!isSubmitting && state.pending && !(state.pending.kind === "place-clue" && state.pending.fromSetup) && <button onClick={() => guardedDispatch({ type: "cancel-pending" })}>取消</button>}</section>
      <nav className="workspace-tabs" aria-label="工作区" inert={isSubmitting || undefined}>{state.boards.map((board) => <button key={board.id} className={activeTab === board.id ? "active-tab" : ""} onClick={() => switchBoard(board.id)} disabled={isSubmitting || (!!state.pending && state.pending.boardId !== board.id)}><span>{board.name}</span><small>{board.rows}×{board.columns} · {board.globalCards.length + board.clueCards.length}/{board.ruleCapacity}</small></button>)}<button className={activeTab === "shop" ? "active-tab" : ""} onClick={() => !isSubmitting && !state.pending && setActiveTab("shop")} disabled={isSubmitting || !!state.pending}><span>商店</span><small>四种主规则</small></button></nav>

      <section className="main-stage" inert={isSubmitting || undefined}>
        {state.phase === "setup" && !state.pending ? <section className="setup-panel"><p className="eyebrow">开局准备</p><h2>在哪张纸上开始第一道题？</h2><p>选择后建立 Koburin，并立即放置第一枚格内数字。</p><div className="setup-actions">{state.boards.map((board) => <button key={board.id} onClick={() => { if (isSubmitting) return; setActiveTab(board.id); guardedDispatch({ type: "choose-start-board", boardId: board.id }); }} disabled={isSubmitting}>{board.name}<small>{board.rows}×{board.columns} · 容量 {board.ruleCapacity}</small></button>)}</div></section>
        : activeTab === "shop" ? <section className="shop-page"><div className="section-title"><div><p className="eyebrow">弃牌换购</p><h2>商店</h2></div><span className="trade-count">已选 {state.selectedForTrade.length} 张手牌</span></div><div className="shop-columns">{shopGroups.map((kind) => <section className={`shop-group shop-${kind}`} key={kind}><h3>{KIND_NAMES[kind]}</h3><p>{kind === "global" ? "四种玩法各一张，统一弃 2 张。" : "价格仍按 1 / 2 / 3 张排列。"}</p>{state.shop.filter((offer) => getCard(offer.definitionId).kind === kind).map((offer) => <ShopCard key={offer.id} offer={offer} state={state} dispatch={dispatch} />)}</section>)}</div></section>
        : <BoardView board={visibleBoard} state={state} dispatch={guardedDispatch} previewMechanic={previewMechanics[visibleBoard.id]} onPreviewMechanic={(mechanic) => !isSubmitting && setPreviewMechanics((current) => ({ ...current, [visibleBoard.id]: mechanic }))} />}

        {activeTab !== "shop" && state.phase !== "setup" && <div className="board-actions"><span>当前：{selectedBoard.name}</span><button ref={submitButtonRef} onClick={submitBoard} disabled={isSubmitting || !!state.pending || !selectedBoard.mechanic}>{isSubmitting ? "求解中…" : "提交盘面"}</button><button className="primary-button" onClick={() => guardedDispatch({ type: "end-round" })} disabled={state.phase !== "playing" || isSubmitting || !!state.pending}>{state.round === state.maxRounds ? "结束游戏" : "结束回合（弃掉手牌）→"}</button></div>}
      </section>

      <section className="hand-section" inert={isSubmitting || undefined}><div className="hand-heading"><span><b>手牌 {state.hand.length}/7</b> · 回合结束全部弃置</span><span>已选 {state.selectedForTrade.length} 张交易</span></div><div className="hand-grid">{state.hand.map((card) => <HandCard key={card.id} card={card} state={state} dispatch={guardedDispatch} />)}{!state.hand.length && <p className="empty-copy">本回合已没有手牌。</p>}</div></section>
      {evaluationModal && <EvaluationModal modal={evaluationModal} onClose={() => setEvaluationModal(null)} returnFocusRef={submitButtonRef} />}
    </main>
  );
}
