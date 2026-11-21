/** What the solve API accepts and returns. Shared by the server route and the browser. */

export interface SolveRequest {
  /** The board's ink as a PNG data URL (`data:image/png;base64,...`). */
  image: string;
}

export type SolveResult =
  | {
      status: "solved";
      /** The problem as the AI read it, in LaTeX. */
      read: string;
      /** The working, one LaTeX formula per line. */
      steps: string[];
      /** The final result, in LaTeX. */
      answer: string;
    }
  | {
      /** Nothing to solve: no math on the board, or handwriting too unclear. */
      status: "no_math" | "unreadable";
      message: string;
    };

const DEFAULT_MESSAGES = {
  no_math: "I couldn't find a math problem on the board.",
  unreadable: "I couldn't read the handwriting. Try writing it larger or more clearly.",
} as const;

const isString = (value: unknown): value is string => typeof value === "string";

/** Check an unknown value (a model reply or an API response) and return it as a SolveResult. */
export function parseSolveResult(value: unknown): SolveResult | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  if (v.status === "solved") {
    if (!isString(v.read) || !isString(v.answer) || v.answer.trim() === "") return null;
    if (!Array.isArray(v.steps) || !v.steps.every(isString)) return null;
    return { status: "solved", read: v.read, steps: v.steps, answer: v.answer };
  }

  if (v.status === "no_math" || v.status === "unreadable") {
    const message =
      isString(v.message) && v.message.trim() !== "" ? v.message : DEFAULT_MESSAGES[v.status];
    return { status: v.status, message };
  }

  return null;
}
