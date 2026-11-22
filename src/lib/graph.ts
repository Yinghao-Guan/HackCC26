/** What the graph API accepts and returns. Shared by the server route and the browser. */

import { tryCompileFormula, usesVariable } from "./expression";

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

/** The part of the flat (2D) coordinate plane to show. */
export interface GraphWindow {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export type SolveFor = "x" | "y" | "z";

/** A surface in 3D, given as one variable in terms of the other two (like z = x^2 + y^2). */
export interface GraphSurface {
  /** The equation as written, in LaTeX. Shown in the legend. */
  label: string;
  /** Which variable `expression` gives. The expression uses only the other two. */
  solveFor: SolveFor;
  expression: string;
}

/** A notable point in 3D, such as where the surfaces of a system meet. */
export interface GraphPoint {
  label: string;
  x: number;
  y: number;
  z: number;
}

/** The box of 3D space to show. */
export interface GraphWindow3D {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
}

export type GraphResult =
  | { status: "graphed"; dimension: "2d"; curves: GraphCurve[]; window: GraphWindow }
  | {
      status: "graphed";
      dimension: "3d";
      surfaces: GraphSurface[];
      points: GraphPoint[];
      window3d: GraphWindow3D;
    }
  | {
      /** Nothing to graph: no equation on the board, or handwriting too unclear. */
      status: "no_graph" | "unreadable";
      message: string;
    };

export const DEFAULT_WINDOW: GraphWindow = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
export const DEFAULT_WINDOW_3D: GraphWindow3D = {
  xMin: -5,
  xMax: 5,
  yMin: -5,
  yMax: 5,
  zMin: -5,
  zMax: 5,
};

const MAX_CURVES = 6;
const MAX_SURFACES = 4;
const MAX_POINTS = 4;

const DEFAULT_MESSAGES = {
  no_graph: "I couldn't find an equation to graph on the board.",
  unreadable: "I couldn't read the handwriting. Try writing it larger or more clearly.",
} as const;

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const sensibleSpan = (span: number) => span > 1e-3 && span < 1e6;

/** Use the window if it makes sense, otherwise the standard -10 to 10 square. */
export function parseWindow(value: unknown): GraphWindow {
  if (typeof value !== "object" || value === null) return DEFAULT_WINDOW;
  const { xMin, xMax, yMin, yMax } = value as Record<string, unknown>;
  if (!isNumber(xMin) || !isNumber(xMax) || !isNumber(yMin) || !isNumber(yMax)) {
    return DEFAULT_WINDOW;
  }
  if (!sensibleSpan(xMax - xMin) || !sensibleSpan(yMax - yMin)) return DEFAULT_WINDOW;
  return { xMin, xMax, yMin, yMax };
}

/** Use the 3D box if it makes sense, otherwise a -5 to 5 cube. */
export function parseWindow3D(value: unknown): GraphWindow3D {
  if (typeof value !== "object" || value === null) return DEFAULT_WINDOW_3D;
  const { xMin, xMax, yMin, yMax, zMin, zMax } = value as Record<string, unknown>;
  if (
    !isNumber(xMin) || !isNumber(xMax) ||
    !isNumber(yMin) || !isNumber(yMax) ||
    !isNumber(zMin) || !isNumber(zMax)
  ) {
    return DEFAULT_WINDOW_3D;
  }
  if (!sensibleSpan(xMax - xMin) || !sensibleSpan(yMax - yMin) || !sensibleSpan(zMax - zMin)) {
    return DEFAULT_WINDOW_3D;
  }
  return { xMin, xMax, yMin, yMax, zMin, zMax };
}

function parseCurves(value: unknown): GraphCurve[] {
  if (!Array.isArray(value)) return [];
  const curves: GraphCurve[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { label, kind, expression } = item as Record<string, unknown>;
    if (!isString(label) || !isString(expression)) continue;
    if (kind !== "explicit" && kind !== "implicit") continue;
    if (!tryCompileFormula(expression) || usesVariable(expression, "z")) continue;
    curves.push({ label, kind, expression });
    if (curves.length === MAX_CURVES) break;
  }
  return curves;
}

function parseSurfaces(value: unknown): GraphSurface[] {
  if (!Array.isArray(value)) return [];
  const surfaces: GraphSurface[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { label, solveFor, expression } = item as Record<string, unknown>;
    if (!isString(label) || !isString(expression)) continue;
    if (solveFor !== "x" && solveFor !== "y" && solveFor !== "z") continue;
    // The expression may only use the two variables that are not being solved for.
    if (!tryCompileFormula(expression) || usesVariable(expression, solveFor)) continue;
    surfaces.push({ label, solveFor, expression });
    if (surfaces.length === MAX_SURFACES) break;
  }
  return surfaces;
}

function parsePoints(value: unknown): GraphPoint[] {
  if (!Array.isArray(value)) return [];
  const points: GraphPoint[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { label, x, y, z } = item as Record<string, unknown>;
    if (!isString(label) || !isNumber(x) || !isNumber(y) || !isNumber(z)) continue;
    points.push({ label, x, y, z });
    if (points.length === MAX_POINTS) break;
  }
  return points;
}

/**
 * Check an unknown value (a model reply or an API response) and return it as a
 * GraphResult. Curves and surfaces whose formula can't be read are dropped.
 */
export function parseGraphResult(value: unknown): GraphResult | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  if (v.status === "graphed") {
    if (v.dimension === "3d") {
      const surfaces = parseSurfaces(v.surfaces);
      if (surfaces.length === 0) {
        return { status: "unreadable", message: "I couldn't turn that into a 3D graph. Try writing the equations more clearly." };
      }
      return {
        status: "graphed",
        dimension: "3d",
        surfaces,
        points: parsePoints(v.points),
        window3d: parseWindow3D(v.window3d),
      };
    }

    const curves = parseCurves(v.curves);
    if (curves.length === 0) {
      return { status: "unreadable", message: "I couldn't turn that into a graph. Try writing the equation more clearly." };
    }
    return { status: "graphed", dimension: "2d", curves, window: parseWindow(v.window) };
  }

  if (v.status === "no_graph" || v.status === "unreadable") {
    const message =
      isString(v.message) && v.message.trim() !== "" ? v.message : DEFAULT_MESSAGES[v.status];
    return { status: v.status, message };
  }

  return null;
}
