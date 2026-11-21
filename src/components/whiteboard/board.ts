import type { GraphCurve, GraphWindow } from "@/lib/graph";
import { answerCardSize, graphCardSize, type Size } from "./layout";
import type { Stroke, StrokeDraft } from "./strokes";

interface Placed {
  id: number;
  x: number;
  y: number;
}

/** The AI's reading, working and answer for a problem. */
export interface AnswerCardData extends Placed {
  kind: "answer";
  /** The problem as the AI read it, in LaTeX. */
  read: string;
  /** The working, one LaTeX formula per line. */
  steps: string[];
  /** The final result, in LaTeX. */
  answer: string;
}

/** A graph the AI drew from the equations on the board. */
export interface GraphCardData extends Placed {
  kind: "graph";
  curves: GraphCurve[];
  window: GraphWindow;
}

/** Something the AI wrote on the board next to your writing. */
export type BoardCard = AnswerCardData | GraphCardData;

/** A card before it has an id and a place on the board. */
export type CardContent = Omit<AnswerCardData, keyof Placed> | Omit<GraphCardData, keyof Placed>;

/** Roughly how big a card is on the board. */
export function cardSize(card: CardContent | BoardCard): Size {
  return card.kind === "answer"
    ? answerCardSize(card.steps.length)
    : graphCardSize(card.curves.length);
}

interface Snapshot {
  strokes: Stroke[];
  cards: BoardCard[];
}

export interface BoardState extends Snapshot {
  /** Earlier versions of the board, oldest first. Undo steps back through them. */
  past: Snapshot[];
  nextId: number;
}

export type BoardAction =
  | { type: "add"; stroke: StrokeDraft }
  | { type: "remove"; ids: number[] }
  | { type: "setText"; id: number; text: string }
  | { type: "addCard"; content: CardContent; x: number; y: number }
  | { type: "removeCard"; id: number }
  | { type: "clear" }
  | { type: "undo" };

export const INITIAL_BOARD: BoardState = {
  strokes: [],
  cards: [],
  past: [],
  nextId: 1,
};

// Strokes and cards are never changed once added, so each history entry just
// keeps references to the earlier lists.
const snapshotOf = (state: BoardState): Snapshot => ({
  strokes: state.strokes,
  cards: state.cards,
});

export function boardReducer(state: BoardState, action: BoardAction): BoardState {
  switch (action.type) {
    case "add":
      return {
        ...state,
        strokes: [...state.strokes, { ...action.stroke, id: state.nextId }],
        past: [...state.past, snapshotOf(state)],
        nextId: state.nextId + 1,
      };

    case "remove": {
      const gone = new Set(action.ids);
      const strokes = state.strokes.filter((s) => !gone.has(s.id));
      if (strokes.length === state.strokes.length) return state;
      return { ...state, strokes, past: [...state.past, snapshotOf(state)] };
    }

    case "setText": {
      const target = state.strokes.find((s) => s.id === action.id);
      if (!target) return state;
      const history = [...state.past, snapshotOf(state)];
      // Emptying a text box deletes it.
      if (action.text.trim() === "") {
        return { ...state, strokes: state.strokes.filter((s) => s.id !== action.id), past: history };
      }
      if (target.text === action.text) return state;
      const strokes = state.strokes.map((s) =>
        s.id === action.id ? { ...s, text: action.text } : s,
      );
      return { ...state, strokes, past: history };
    }

    case "addCard":
      return {
        ...state,
        cards: [...state.cards, { id: state.nextId, x: action.x, y: action.y, ...action.content }],
        past: [...state.past, snapshotOf(state)],
        nextId: state.nextId + 1,
      };

    case "removeCard": {
      const cards = state.cards.filter((c) => c.id !== action.id);
      if (cards.length === state.cards.length) return state;
      return { ...state, cards, past: [...state.past, snapshotOf(state)] };
    }

    case "clear":
      if (state.strokes.length === 0 && state.cards.length === 0) return state;
      return {
        ...state,
        strokes: [],
        cards: [],
        past: [...state.past, snapshotOf(state)],
      };

    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return { ...state, ...previous, past: state.past.slice(0, -1) };
    }
  }
}
