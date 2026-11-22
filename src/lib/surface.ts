/** Geometry for 3D surfaces: a grid of points over the surface, as triangles and wire lines. No three.js in here. */

import type { Formula } from "./expression";
import type { GraphWindow3D, SolveFor } from "./graph";

export interface SurfaceMesh {
  /** x, y, z of every grid point, in maths coordinates (3 numbers per point). */
  positions: Float32Array;
  /** Triangles, as groups of three indexes into the points. Cells with a missing corner are left out. */
  triangles: Uint32Array;
  /** Wire lines along every few rows and columns, as pairs of indexes. */
  lines: Uint32Array;
}

/**
 * Sample a surface such as z = f(x, y) over the window. `solveFor` is the
 * variable the formula gives (z in that example); the grid runs over the other
 * two. Where the formula is undefined the grid is left open, and where the surface
 * leaves the box it is cut off at the box's face instead of drawing a stretched surface.
 */
export function surfaceMesh(
  formula: Formula,
  solveFor: SolveFor,
  window: GraphWindow3D,
  cells = 80,
  lineEvery = 8,
): SurfaceMesh {
  const columns = cells + 1;

  // Which axes the grid runs over, and which one holds the height.
  const range = {
    x: [window.xMin, window.xMax],
    y: [window.yMin, window.yMax],
    z: [window.zMin, window.zMax],
  } as const;
  const across = (["x", "y", "z"] as const).filter((axis) => axis !== solveFor);
  const [uAxis, vAxis] = across;
  const [hMin, hMax] = range[solveFor];
  const slack = 0.01 * (hMax - hMin);

  const heightAt = (u: number, v: number) => {
    const point = { x: 0, y: 0, z: 0 };
    point[uAxis] = u;
    point[vAxis] = v;
    return formula(point.x, point.y, point.z);
  };
  const uOf = (i: number) => range[uAxis][0] + ((range[uAxis][1] - range[uAxis][0]) * i) / cells;
  const vOf = (j: number) => range[vAxis][0] + ((range[vAxis][1] - range[vAxis][0]) * j) / cells;

  // Where each grid point is relative to the box: 0 inside, 1 above it, -1 below it,
  // MISSING where the formula has no value.
  const MISSING = 2;
  const side = new Int8Array(columns * columns);
  const gridU = new Float64Array(columns * columns);
  const gridV = new Float64Array(columns * columns);
  const gridHeight = new Float64Array(columns * columns);

  const place = (index: number, u: number, v: number, height: number) => {
    gridU[index] = u;
    gridV[index] = v;
    // Points off the box sit on its face, and missing ones in the middle, so the
    // geometry never holds NaN or huge numbers.
    if (!Number.isFinite(height)) {
      side[index] = MISSING;
      gridHeight[index] = (hMin + hMax) / 2;
    } else if (height > hMax + slack) {
      side[index] = 1;
      gridHeight[index] = hMax;
    } else if (height < hMin - slack) {
      side[index] = -1;
      gridHeight[index] = hMin;
    } else {
      side[index] = 0;
      gridHeight[index] = Math.max(hMin, Math.min(hMax, height));
    }
  };

  for (let j = 0; j < columns; j++) {
    for (let i = 0; i < columns; i++) {
      const u = uOf(i);
      const v = vOf(j);
      place(j * columns + i, u, v, heightAt(u, v));
    }
  }

  /**
   * Where the formula stops having a value (the rim of a half sphere, say) a plain grid
   * leaves a coarse staircase. So slide each missing point along the grid line to a
   * neighbour that has a value, up to the last place that still does. Where that place
   * is far off the box (an asymptote), leave the point missing: it is not a real edge.
   */
  const known = side.slice();
  const NEIGHBOURS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let j = 0; j < columns; j++) {
    for (let i = 0; i < columns; i++) {
      const index = j * columns + i;
      if (known[index] !== MISSING) continue;

      for (const [di, dj] of NEIGHBOURS) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= columns || nj >= columns) continue;
        if (known[nj * columns + ni] !== 0) continue;

        const u0 = uOf(ni);
        const v0 = vOf(nj);
        const du = uOf(i) - u0;
        const dv = vOf(j) - v0;
        let near = 0; // has a value
        let far = 1; // has none
        for (let step = 0; step < 14; step++) {
          const mid = (near + far) / 2;
          if (Number.isFinite(heightAt(u0 + du * mid, v0 + dv * mid))) near = mid;
          else far = mid;
        }
        const u = u0 + du * near;
        const v = v0 + dv * near;
        const height = heightAt(u, v);
        if (Number.isFinite(height) && height >= hMin - slack && height <= hMax + slack) {
          place(index, u, v, height);
          break;
        }
      }
    }
  }

  const positions = new Float32Array(columns * columns * 3);
  for (let index = 0; index < columns * columns; index++) {
    const point = { x: 0, y: 0, z: 0 };
    point[uAxis] = gridU[index];
    point[vAxis] = gridV[index];
    point[solveFor] = gridHeight[index];
    positions.set([point.x, point.y, point.z], index * 3);
  }

  /**
   * Corners of a cell can be drawn together when at least one is inside the box and every
   * one outside the box is on the same side. That keeps the rim where the surface leaves
   * the box tidy, but leaves out cells that straddle an asymptote (one corner far above and
   * another far below), so no wall is drawn across it.
   */
  const together = (corners: number[]) => {
    const outside = corners.filter((index) => side[index] !== 0);
    if (outside.length === corners.length) return false;
    return outside.every((index) => side[index] === side[outside[0]]);
  };

  const triangles: number[] = [];
  const lines: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      // The cell's corners, going round: a, b, d, c.
      const a = j * columns + i;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;

      const missing = [a, b, d, c].filter((index) => side[index] === MISSING);
      if (missing.length === 0) {
        if (!together([a, b, c, d])) continue;
        triangles.push(a, b, d, a, d, c);

        // Wire lines along every `lineEvery`th row and column, and along the far edges.
        if (j % lineEvery === 0) lines.push(a, b);
        if (i % lineEvery === 0) lines.push(a, c);
        if (j === cells - 1) lines.push(c, d);
        if (i === cells - 1) lines.push(b, d);
      } else if (missing.length === 1) {
        // Along the edge of where the formula has a value, a cell often has just one corner
        // that could not be reached. Draw the triangle the other three make, in the same
        // order round the cell, so the edge isn't left with notches.
        const rest = [a, b, d, c].filter((index) => index !== missing[0]);
        if (together(rest)) triangles.push(rest[0], rest[1], rest[2]);
      }
    }
  }

  return {
    positions,
    triangles: Uint32Array.from(triangles),
    lines: Uint32Array.from(lines),
  };
}
