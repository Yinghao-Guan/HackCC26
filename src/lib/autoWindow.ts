/**
 * Pick a good part of the coordinate plane to show for some curves, the way a
 * graphing calculator does: zoom out just far enough that the points you want
 * to see (where a curve crosses an axis, and its turning points) are on screen.
 */

import { tryCompileFormula, type Formula, type Variable } from "./expression";
import type { GraphCurve, GraphPoint, GraphSurface, GraphWindow, GraphWindow3D } from "./graph";

// Windows run from -R to R. These are the sizes R can take.
const RADII = [6, 12, 25, 50, 100, 250, 1000];
const DEFAULT_REACH = 8; // used when a curve has nothing notable, like 1/x
const SCAN = 100; // look for notable points between -100 and 100
const STEP = 0.02;
const NEAREST = 6; // only the points nearest the origin matter (a sine wave has endless ones)

/** How far from the origin the notable points are, along each axis (all positive). */
interface Features {
  xs: number[];
  ys: number[];
}

const signChanged = (a: number, b: number) => a < 0 !== b < 0 && a !== 0;

function explicitFeatures(formula: Formula): Features {
  const xs: number[] = [];
  const ys: number[] = [];

  let prevX = -SCAN;
  let prevY = formula(prevX, 0);
  let prevSlope = NaN;

  for (let i = 1; i <= (2 * SCAN) / STEP; i++) {
    const x = -SCAN + i * STEP;
    const y = formula(x, 0);

    if (Number.isFinite(prevY) && Number.isFinite(y)) {
      // Where the curve crosses the x-axis (ignoring jumps across an asymptote).
      if (signChanged(prevY, y) && Math.abs(prevY) + Math.abs(y) < 1e3) {
        xs.push(Math.abs(prevX + (x - prevX) * (prevY / (prevY - y))));
      }
      // A turning point: the curve stops rising and starts falling, or the reverse.
      const slope = y - prevY;
      if (Number.isFinite(prevSlope) && prevSlope * slope < 0 && Math.abs(prevY) < 1e6) {
        xs.push(Math.abs(prevX));
        ys.push(Math.abs(prevY));
      }
      prevSlope = slope;
    } else {
      prevSlope = NaN;
    }
    prevX = x;
    prevY = y;
  }

  // Where it crosses the y-axis.
  const atZero = formula(0, 0);
  if (Number.isFinite(atZero)) ys.push(Math.abs(atZero));

  return { xs, ys };
}

/** Where an implicit curve crosses each axis. */
function implicitFeatures(formula: Formula): Features {
  const xs: number[] = [];
  const ys: number[] = [];

  for (let i = 1; i <= (2 * SCAN) / STEP; i++) {
    const t0 = -SCAN + (i - 1) * STEP;
    const t1 = -SCAN + i * STEP;
    const x0 = formula(t0, 0);
    const x1 = formula(t1, 0);
    if (Number.isFinite(x0) && Number.isFinite(x1) && signChanged(x0, x1)) {
      xs.push(Math.abs(t0 + (t1 - t0) * (x0 / (x0 - x1))));
    }
    const y0 = formula(0, t0);
    const y1 = formula(0, t1);
    if (Number.isFinite(y0) && Number.isFinite(y1) && signChanged(y0, y1)) {
      ys.push(Math.abs(t0 + (t1 - t0) * (y0 / (y0 - y1))));
    }
  }
  return { xs, ys };
}

const nearest = (values: number[]) => [...values].sort((a, b) => a - b).slice(0, NEAREST);

/** The smallest window radius that leaves a margin around the farthest notable point. */
function radiusFor(values: number[]): number {
  const reach = values.length > 0 ? Math.max(...values) : DEFAULT_REACH;
  return RADII.find((r) => 0.8 * r >= reach) ?? RADII[RADII.length - 1];
}

export function autoWindow(curves: GraphCurve[]): GraphWindow {
  const xs: number[] = [];
  const ys: number[] = [];
  let anyImplicit = false;

  for (const curve of curves) {
    const formula = tryCompileFormula(curve.expression);
    if (!formula) continue;
    const found = curve.kind === "explicit" ? explicitFeatures(formula) : implicitFeatures(formula);
    xs.push(...nearest(found.xs));
    ys.push(...nearest(found.ys));
    if (curve.kind === "implicit") anyImplicit = true;
  }

  let rx = radiusFor(xs);
  let ry = radiusFor(ys);
  // Keep the shape true (a circle round) unless x and y need very different zooms.
  if (anyImplicit || Math.max(rx, ry) / Math.min(rx, ry) < 4) rx = ry = Math.max(rx, ry);

  return { xMin: -rx, xMax: rx, yMin: -ry, yMax: ry };
}

// ---------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------

const RADII_3D = [5, 10, 20, 50, 100];
const HEIGHT_SAMPLES = 30;

/**
 * Pick a box of 3D space to show: a cube around the origin that is big enough
 * for any notable points, stretched along the axis a surface rises on so that
 * the surface is not cut off too early.
 */
export function autoWindow3D(surfaces: GraphSurface[], points: GraphPoint[]): GraphWindow3D {
  const reach = Math.max(
    3.5,
    ...points.flatMap((point) => [Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)]),
  );
  const R = RADII_3D.find((r) => 0.8 * r >= reach) ?? RADII_3D[RADII_3D.length - 1];

  const lo: Record<Variable, number> = { x: -R, y: -R, z: -R };
  const hi: Record<Variable, number> = { x: R, y: R, z: R };
  const stretched = new Set<Variable>();

  for (const surface of surfaces) {
    const formula = tryCompileFormula(surface.expression);
    if (!formula) continue;

    // How high or low does this surface go, over the cube's footprint?
    const [uAxis, vAxis] = (["x", "y", "z"] as const).filter((axis) => axis !== surface.solveFor);
    let min = Infinity;
    let max = -Infinity;
    for (let j = 0; j <= HEIGHT_SAMPLES; j++) {
      for (let i = 0; i <= HEIGHT_SAMPLES; i++) {
        const point = { x: 0, y: 0, z: 0 };
        point[uAxis] = -R + (2 * R * i) / HEIGHT_SAMPLES;
        point[vAxis] = -R + (2 * R * j) / HEIGHT_SAMPLES;
        const height = formula(point.x, point.y, point.z);
        if (Number.isFinite(height)) {
          min = Math.min(min, height);
          max = Math.max(max, height);
        }
      }
    }
    if (min > max) continue;

    let from = Math.max(-2 * R, Math.min(0, min)) - 0.05 * R;
    let to = Math.min(2 * R, Math.max(0, max)) + 0.05 * R;
    if (to - from < R) {
      const middle = (from + to) / 2;
      from = middle - R / 2;
      to = middle + R / 2;
    }

    const axis = surface.solveFor;
    // Several surfaces on one axis share one range that covers them all.
    lo[axis] = stretched.has(axis) ? Math.min(lo[axis], from) : from;
    hi[axis] = stretched.has(axis) ? Math.max(hi[axis], to) : to;
    stretched.add(axis);
  }

  return { xMin: lo.x, xMax: hi.x, yMin: lo.y, yMax: hi.y, zMin: lo.z, zMax: hi.z };
}
