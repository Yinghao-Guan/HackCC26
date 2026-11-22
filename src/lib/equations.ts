/**
 * Read typed equations without the AI: one per line, like `y = x^2 - 3x + 2`,
 * `f(x) = sin(x)`, `x^2 + y^2 = 25`, or in 3D `z = x^2 + y^2` and
 * `x + y + z = 6`. Anything unusual (prose, LaTeX, inequalities, handwriting)
 * is refused, so the caller can ask the AI instead.
 */

import { autoWindow, autoWindow3D } from "./autoWindow";
import { tryCompileFormula, usesVariable, type Formula, type Variable } from "./expression";
import type { GraphCurve, GraphPoint, GraphResult, GraphSurface } from "./graph";

type Graphed = Extract<GraphResult, { status: "graphed" }>;

const MAX_CURVES = 6;
const MAX_SURFACES = 4;

// "y", or "f(x)" and friends, mean y.
const isY = (side: string) => /^(y|[a-wz]\s*\(\s*x\s*\))$/i.test(side);

/** Find "name(...)" in the text and replace each with `wrap(inside)`, handling nested brackets. */
function replaceCalls(text: string, name: string, wrap: (inside: string) => string): string {
  const open = new RegExp(`\\b${name}\\(`);
  for (;;) {
    const match = open.exec(text);
    if (!match) return text;

    let depth = 1;
    let end = match.index + match[0].length;
    while (end < text.length && depth > 0) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")") depth--;
      end++;
    }
    if (depth !== 0) return text; // unbalanced brackets: leave it alone

    const inside = replaceCalls(text.slice(match.index + match[0].length, end - 1), name, wrap);
    text = text.slice(0, match.index) + wrap(inside) + text.slice(end);
  }
}

