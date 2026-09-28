import { CARD_DEFINITIONS, STARTER_CLUE_ID, STARTER_GLOBAL_ID, cardEntries, cardsOfKind, clueEntryForMechanic, getCard } from "./catalog";
import { createBoard, refreshBoard } from "./geometry";
import {
  anchorKey,
  anchorKindForClue,
  cellsTouchedByAnchor,
  clueAnchorOf,
  edgeId,
  validateInternalAnchor,
} from "./puzzle-model";
import type {
  BoardState,
  CardInstance,
  GameAction,
  GameState,
  ShopOffer,
} from "./types";

const INITIAL_HAND_SIZE = 7;
const PRIMARY_GLOBAL_IDS = ["rule-shade-connected", "rule-single-loop", "rule-number-latin-full", "rule-region-rectangles"];

function seededShuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let value = seed >>> 0;
  const random = () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };

  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function composeClueEntries(primaryId: string, seed: number): string[] {
  const primary = getCard(primaryId);
  if (!primary.clue) return [primaryId];
  if (Object.keys(primary.clue.interpretations).length >= 2) return [primaryId];
  const candidates = seededShuffle(
    CARD_DEFINITIONS.filter((card) => card.kind === "clue" && card.clue?.kind === primary.clue!.kind && Object.keys(card.clue.interpretations).length === 1),
    seed,
  );
  const chosen = [primary];
  const usedMechanics = new Set(primary.supportedMechanics);
  const targetCount = 2 + (seed % 3);
  for (const candidate of candidates) {
    const mechanic = candidate.supportedMechanics[0];
    if (!mechanic || usedMechanics.has(mechanic)) continue;
    chosen.push(candidate);
    usedMechanics.add(mechanic);
    if (chosen.length >= targetCount) break;
  }
  return chosen.map((entry) => entry.id);
}

function canComposeClue(definitionId: string) {
  const primary = getCard(definitionId);
  if (!primary.clue) return false;
  const mechanics = new Set(
    CARD_DEFINITIONS
      .filter((card) => card.kind === "clue" && card.clue?.kind === primary.clue!.kind)
      .flatMap((card) => card.supportedMechanics),
  );
  return mechanics.size >= 2;
}

function createDeck(): CardInstance[] {
  const available = CARD_DEFINITIONS.filter((card) =>
    !card.id.startsWith("rule-koburin") && (card.kind !== "clue" || canComposeClue(card.id)),
  );
  return seededShuffle(
    Array.from({ length: 4 }, (_, copy) =>
      available.map((definition, index) => ({
        id: `deck-${copy}-${index}`,
        definitionId: definition.id,
        entryDefinitionIds: definition.kind === "clue"
          ? composeClueEntries(definition.id, copy * 1000 + index + 17)
          : undefined,
      })),
    ).flat(),
    20260927,
  );
}

function createShop(round: number): ShopOffer[] {
  const globals = PRIMARY_GLOBAL_IDS.map((definitionId, index) => ({
    id: `shop-${round}-global-${index}`,
    definitionId,
    cost: 2,
  }));
  const clues = cardsOfKind("clue").filter((definition) => canComposeClue(definition.id));
  const clueOffers = Array.from({ length: 3 }, (_, index) => {
    const definition = clues[((round - 1) * 3 + index) % clues.length];
    return {
      id: `shop-${round}-clue-${index}`,
      definitionId: definition.id,
      entryDefinitionIds: composeClueEntries(definition.id, round * 100 + index),
      cost: index + 1,
    };
  });
  const tools = cardsOfKind("tool");
  const toolOffers = Array.from({ length: 3 }, (_, index) => ({
    id: `shop-${round}-tool-${index}`,
    definitionId: tools[(round - 1 + index) % tools.length].id,
    cost: index + 1,
  }));
  return [...globals, ...clueOffers, ...toolOffers];
}

export function createInitialGame(): GameState {
  const deck = createDeck();
  return {
    phase: "setup",
    round: 1,
    maxRounds: 8,
    drawPerRound: 7,
    score: 0,
    boards: [
      createBoard("small", "随身便签", 5, 4),
      createBoard("medium", "练习方格", 6, 6),
      createBoard("large", "整页稿纸", 7, 8),
    ],
    selectedBoardId: "small",
    deck: deck.slice(INITIAL_HAND_SIZE),
    hand: deck.slice(0, INITIAL_HAND_SIZE),
    discard: [],
    shop: createShop(1),
    selectedForTrade: [],
    pending: null,
    message: "先选择一个盘面建立 Koburin 初始规则。",
    lastEvaluation: null,
    serial: 1,
  };
}

function updateBoard(state: GameState, boardId: string, updater: (board: BoardState) => BoardState) {
  return state.boards.map((board) => (board.id === boardId ? updater(board) : board));
}

