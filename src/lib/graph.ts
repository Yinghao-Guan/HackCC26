/** What the graph API accepts and returns. Shared by the server route and the browser. */

import { tryCompileFormula } from "./expression";

export interface GraphRequest {
  /** The board's writing as a PNG data URL (`data:image/png;base64,...`). */
  image: string;
}

export interface GraphCurve {
  /** The equation as written, in LaTeX. Shown in the legend. */
  label: string;
  /**
   * explicit: `expression` gives y in terms of x.
   * implicit: `expression` is left side minus right side, and the curve is where it is zero.
   */
  kind: "explicit" | "implicit";
  expression: string;
}

/** The part of the coordinate plane to show. */
export interface GraphWindow {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export type GraphResult =
  | { status: "graphed"; curves: GraphCurve[]; window: GraphWindow }
  | {
      /** Nothing to graph: no equation on the board, or handwriting too unclear. */
      status: "no_graph" | "unreadable";
      message: string;
    };

export const DEFAULT_WINDOW: GraphWindow = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };

const MAX_CURVES = 6;

const DEFAULT_MESSAGES = {
  no_graph: "I couldn't find an equation to graph on the board.",
  unreadable: "I couldn't read the handwriting. Try writing it larger or more clearly.",
} as const;

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Use the window if it makes sense, otherwise the standard -10 to 10 square. */
export function parseWindow(value: unknown): GraphWindow {
  if (typeof value !== "object" || value === null) return DEFAULT_WINDOW;
  const { xMin, xMax, yMin, yMax } = value as Record<string, unknown>;
  if (!isNumber(xMin) || !isNumber(xMax) || !isNumber(yMin) || !isNumber(yMax)) {
    return DEFAULT_WINDOW;
  }

  const sensibleSpan = (span: number) => span > 1e-3 && span < 1e6;
  if (!sensibleSpan(xMax - xMin) || !sensibleSpan(yMax - yMin)) return DEFAULT_WINDOW;
  return { xMin, xMax, yMin, yMax };
}

/**
 * Check an unknown value (a model reply or an API response) and return it as a
 * GraphResult. Curves whose formula can't be read are dropped.
 */
export function parseGraphResult(value: unknown): GraphResult | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  if (v.status === "graphed") {
    if (!Array.isArray(v.curves)) return null;

    const curves: GraphCurve[] = [];
    for (const item of v.curves) {
      if (typeof item !== "object" || item === null) continue;
      const { label, kind, expression } = item as Record<string, unknown>;
      if (!isString(label) || !isString(expression)) continue;
      if (kind !== "explicit" && kind !== "implicit") continue;
      if (!tryCompileFormula(expression)) continue;
      curves.push({ label, kind, expression });
      if (curves.length === MAX_CURVES) break;
    }

    if (curves.length === 0) {
      return { status: "unreadable", message: "I couldn't turn that into a graph. Try writing the equation more clearly." };
    }
    return { status: "graphed", curves, window: parseWindow(v.window) };
  }

  if (v.status === "no_graph" || v.status === "unreadable") {
    const message =
      isString(v.message) && v.message.trim() !== "" ? v.message : DEFAULT_MESSAGES[v.status];
    return { status: v.status, message };
  }

  return null;
}