/** Turn typed maths like `y = x^10 + sqrt(x)` into LaTeX for the graph's key. Good for common cases. */
export function toLatex(text: string): string {
  let out = text.replace(/\*\*/g, "^");
  out = replaceCalls(out, "sqrt", (s) => `\\sqrt{${s}}`);
  out = replaceCalls(out, "cbrt", (s) => `\\sqrt[3]{${s}}`);
  out = replaceCalls(out, "abs", (s) => `\\left|${s}\\right|`);
  out = out
    .replace(/\^\(([^()]*)\)/g, "^{$1}") // x^(n+1) -> x^{n+1}
    .replace(/\^(?!\{)(-?[A-Za-z0-9.]+)/g, "^{$1}") // x^10 -> x^{10}
    .replace(/\b(asin|acos|atan)\b/g, (_, name: string) => `\\arc${name.slice(1)}`)
    .replace(/\b(sin|cos|tan|sec|csc|cot|sinh|cosh|tanh|ln|log|exp)\b/g, "\\$1")
    .replace(/\bpi\b/g, "\\pi")
    .replace(/\*/g, " \\cdot ");
  return out;
}

interface Equation {
  line: string;
  left: string;
  right: string;
}

function splitEquation(line: string): Equation | null {
  if (/[<>≤≥≠]/.test(line)) return null;
  const sides = line.split("=");
  if (sides.length !== 2) return null;
  const left = sides[0].trim();
  const right = sides[1].trim();
  if (left === "" || right === "") return null;
  return { line, left, right };
}

const mentions = (equation: Equation, variable: Variable) =>
  usesVariable(equation.left, variable) || usesVariable(equation.right, variable);

// ---------------------------------------------------------------------------
// Flat (2D) graphs
// ---------------------------------------------------------------------------

function curveFromEquation({ line, left, right }: Equation): GraphCurve | null {
  // y = (something in x): draw y directly. Anything else: draw where left minus right is zero.
  let kind: GraphCurve["kind"];
  let expression: string;
  if (isY(left) && !usesVariable(right, "y")) {
    kind = "explicit";
    expression = right;
  } else if (isY(right) && !usesVariable(left, "y")) {
    kind = "explicit";
    expression = left;
  } else {
    kind = "implicit";
    expression = `(${left}) - (${right})`;
  }

  if (!tryCompileFormula(expression)) return null;
  if (!usesVariable(expression, "x") && !usesVariable(expression, "y")) return null;
  return { label: toLatex(line), kind, expression };
}

function graph2D(equations: Equation[]): Graphed | null {
  const curves: GraphCurve[] = [];
  for (const equation of equations) {
    const curve = curveFromEquation(equation);
    if (!curve) return null;
    curves.push(curve);
  }
  return { status: "graphed", dimension: "2d", curves, window: autoWindow(curves) };
}

// ---------------------------------------------------------------------------
// 3D graphs
// ---------------------------------------------------------------------------

/** A plane: a*x + b*y + c*z + d = 0. */
interface Plane {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** If `difference` (left side minus right side) is a flat plane, its coefficients. */
function planeOf(difference: Formula): Plane | null {
  const d = difference(0, 0, 0);
  const a = difference(1, 0, 0) - d;
  const b = difference(0, 1, 0) - d;
  const c = difference(0, 0, 1) - d;
  if (![a, b, c, d].every(Number.isFinite)) return null;
  if (a === 0 && b === 0 && c === 0) return null;

  // A plane is exactly linear, so check it at a few other places too.
  for (const [x, y, z] of [[2, -3, 5], [-1.5, 4, 0.5], [7, 2, -6]]) {
    const actual = difference(x, y, z);
    const expected = d + a * x + b * y + c * z;
    if (!(Math.abs(actual - expected) <= 1e-9 * (1 + Math.abs(actual)))) return null;
  }
  return { a, b, c, d };
}

/** The formula that gives `solveFor` for a plane, in terms of the other two variables. */
function planeExpression(plane: Plane, solveFor: Variable): string {
  const coefficient = { x: plane.a, y: plane.b, z: plane.c };
  const pivot = coefficient[solveFor];
  const others = (["x", "y", "z"] as const).filter((v) => v !== solveFor);
  const number = (n: number) => `(${Number(n.toPrecision(12))})`;
  return [
    number(-plane.d / pivot),
    ...others.map((v) => `${number(-coefficient[v] / pivot)}*${v}`),
  ].join(" + ");
}

function surfaceFromEquation(equation: Equation): { surface: GraphSurface; plane: Plane | null } | null {
  const { line, left, right } = equation;
  const difference = tryCompileFormula(`(${left}) - (${right})`);
  if (!difference) return null;
  const plane = planeOf(difference);
  const label = toLatex(line);

  // One side is a lone variable that the other side doesn't use: z = x^2 + y^2, y = 2x + z, x = 3.
  for (const variable of ["z", "y", "x"] as const) {
    if (left === variable && !usesVariable(right, variable)) {
      return { surface: { label, solveFor: variable, expression: right }, plane };
    }
    if (right === variable && !usesVariable(left, variable)) {
      return { surface: { label, solveFor: variable, expression: left }, plane };
    }
  }

  // Otherwise a flat plane in any arrangement, like x + y + z = 6, can be solved for one variable.
  if (plane) {
    const solveFor: Variable = plane.c !== 0 ? "z" : plane.b !== 0 ? "y" : "x";
    return { surface: { label, solveFor, expression: planeExpression(plane, solveFor) }, plane };
  }
  return null;
}

const det3 = (m: number[][]) =>
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
  m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
  m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

/** Where three planes meet, if they meet at a single point. */
function meetingPoint(planes: Plane[]): GraphPoint | null {
  const matrix = planes.map((p) => [p.a, p.b, p.c]);
  const right = planes.map((p) => -p.d);
  const determinant = det3(matrix);
  if (Math.abs(determinant) < 1e-9) return null;

  const solve = (column: number) =>
    det3(matrix.map((row, i) => row.map((value, j) => (j === column ? right[i] : value)))) /
    determinant;
  const [x, y, z] = [solve(0), solve(1), solve(2)];
  if (![x, y, z].every(Number.isFinite)) return null;

  const show = (n: number) => String(Number(n.toFixed(3)));
  return { label: `(${show(x)}, ${show(y)}, ${show(z)})`, x, y, z };
}

function graph3D(equations: Equation[]): Graphed | null {
  if (equations.length > MAX_SURFACES) return null;

  const surfaces: GraphSurface[] = [];
  const planes: (Plane | null)[] = [];
  for (const equation of equations) {
    const found = surfaceFromEquation(equation);
    if (!found) return null;
    surfaces.push(found.surface);
    planes.push(found.plane);
  }

  // Three planes that meet at one point: mark it, as the answer to the system.
  const points: GraphPoint[] = [];
  if (planes.length === 3 && planes.every((plane): plane is Plane => plane !== null)) {
    const point = meetingPoint(planes);
    if (point) points.push(point);
  }

  return { status: "graphed", dimension: "3d", surfaces, points, window3d: autoWindow3D(surfaces, points) };
}

// ---------------------------------------------------------------------------

/**
 * The graph for some typed lines, or null if any non-empty line is not a plain
 * equation this can read. If any line has z in it, everything is read as 3D.
 */
export function graphFromLines(lines: string[]): Graphed | null {
  const equations: Equation[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const equation = splitEquation(line);
    if (!equation) return null;
    equations.push(equation);
    if (equations.length > MAX_CURVES) return null;
  }
  if (equations.length === 0) return null;

  return equations.some((equation) => mentions(equation, "z"))
    ? graph3D(equations)
    : graph2D(equations);
}
