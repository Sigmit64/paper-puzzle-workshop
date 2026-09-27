import { useEffect, useMemo, useReducer, useState } from "react";
import { cardEntries, clueEntryForMechanic, getCard } from "./game/catalog";
import { createInitialGame, gameReducer } from "./game/engine";
import { parseCellId } from "./game/geometry";
import { anchorKindForClue, clueAnchorOf, validateInternalAnchor } from "./game/puzzle-model";
import { evaluateBoard } from "./game/solver";
import type { BoardMechanic, BoardState, CardDefinition, CardInstance, CellId, ClueAnchor, DraftPoint, GameState, ShopOffer } from "./game/types";

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

function LocalRuleSketch({ definition }: { definition: CardDefinition }) {
  const mechanic = definition.establishesMechanic ?? definition.supportedMechanics[0] ?? "shade";
  const kind = definition.clue?.kind;
  return (
    <svg className="local-rule-sketch" viewBox="0 0 104 72" aria-label="局部示例">
      {[0, 1, 2].flatMap((row) => [0, 1, 2].map((column) => <rect key={`${row}-${column}`} x={8 + column * 20} y={6 + row * 20} width="20" height="20" />))}
      {mechanic === "shade" && <><rect className="sketch-shade" x="29" y="27" width="18" height="18" /><rect className="sketch-shade" x="49" y="7" width="18" height="18" /></>}
      {mechanic === "loop" && <path className="sketch-loop" d="M18 16 H58 V56 H18 V16" />}
      {mechanic === "number" && <><text x="18" y="21">1</text><text x="38" y="41">2</text><text x="58" y="61">3</text></>}
      {mechanic === "region" && <path className="sketch-region" d="M28 6 V66 M48 26 H68 M48 46 H68" />}
      {kind?.includes("cell") || kind === "white-dot" || kind === "black-dot" ? <circle className={kind?.includes("black") ? "sketch-black-dot" : "sketch-clue"} cx="38" cy="36" r="8" /> : null}
      {kind?.includes("edge") || kind === "given-edge" ? <circle className={kind?.includes("black") ? "sketch-black-dot" : "sketch-clue"} cx="48" cy="36" r="6" /> : null}
      {kind?.includes("vertex") ? <circle className={kind.includes("black") ? "sketch-black-dot" : "sketch-clue"} cx="48" cy="46" r="6" /> : null}
      {kind === "exterior-number" && <><circle className="sketch-clue" cx="88" cy="36" r="9" /><text x="88" y="41">2</text></>}
    </svg>
  );
}

