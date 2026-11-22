/** What the "find the mistake" API returns. Shared by the server route and the browser. */

export type CheckResult =
  | {
      /** A step in the work is wrong. */
      status: "mistake";
      /** The numbered line (1 is the top line) with the first mistake, or null if it can't be pinned to a line. */
      wrongLine: number | null;
      /** What went wrong, in plain words for a student. */
      explanation: string;
      /** What that line should have said, in LaTeX. */
      correctedLine: string;
      /** The work carried on correctly from there to the answer, one LaTeX formula per line. */
      steps: string[];
      /** The correct final answer, in LaTeX. */
      answer: string;
    }
  | {
      /** Every step is right. */
      status: "correct";
      explanation: string;
      /** The final answer, in LaTeX. */
      answer: string;
    }
  | {
      /** Nothing to check (only a problem, no steps) or handwriting too unclear. */
      status: "no_work" | "unreadable";
      message: string;
    };

const DEFAULT_MESSAGES = {
  no_work: "I only see a problem. Write out your steps, then press Check.",
  unreadable: "I couldn't read the handwriting. Try writing it larger or more clearly.",
} as const;

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * Check an unknown value (a model reply or an API response) and return it as a
 * CheckResult. `lineCount` is how many numbered lines were shown; a line number
 * outside 1..lineCount becomes null instead of circling the wrong thing.
 */
export function parseCheckResult(value: unknown, lineCount = Infinity): CheckResult | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  if (v.status === "mistake") {
    if (!isString(v.explanation) || v.explanation.trim() === "") return null;
    if (!isString(v.correctedLine) || !isString(v.answer)) return null;
    if (!Array.isArray(v.steps) || !v.steps.every(isString)) return null;

    const line = v.wrongLine;
    const wrongLine =
      typeof line === "number" && Number.isInteger(line) && line >= 1 && line <= lineCount
        ? line
        : null;
    return {
      status: "mistake",
      wrongLine,
      explanation: v.explanation,
      correctedLine: v.correctedLine,
      steps: v.steps,
      answer: v.answer,
    };
  }

  if (v.status === "correct") {
    return {
      status: "correct",
      explanation:
        isString(v.explanation) && v.explanation.trim() !== ""
          ? v.explanation
          : "Every step follows from the one before.",
      answer: isString(v.answer) ? v.answer : "",
    };
  }

  if (v.status === "no_work" || v.status === "unreadable") {
    const message =
      isString(v.message) && v.message.trim() !== "" ? v.message : DEFAULT_MESSAGES[v.status];
    return { status: v.status, message };
  }

  return null;
}
