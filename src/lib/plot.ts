/** Geometry for drawing graphs: tick marks and the paths of curves. No React in here. */

import type { Formula } from "./expression";
import type { GraphWindow } from "./graph";

/** A tidy tick spacing (1, 2, 5, 10, ...) that gives about `target` ticks across `span`. */
export function niceStep(span: number, target = 8): number {
  const raw = span / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
  return nice * power;
}

/** The multiples of `step` between min and max. */
export function tickValues(min: number, max: number, step: number): number[] {
  const values: number[] = [];
  const first = Math.ceil(min / step - 1e-9) * step;
  for (let v = first; v <= max + step * 1e-9; v += step) {
    values.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  }
  return values;
}

/** A tick value as text, without floating-point leftovers like 0.30000000000000004. */
export function formatTick(value: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(value.toFixed(decimals)).toString();
}

const clampPixel = (v: number) => Math.max(-1e5, Math.min(1e5, v));

/**
 * The SVG path of y = f(x) across the window. The pen lifts where the formula
 * is undefined and where the curve jumps (like tan or 1/x at an asymptote).
 */
export function explicitPath(
  formula: Formula,
  window: GraphWindow,
  width: number,
  height: number,
): string {
  const xSpan = window.xMax - window.xMin;
  const ySpan = window.yMax - window.yMin;
  const samples = Math.max(200, Math.round(width * 2));

  let path = "";
  let penDown = false;
  let previousY = 0;

  for (let i = 0; i <= samples; i++) {
    const x = window.xMin + (xSpan * i) / samples;
    const y = formula(x, 0);

    if (!Number.isFinite(y)) {
      penDown = false;
      continue;
    }
    if (penDown && Math.abs(y - previousY) > 3 * ySpan) penDown = false;

    const px = (((x - window.xMin) / xSpan) * width).toFixed(1);
    const py = clampPixel(height - ((y - window.yMin) / ySpan) * height).toFixed(1);
    path += `${penDown ? "L" : "M"}${px} ${py}`;
    penDown = true;
    previousY = y;
  }
  return path;
}

/**
 * The SVG path of the curve where f(x, y) = 0, such as a circle, found with
 * marching squares: split the window into cells, and in each cell where f
 * changes sign, draw a short line across it.
 */
export function implicitPath(
  formula: Formula,
  window: GraphWindow,
  width: number,
  height: number,
  cells = 140,
): string {
  const columns = cells + 1;
  const dx = (window.xMax - window.xMin) / cells;
  const dy = (window.yMax - window.yMin) / cells;

  const values = new Float64Array(columns * columns);
  for (let j = 0; j < columns; j++) {
    for (let i = 0; i < columns; i++) {
      values[j * columns + i] = formula(window.xMin + i * dx, window.yMin + j * dy);
    }
  }

  // Grid coordinates (0..cells) to pixels; y grows upward on the grid and downward on screen.
  const px = (gx: number) => ((gx / cells) * width).toFixed(1);
  const py = (gy: number) => (height - (gy / cells) * height).toFixed(1);

  type GridPoint = [number, number];
  let path = "";
  const line = (a: GridPoint, b: GridPoint) => {
    path += `M${px(a[0])} ${py(a[1])}L${px(b[0])} ${py(b[1])}`;
  };

  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const v00 = values[j * columns + i]; // bottom-left corner
      const v10 = values[j * columns + i + 1]; // bottom-right
      const v11 = values[(j + 1) * columns + i + 1]; // top-right
      const v01 = values[(j + 1) * columns + i]; // top-left
      if (!Number.isFinite(v00 + v10 + v11 + v01)) continue;

      // Where the curve crosses each edge of the cell, if it does.
      const bottom: GridPoint | null =
        v00 > 0 !== v10 > 0 ? [i + v00 / (v00 - v10), j] : null;
      const right: GridPoint | null =
        v10 > 0 !== v11 > 0 ? [i + 1, j + v10 / (v10 - v11)] : null;
      const top: GridPoint | null =
        v01 > 0 !== v11 > 0 ? [i + v01 / (v01 - v11), j + 1] : null;
      const left: GridPoint | null =
        v00 > 0 !== v01 > 0 ? [i, j + v00 / (v00 - v01)] : null;

      const crossings = [bottom, right, top, left].filter((c): c is GridPoint => c !== null);
      if (crossings.length === 2) {
        line(crossings[0], crossings[1]);
      } else if (crossings.length === 4 && bottom && right && top && left) {
        // Opposite corners share a sign: use the middle of the cell to decide how they connect.
        const centerPositive = v00 + v10 + v11 + v01 > 0;
        if (centerPositive === v00 > 0) {
          line(bottom, right);
          line(top, left);
        } else {
          line(bottom, left);
          line(right, top);
        }
      }
    }
  }
  return path;
}