function RuleTooltip({ card, mechanic, previewMechanic }: { card: Pick<CardInstance, "definitionId" | "entryDefinitionIds">; mechanic: BoardMechanic | null; previewMechanic?: BoardMechanic }) {
  const entries = entriesFor(card);
  const fallback = entries[0];
  const selectedMechanic = mechanic ?? previewMechanic;
  const active = selectedMechanic ? clueEntryForMechanic(card, selectedMechanic) : undefined;
  const definition = active ?? fallback;
  if (!definition) return null;
  return (
    <span className={`rule-tooltip ${definition.kind === "tool" || (definition.kind === "clue" && selectedMechanic && !active) ? "text-only-tooltip" : ""}`} role="tooltip">
      {definition.kind !== "tool" && (definition.kind === "global" || !selectedMechanic || active) && <LocalRuleSketch definition={definition} />}
      <strong>{definition.name}</strong>
      {definition.kind === "tool" ? <span><b>工具</b>{definition.summary}</span> : definition.kind === "global" ? <span><b>全局规则</b>{definition.summary}</span> : selectedMechanic ? (
        <span><b>{MECHANIC_NAMES[selectedMechanic]}</b>{active?.clue?.interpretations[selectedMechanic] ?? "无该玩法解释"}</span>
      ) : entries.map((entry) => {
        const entryMechanic = entry.supportedMechanics[0];
        return <span key={entry.id}><b>{entryMechanic ? MECHANIC_NAMES[entryMechanic] : KIND_NAMES[entry.kind]}</b>{entry.clue && entryMechanic ? entry.clue.interpretations[entryMechanic] : entry.summary}</span>;
      })}
    </span>
  );
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
        <div className="played-card-list">
          {board.globalCards.map((card) => <button key={card.instanceId} className="played-card global-chip" onClick={() => state.pending?.kind === "use-tool" && state.pending.effect === "remove-global-card" && dispatch({ type: "apply-tool", targetId: card.instanceId })}><span>{getCard(card.definitionId).name}</span><small>{getCard(card.definitionId).summary}</small><RuleTooltip card={card} mechanic={board.mechanic} previewMechanic={previewMechanic} /></button>)}
          {board.clueCards.map((card) => <button key={card.instanceId} className={`played-card clue-chip ${card.placedClueId ? "" : "inactive-chip"}`} onClick={() => state.pending?.kind === "use-tool" && state.pending.effect === "remove-clue-card" && dispatch({ type: "apply-tool", targetId: card.instanceId })}><span>{cardTitle(card)} · {entriesFor(card).length} 词条</span><small>{board.mechanic ? clueEntryForMechanic(card, board.mechanic)?.summary ?? "无该玩法解释" : previewMechanic ? clueEntryForMechanic(card, previewMechanic)?.summary ?? "无该玩法解释" : "等待选择预览玩法"}</small><RuleTooltip card={card} mechanic={board.mechanic} previewMechanic={previewMechanic} /></button>)}
          {!board.globalCards.length && !board.clueCards.length && <p className="empty-copy">这里还是一张空白稿纸。可以先打出线索牌，再决定主要玩法。</p>}
        </div>
        {state.phase !== "setup" && state.lastEvaluation && state.lastEvaluation.boardName === board.name && <section className={`evaluation evaluation-${state.lastEvaluation.status}`}><strong>{state.lastEvaluation.boardName}：{state.lastEvaluation.detail}</strong><span>基础分 {state.lastEvaluation.baseScore} · 获得 {state.lastEvaluation.awardedScore}</span></section>}
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
  const selectedBoard = state.boards.find((board) => board.id === state.selectedBoardId)!;
  const visibleBoard = state.boards.find((board) => board.id === activeTab) ?? selectedBoard;
  const pendingClueDefinition = state.pending?.kind === "place-clue" ? clueEntryForMechanic(state.pending.card, selectedBoard.mechanic) : null;
  const pendingEntries = state.pending?.kind === "place-clue"
    ? (selectedBoard.mechanic && pendingClueDefinition ? [pendingClueDefinition] : entriesFor(state.pending.card).filter((entry) => entry.clue))
    : [];
  const pendingMin = pendingEntries.length ? Math.max(...pendingEntries.map((entry) => entry.clue!.min)) : 0;
  const pendingMax = pendingEntries.length ? Math.min(...pendingEntries.map((entry) => entry.clue!.max)) : 0;
  const pickerMax = Math.min(40, pendingMax);
  const shopGroups = useMemo(() => (["global", "clue", "tool"] as const), []);

  useEffect(() => { if (state.pending) setActiveTab(state.pending.boardId); }, [state.pending]);

  function switchBoard(boardId: string) {
    if (state.pending) return;
    dispatch({ type: "select-board", boardId });
    setActiveTab(boardId);
  }

  function submitBoard() {
    if (state.pending) return;
    dispatch({ type: "resolve-board", boardId: selectedBoard.id, result: evaluateBoard(selectedBoard) });
  }

  return (
    <main className="game-shell">
      <header className="topbar"><div><p className="eyebrow">纸笔谜题构筑游戏</p><h1>谜题工坊</h1></div><div className="game-stats"><a className="rulebook-link" href="?view=rules">规则图鉴</a><span>回合 <strong>{state.round}/{state.maxRounds}</strong></span><span>总分 <strong>{state.score}</strong></span><span>牌堆 <strong>{state.deck.length}</strong></span></div></header>
      <section className="message-strip" aria-live="polite"><span className="scribble">✎</span><span>{state.message}</span>{state.pending && !(state.pending.kind === "place-clue" && state.pending.fromSetup) && <button onClick={() => dispatch({ type: "cancel-pending" })}>取消</button>}</section>
      <nav className="workspace-tabs" aria-label="工作区">{state.boards.map((board) => <button key={board.id} className={activeTab === board.id ? "active-tab" : ""} onClick={() => switchBoard(board.id)} disabled={!!state.pending && state.pending.boardId !== board.id}><span>{board.name}</span><small>{board.rows}×{board.columns} · {board.globalCards.length + board.clueCards.length}/{board.ruleCapacity}</small></button>)}<button className={activeTab === "shop" ? "active-tab" : ""} onClick={() => !state.pending && setActiveTab("shop")} disabled={!!state.pending}><span>商店</span><small>四种主规则</small></button></nav>

      <section className="main-stage">
        {state.phase === "setup" && !state.pending ? <section className="setup-panel"><p className="eyebrow">开局准备</p><h2>在哪张纸上开始第一道题？</h2><p>选择后建立 Koburin，并立即放置第一枚格内数字。</p><div className="setup-actions">{state.boards.map((board) => <button key={board.id} onClick={() => { setActiveTab(board.id); dispatch({ type: "choose-start-board", boardId: board.id }); }}>{board.name}<small>{board.rows}×{board.columns} · 容量 {board.ruleCapacity}</small></button>)}</div></section>
        : activeTab === "shop" ? <section className="shop-page"><div className="section-title"><div><p className="eyebrow">弃牌换购</p><h2>商店</h2></div><span className="trade-count">已选 {state.selectedForTrade.length} 张手牌</span></div><div className="shop-columns">{shopGroups.map((kind) => <section className={`shop-group shop-${kind}`} key={kind}><h3>{KIND_NAMES[kind]}</h3><p>{kind === "global" ? "四种玩法各一张，统一弃 2 张。" : "价格仍按 1 / 2 / 3 张排列。"}</p>{state.shop.filter((offer) => getCard(offer.definitionId).kind === kind).map((offer) => <ShopCard key={offer.id} offer={offer} state={state} dispatch={dispatch} />)}</section>)}</div></section>
        : <BoardView board={visibleBoard} state={state} dispatch={dispatch} previewMechanic={previewMechanics[visibleBoard.id]} onPreviewMechanic={(mechanic) => setPreviewMechanics((current) => ({ ...current, [visibleBoard.id]: mechanic }))} />}

        {state.pending?.kind === "place-clue" && <section className="pending-panel"><div><p className="eyebrow">放置线索</p><h2>{cardTitle(state.pending.card)}</h2><p>{selectedBoard.mechanic ? pendingClueDefinition?.summary : "盘面尚无主规则；线索会先放置，玩法解释稍后确定。"}</p></div>{pendingMax > 0 && <div className="number-picker" aria-label="线索数字">{Array.from({ length: pickerMax - pendingMin + 1 }, (_, index) => index + pendingMin).map((value) => <button key={value} className={state.pending?.kind === "place-clue" && state.pending.value === value ? "active-number" : ""} onClick={() => dispatch({ type: "set-pending-clue-value", value })}>{value}</button>)}</div>}</section>}
        {activeTab !== "shop" && state.phase !== "setup" && <div className="board-actions"><span>当前：{selectedBoard.name}</span><button onClick={submitBoard} disabled={!!state.pending || !selectedBoard.mechanic}>提交盘面</button><button className="primary-button" onClick={() => dispatch({ type: "end-round" })} disabled={state.phase !== "playing" || !!state.pending}>{state.round === state.maxRounds ? "结束游戏" : "结束回合（弃掉手牌）→"}</button></div>}
      </section>

      <section className="hand-section"><div className="hand-heading"><span><b>手牌 {state.hand.length}/7</b> · 回合结束全部弃置</span><span>已选 {state.selectedForTrade.length} 张交易</span></div><div className="hand-grid">{state.hand.map((card) => <HandCard key={card.id} card={card} state={state} dispatch={dispatch} />)}{!state.hand.length && <p className="empty-copy">本回合已没有手牌。</p>}</div></section>
    </main>
  );
}