function selectedBoard(state: GameState) {
  return state.boards.find((board) => board.id === state.selectedBoardId)!;
}

function removeHandCard(hand: CardInstance[], instanceId: string) {
  return hand.filter((card) => card.id !== instanceId);
}

function withMessage(state: GameState, message: string): GameState {
  return { ...state, message };
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "choose-start-board": {
      if (state.phase !== "setup" || state.pending) return state;
      const board = state.boards.find((item) => item.id === action.boardId);
      if (!board) return state;

      const globalInstance: CardInstance = {
        id: `starter-global-${state.serial}`,
        definitionId: STARTER_GLOBAL_ID,
      };
      const clueInstance: CardInstance = {
        id: `starter-clue-${state.serial + 1}`,
        definitionId: STARTER_CLUE_ID,
        entryDefinitionIds: composeClueEntries(STARTER_CLUE_ID, 1),
      };

      return {
        ...state,
        selectedBoardId: board.id,
        serial: state.serial + 2,
        boards: updateBoard(state, board.id, (current) => ({
          ...current,
          mechanic: "loop",
          globalCards: [
            ...current.globalCards,
            { instanceId: globalInstance.id, definitionId: globalInstance.definitionId },
          ],
          revision: current.revision + 1,
        })),
        pending: {
          kind: "place-clue",
          boardId: board.id,
          card: clueInstance,
          fromSetup: true,
          value: 0,
        },
        message: "选择数字 0–9，然后点击盘面中的一个格子放置初始线索。",
      };
    }

    case "select-board":
      if (state.pending) return withMessage(state, "请先完成或取消当前卡牌效果。");
      return { ...state, selectedBoardId: action.boardId };

    case "set-pending-clue-value":
      if (state.pending?.kind !== "place-clue") return state;
      if (!Number.isInteger(action.value) || action.value < 0 || action.value > 9) return withMessage(state, "线索数字必须是 0–9 的整数。");
      return { ...state, pending: { ...state.pending, value: action.value } };

    case "place-pending-clue": {
      if (state.pending?.kind !== "place-clue") return state;
      const pending = state.pending;
      const board = state.boards.find((item) => item.id === pending.boardId);
      const definition = clueEntryForMechanic(pending.card, board?.mechanic ?? null);
      if (!board || !definition?.clue || anchorKindForClue(definition.clue.kind) !== action.anchor.kind) return state;
      const clueDefinition = definition.clue;
      if (!Number.isInteger(pending.value) || pending.value < 0 || pending.value > 9) return withMessage(state, "线索数字必须是 0–9 的整数。");
      const geometry = { rows: board.rows, columns: board.columns, activeCells: board.activeCells };
      if (!validateInternalAnchor(geometry, action.anchor)) return withMessage(state, "这个位置不能完整容纳该线索。");
      if (board.clues.some((clue) => {
        const anchor = clueAnchorOf(clue);
        return anchor && anchorKey(anchor) === anchorKey(action.anchor) && clue.kind === clueDefinition.kind;
      })) {
        return withMessage(state, "这个位置已经有同类型线索。");
      }

      const clueId = `clue-${state.serial}`;
      const replaced = pending.replaceInstanceId
        ? board.clueCards.find((card) => card.instanceId === pending.replaceInstanceId)
        : undefined;
      const nextDiscard = replaced
        ? [...state.discard, { id: replaced.instanceId, definitionId: replaced.definitionId, entryDefinitionIds: replaced.entryDefinitionIds }]
        : state.discard;

      return {
        ...state,
        phase: pending.fromSetup ? "playing" : state.phase,
        serial: state.serial + 1,
        hand: pending.fromSetup ? state.hand : removeHandCard(state.hand, pending.card.id),
        discard: nextDiscard,
        pending: null,
        boards: updateBoard(state, board.id, (current) => ({
          ...current,
          clueCards: [
            ...current.clueCards.filter((card) => card.instanceId !== pending.replaceInstanceId),
            {
              instanceId: pending.card.id,
              definitionId: pending.card.definitionId,
              entryDefinitionIds: pending.card.entryDefinitionIds,
              placedClueId: clueId,
            },
          ],
          clues: [
            ...current.clues,
            {
              id: clueId,
              kind: clueDefinition.kind,
              cellId: action.anchor.kind === "cell" ? action.anchor.cell : undefined,
              edgeId: action.anchor.kind === "edge" ? edgeId(action.anchor) : undefined,
              anchor: action.anchor,
              value: pending.value,
              sourceCardInstanceId: pending.card.id,
            },
          ],
          revision: current.revision + 1,
        })),
        message: pending.fromSetup ? "初始盘面建立完成。现在可以出牌、交易或结束回合。" : "线索牌已生效。",
      };
    }

    case "cancel-pending":
      if (!state.pending || (state.pending.kind === "place-clue" && state.pending.fromSetup)) return state;
      return { ...state, pending: null, message: "已取消这次出牌。" };

    case "play-card": {
      if (state.phase !== "playing" || state.pending) return state;
      const card = state.hand.find((item) => item.id === action.cardInstanceId);
      const board = selectedBoard(state);
      if (!card || !board) return state;
      const definition = getCard(card.definitionId);
      const usedSlots = board.globalCards.length + board.clueCards.length;

      if (definition.kind !== "tool" && usedSlots >= board.ruleCapacity && !action.replaceInstanceId) {
        return withMessage(state, `${board.name}只能容纳 ${board.ruleCapacity} 张规则牌。`);
      }

      if (definition.kind === "global") {
        const mechanic = board.mechanic ?? definition.establishesMechanic ?? null;
        if (!mechanic || !definition.supportedMechanics.includes(mechanic)) {
          return withMessage(state, "这张全局规则牌与当前盘面的主要玩法不兼容。");
        }
        if (board.clueCards.some((played) => !clueEntryForMechanic(played, mechanic))) {
          return withMessage(state, "盘面上已有线索牌不包含这项玩法的解释，不能用它建立主规则。");
        }
        return {
          ...state,
          hand: removeHandCard(state.hand, card.id),
          boards: updateBoard(state, board.id, (current) => ({
            ...current,
            mechanic,
            globalCards: [
              ...current.globalCards,
              { instanceId: card.id, definitionId: card.definitionId },
            ],
            revision: current.revision + 1,
          })),
          message: `${definition.name}已加入${board.name}。`,
        };
      }

      if (definition.kind === "clue") {
        const activeEntry = clueEntryForMechanic(card, board.mechanic);
        if (!activeEntry?.clue) {
          return withMessage(state, "这张线索牌不包含当前主要玩法的解释。");
        }
        return {
          ...state,
          pending: {
            kind: "place-clue",
            boardId: board.id,
            card,
            fromSetup: false,
            replaceInstanceId: action.replaceInstanceId,
            value: board.mechanic
              ? activeEntry.clue.min
              : Math.max(...cardEntries(card).filter((entry) => entry.clue).map((entry) => entry.clue!.min)),
          },
          message: "设置线索值并点击盘面格子；完成放置后才会消耗这张牌。",
        };
      }

      return {
        ...state,
        pending: {
          kind: "use-tool",
          boardId: board.id,
          card,
          effect: definition.toolEffect!,
        },
        message: `正在使用${definition.name}：请在盘面上选择目标。`,
      };
    }

    case "apply-tool": {
      if (state.pending?.kind !== "use-tool") return state;
      const pending = state.pending;
      const board = state.boards.find((item) => item.id === pending.boardId);
      if (!board) return state;

      let validTarget = false;
      const nextBoards = updateBoard(state, board.id, (current) => {
        switch (pending.effect) {
          case "remove-cell": {
            if (!current.activeCells.includes(action.targetId as never) || current.activeCells.length <= 4) return current;
            const protectedByInternalClue = current.clues.some((clue) => {
              const anchor = clueAnchorOf(clue);
              return anchor && anchor.kind !== "cell" && anchor.kind !== "exterior" &&
                cellsTouchedByAnchor(anchor).includes(action.targetId as never);
            });
            if (protectedByInternalClue) return current;
            validTarget = true;
            const removedClueIds = new Set(
              current.clues.filter((clue) => {
                const anchor = clueAnchorOf(clue);
                return anchor?.kind === "cell" && anchor.cell === action.targetId;
              }).map((clue) => clue.id),
            );
            return {
              ...current,
              activeCells: current.activeCells.filter((cell) => cell !== action.targetId),
              clues: current.clues.filter((clue) => {
                const anchor = clueAnchorOf(clue);
                return anchor?.kind !== "cell" || anchor.cell !== action.targetId;
              }),
              clueCards: current.clueCards.map((card) =>
                card.placedClueId && removedClueIds.has(card.placedClueId)
                  ? { ...card, placedClueId: undefined }
                  : card,
              ),
              revision: current.revision + 1,
            };
          }
          case "remove-clue": {
            if (!current.clues.some((clue) => clue.id === action.targetId)) return current;
            validTarget = true;
            return {
              ...current,
              clues: current.clues.filter((clue) => clue.id !== action.targetId),
              clueCards: current.clueCards.map((card) =>
                card.placedClueId === action.targetId ? { ...card, placedClueId: undefined } : card,
              ),
              revision: current.revision + 1,
            };
          }
          case "remove-clue-card":
            if (!current.clueCards.some((card) => card.instanceId === action.targetId)) return current;
            validTarget = true;
            return {
              ...current,
              clueCards: current.clueCards.filter((card) => card.instanceId !== action.targetId),
              revision: current.revision + 1,
            };
          case "remove-global-card":
            if (!current.globalCards.some((card) => card.instanceId === action.targetId)) return current;
            validTarget = true;
            return {
              ...current,
              globalCards: current.globalCards.filter((card) => card.instanceId !== action.targetId),
              revision: current.revision + 1,
            };
        }
      });

      if (!validTarget) return withMessage(state, "这里不是该工具的合法目标。");
      return {
        ...state,
        boards: nextBoards,
        hand: removeHandCard(state.hand, pending.card.id),
        discard: [...state.discard, pending.card],
        pending: null,
        message: "工具效果已经执行。盘面几何和线索覆盖状态已重新计算。",
      };
    }

    case "toggle-trade-card": {
      if (state.pending) return state;
      const selected = state.selectedForTrade.includes(action.cardInstanceId);
      return {
        ...state,
        selectedForTrade: selected
          ? state.selectedForTrade.filter((id) => id !== action.cardInstanceId)
          : [...state.selectedForTrade, action.cardInstanceId],
      };
    }

    case "buy-offer": {
      if (state.phase !== "playing" || state.pending) return state;
      const offer = state.shop.find((item) => item.id === action.offerId);
      if (!offer || state.selectedForTrade.length < offer.cost) {
        return withMessage(state, "请先从手牌中选择足够数量的牌作为交易代价。");
      }
      const paymentIds = state.selectedForTrade.slice(0, offer.cost);
      const payment = state.hand.filter((card) => paymentIds.includes(card.id));
      const purchased: CardInstance = { id: `bought-${state.serial}`, definitionId: offer.definitionId, entryDefinitionIds: offer.entryDefinitionIds };
      return {
        ...state,
        serial: state.serial + 1,
        hand: [...state.hand.filter((card) => !paymentIds.includes(card.id)), purchased],
        discard: [...state.discard, ...payment],
        shop: state.shop.filter((item) => item.id !== offer.id),
        selectedForTrade: state.selectedForTrade.filter((id) => !paymentIds.includes(id)),
        message: `交易完成：获得${getCard(offer.definitionId).name}。`,
      };
    }

    case "end-round": {
      if (state.phase !== "playing" || state.pending) return state;
      const discardedHand = state.hand;
      if (state.round >= state.maxRounds) {
        return { ...state, phase: "finished", hand: [], discard: [...state.discard, ...discardedHand], selectedForTrade: [], message: "最后一回合结束；未使用手牌已全部弃置，游戏结算完成。" };
      }
      const drawn = state.deck.slice(0, state.drawPerRound);
      const nextRound = state.round + 1;
      return {
        ...state,
        round: nextRound,
        hand: drawn,
        discard: [...state.discard, ...discardedHand],
        deck: state.deck.slice(drawn.length),
        shop: createShop(nextRound),
        selectedForTrade: [],
        message: `进入第 ${nextRound} 回合：上回合手牌已弃置，抽取 ${drawn.length} 张新牌，商店已刷新。`,
      };
    }

    case "add-draft-stroke":
      return {
        ...state,
        boards: updateBoard(state, action.boardId, (board) => ({
          ...board,
          draftStrokes: [...board.draftStrokes, action.stroke],
        })),
      };

    case "erase-draft-at":
      return {
        ...state,
        boards: updateBoard(state, action.boardId, (board) => ({
          ...board,
          draftStrokes: board.draftStrokes.filter((stroke) => !stroke.points.some((point) => Math.hypot(point.x - action.x, point.y - action.y) <= action.radius)),
        })),
      };

    case "clear-draft":
      return {
        ...state,
        boards: updateBoard(state, action.boardId, (board) => ({ ...board, draftStrokes: [] })),
      };

    case "resolve-board": {
      const board = state.boards.find((item) => item.id === action.boardId);
      if (!board) return state;
      const completed = !["unsupported", "timeout"].includes(action.result.status);
      const retiredCards = completed
        ? [...board.globalCards, ...board.clueCards].map((card) => ({
            id: card.instanceId,
            definitionId: card.definitionId,
            entryDefinitionIds: card.entryDefinitionIds,
          }))
        : [];
      return {
        ...state,
        score: state.score + action.result.awardedScore,
        lastEvaluation: action.result,
        discard: [...state.discard, ...retiredCards],
        boards: completed
          ? updateBoard(state, board.id, (current) => refreshBoard(current))
          : state.boards,
        message: completed
          ? `${board.name}已结算，并刷新为相同大小的空白盘面。`
          : action.result.detail,
      };
    }
  }
}
