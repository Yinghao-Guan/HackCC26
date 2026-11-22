// A homography maps points on one plane to points on another, such as the board as
// seen by the camera to the board as drawn by the projector. It is what lets a
// fingertip in the camera picture become a position on the whiteboard
// (docs/02-technical-design.md, section 3). Plain functions, no React.

import type { Point } from "./shadowTouch";

/** A 3x3 matrix, row by row: nine numbers. */
export type Matrix = number[];

/** Solve a x = b by Gaussian elimination. Null if the system has no single answer. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(m[row][column]) > Math.abs(m[pivot][column])) pivot = row;
    }
    if (Math.abs(m[pivot][column]) < 1e-12) return null;
    [m[column], m[pivot]] = [m[pivot], m[column]];
    for (let row = column + 1; row < n; row++) {
      const factor = m[row][column] / m[column][column];
      for (let k = column; k <= n; k++) m[row][k] -= factor * m[column][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = m[row][n];
    for (let k = row + 1; k < n; k++) sum -= m[row][k] * x[k];
    x[row] = sum / m[row][row];
  }
  return x;
}

/**
 * The homography that takes each point in `from` to the matching point in `to`
 * (at least four pairs; with more it is the best fit in the least-squares sense).
 * Null if the points do not pin it down, for example if they lie on a line.
 */
export function fitHomography(from: Point[], to: Point[]): Matrix | null {
  if (from.length < 4 || from.length !== to.length) return null;

  // Eight unknowns (the ninth entry is fixed at 1). Each pair gives two equations; solve them in
  // the least-squares sense through the normal equations.
  const rows: number[][] = [];
  const values: number[] = [];
  from.forEach((p, i) => {
    const q = to[i];
    rows.push([p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y]);
    values.push(q.x);
    rows.push([0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y]);
    values.push(q.y);
  });

  const normal = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const right = new Array<number>(8).fill(0);
  rows.forEach((row, r) => {
    for (let i = 0; i < 8; i++) {
      right[i] += row[i] * values[r];
      for (let j = 0; j < 8; j++) normal[i][j] += row[i] * row[j];
    }
  });

  const h = solve(normal, right);
  return h ? [...h, 1] : null;
}

/** Where a point goes under the homography. */
export function applyHomography(h: Matrix, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

/** How far, on average (root mean square), the homography lands from where the points should go. */
export function rmsError(h: Matrix, from: Point[], to: Point[]): number {
  let sum = 0;
  from.forEach((p, i) => {
    const q = applyHomography(h, p);
    sum += (q.x - to[i].x) ** 2 + (q.y - to[i].y) ** 2;
  });
  return Math.sqrt(sum / from.length);
}
