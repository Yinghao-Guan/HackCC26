import type {
  GraphCurve,
  GraphPoint,
  GraphSurface,
  GraphWindow,
  GraphWindow3D,
} from "@/lib/graph";
import {
  answerCardSize,
  checkCardSize,
  graph3dCardSize,
  graphCardSize,
  type Rect,
  type Size,
} from "./layout";
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

/** A 3D graph the AI (or the board) drew from the equations on the board. */
export interface Graph3DCardData extends Placed {
  kind: "graph3d";
  surfaces: GraphSurface[];
  points: GraphPoint[];
  window: GraphWindow3D;
}

/** The AI's check of worked steps: whether they are right, and if not, where it went wrong. */
export interface CheckCardData extends Placed {
  kind: "check";
  verdict: "mistake" | "correct";
  /** The numbered line (1 is the top line) with the first mistake, if there is one. */
  step: number | null;
  /** Where that line is on the board, so it can be circled. */
  mark: Rect | null;
  explanation: string;
  /** What the wrong line should have said, in LaTeX. */
  correctedLine: string;
  /** The work carried on correctly to the answer, one LaTeX formula per line. */
  steps: string[];
  /** The correct final answer, in LaTeX. */
  answer: string;
}

/** Something the AI wrote on the board next to your writing. */
export type BoardCard = AnswerCardData | GraphCardData | Graph3DCardData | CheckCardData;

/** A card before it has an id and a place on the board. */
export type CardContent =
  | Omit<AnswerCardData, keyof Placed>
  | Omit<GraphCardData, keyof Placed>
  | Omit<Graph3DCardData, keyof Placed>
  | Omit<CheckCardData, keyof Placed>;

/** Roughly how big a card is on the board. */
export function cardSize(card: CardContent | BoardCard): Size {
  switch (card.kind) {
    case "answer":
      return answerCardSize(card.steps.length);
    case "graph":
      return graphCardSize(card.curves.length);
    case "graph3d":
      return graph3dCardSize(card.surfaces.length, card.points.length);
    case "check":
      return checkCardSize(card.steps.length);
  }
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
