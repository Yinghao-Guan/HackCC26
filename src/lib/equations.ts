/**
 * Read typed equations without the AI: one per line, like `y = x^2 - 3x + 2`,
 * `f(x) = sin(x)` or `x^2 + y^2 = 25`. Anything unusual (prose, LaTeX,
 * inequalities, handwriting) is refused, so the caller can ask the AI instead.
 */

import { autoWindow } from "./autoWindow";
import { tryCompileFormula, usesVariable } from "./expression";
import type { GraphCurve, GraphWindow } from "./graph";

const MAX_CURVES = 6;

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

function curveFromLine(line: string): GraphCurve | null {
  if (/[<>≤≥≠]/.test(line)) return null;
  const sides = line.split("=");
  if (sides.length !== 2) return null;
  const left = sides[0].trim();
  const right = sides[1].trim();
  if (left === "" || right === "") return null;

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

/**
 * The curves and window for some typed lines, or null if any non-empty line is
 * not a plain equation this can read.
 */
export function graphFromLines(
  lines: string[],
): { curves: GraphCurve[]; window: GraphWindow } | null {
  const curves: GraphCurve[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const curve = curveFromLine(line);
    if (!curve) return null;
    curves.push(curve);
    if (curves.length > MAX_CURVES) return null;
  }
  if (curves.length === 0) return null;
  return { curves, window: autoWindow(curves) };
}
