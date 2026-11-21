import type { Stroke, StrokeDraft } from "./strokes";

/** An answer the AI wrote on the board, with the spot it was placed at. */
export interface BoardAnswer {
  id: number;
  x: number;
  y: number;
  /** The problem as the AI read it, in LaTeX. */
  read: string;
  /** The working, one LaTeX formula per line. */
  steps: string[];
  /** The final result, in LaTeX. */
  answer: string;
}

export type AnswerContent = Pick<BoardAnswer, "read" | "steps" | "answer">;

interface Snapshot {
  strokes: Stroke[];
  answers: BoardAnswer[];
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
  | { type: "addAnswer"; content: AnswerContent; x: number; y: number }
  | { type: "removeAnswer"; id: number }
  | { type: "clear" }
  | { type: "undo" };

export const INITIAL_BOARD: BoardState = {
  strokes: [],
  answers: [],
  past: [],
  nextId: 1,
};

// Strokes and answers are never changed once added, so each history entry just
// keeps references to the earlier lists.
const snapshotOf = (state: BoardState): Snapshot => ({
  strokes: state.strokes,
  answers: state.answers,
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

    case "addAnswer":
      return {
        ...state,
        answers: [
          ...state.answers,
          { id: state.nextId, x: action.x, y: action.y, ...action.content },
        ],
        past: [...state.past, snapshotOf(state)],
        nextId: state.nextId + 1,
      };

    case "removeAnswer": {
      const answers = state.answers.filter((a) => a.id !== action.id);
      if (answers.length === state.answers.length) return state;
      return { ...state, answers, past: [...state.past, snapshotOf(state)] };
    }

    case "clear":
      if (state.strokes.length === 0 && state.answers.length === 0) return state;
      return {
        ...state,
        strokes: [],
        answers: [],
        past: [...state.past, snapshotOf(state)],
      };

    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return { ...state, ...previous, past: state.past.slice(0, -1) };
    }
  }
}
