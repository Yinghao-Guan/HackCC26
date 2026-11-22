// Shadow touch: telling when a fingertip touches the board from the finger's shadow
// (docs/02-technical-design.md, section 4). The projector lights the board, so the
// hand casts a shadow on it. A fingertip high above the board has its shadow
// far from it, and as the finger comes down the shadow tip slides under it. At
// contact they meet.
//
// Method: compare the camera picture with a picture of the empty board (the
// reference). Pixels that are clearly darker than before, and not part of the
// hand, are shadow. Then find the tip of the fingertip's own shadow: the shadow
// that is farthest ahead along the finger, in a box laid along it. The gap is the
// distance from the fingertip to that shadow tip, in hand sizes so that it means
// the same near and far. (Looking at the nearest shadow of any kind does not work:
// the shadow of the arm and the rest of the hand lies close to the fingertip even
// when the finger is high.) Plain functions on pixel data, no React, no canvas.

import { luminance } from "./luma";

export interface Point {
  x: number;
  y: number;
}

/** Pixel data shaped like the browser's ImageData, so this can run and be tested outside the browser. */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** What the empty board looks like: its brightness at every pixel. */
export interface Reference {
  luma: Float32Array;
  width: number;
  height: number;
}

/** Where the board is not lit by the projector (the wall, the floor) a shadow means nothing, so it is skipped. */
export const MIN_BOARD_LUMA = 40;

/**
 * Where to look for the tip of the fingertip's shadow: a box laid along the finger,
 * this many hand sizes behind the fingertip, ahead of it, and to either side.
 * The shadow of the arm and of the rest of the hand mostly lies outside its sides.
 */
export const BAND_BEHIND = 0.4;
export const BAND_AHEAD = 2.4;
export const BAND_SIDE = 1.2;

/** A touch starts and ends only after this many frames in a row agree, so one bad frame cannot break a line. */
export const FRAMES_TO_SWITCH = 2;

const SEARCH_STEP = 2; // look at every second pixel: plenty for shadows, and four times faster
const TIP_DEPTH = 0.06; // the shadow tip is the average of the shadow within this many hand sizes of its farthest point

export function lumaOf(pixels: Pixels): Float32Array {
  const { data } = pixels;
  const out = new Float32Array(pixels.width * pixels.height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = luminance(data[i], data[i + 1], data[i + 2]);
  }
  return out;
}

/** Add a frame's brightness to a running sum, for averaging several frames into a reference. */
export function addFrame(sum: Float32Array, luma: Float32Array): void {
  for (let i = 0; i < sum.length; i++) sum[i] += luma[i];
}

export function averageOf(sum: Float32Array, count: number): Float32Array {
  const out = new Float32Array(sum.length);
  for (let i = 0; i < sum.length; i++) out[i] = sum[i] / count;
  return out;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The smallest convex shape around some points (Andrew's monotone chain). */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const build = (input: Point[]) => {
    const half: Point[] = [];
    for (const p of input) {
      while (half.length >= 2 && cross(half[half.length - 2], half[half.length - 1], p) <= 0) {
        half.pop();
      }
      half.push(p);
    }
    half.pop();
    return half;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

/** The part of the picture taken up by a hand: a convex shape, and how big the hand is. */
export interface HandShape {
  hull: Point[];
  /** The size of the hand in pixels (palm width or palm length, whichever is larger). */
  scale: number;
}

/**
 * The shape of a hand from its 21 landmarks, in pixels. The forearm is included
 * because it is as dark as the hand and must not be taken for shadow.
 */
export function handShape(points: Point[]): HandShape {
  const wrist = points[0];
  const middleKnuckle = points[9];
  const back = { x: wrist.x - middleKnuckle.x, y: wrist.y - middleKnuckle.y };
  const forearm = [1.5, 3].map((k) => ({ x: wrist.x + back.x * k, y: wrist.y + back.y * k }));
  const scale = Math.max(distance(points[5], points[17]), distance(wrist, middleKnuckle));
  return { hull: convexHull([...points, ...forearm]), scale };
}

/** How far a point is outside the hand's shape (0 inside it). */
export function distanceToHand(p: Point, hand: HandShape): number {
  const { hull } = hand;
  let inside = true;
  let nearest = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < 0) inside = false;
    nearest = Math.min(nearest, distanceToSegment(p, a, b));
  }
  return inside ? 0 : nearest;
}

/** The direction a finger points in the picture: from its middle joint to its tip, as a unit vector. */
export function fingerDirection(joint: Point, tip: Point): Point {
  const length = distance(joint, tip);
  return length === 0 ? { x: 1, y: 0 } : { x: (tip.x - joint.x) / length, y: (tip.y - joint.y) / length };
}

/** The four corners of the box in which the fingertip's shadow tip is looked for, in pixels. */
export function bandCorners(tip: Point, direction: Point, scale: number): Point[] {
  const side = { x: -direction.y, y: direction.x };
  const corner = (along: number, across: number) => ({
    x: tip.x + (direction.x * along + side.x * across) * scale,
    y: tip.y + (direction.y * along + side.y * across) * scale,
  });
  return [
    corner(-BAND_BEHIND, -BAND_SIDE),
    corner(BAND_AHEAD, -BAND_SIDE),
    corner(BAND_AHEAD, BAND_SIDE),
    corner(-BAND_BEHIND, BAND_SIDE),
  ];
}

/**
 * How much brighter or darker the whole picture is than the reference (1 is the
 * same). Cameras change their exposure on their own, for example when a hand
 * comes in, and that must not look like shadow. The middle value is used, so the
 * shadow itself, which covers a minority of the board, does not pull it.
 */
export function exposureGain(frame: Float32Array, ref: Reference, hand: HandShape, margin: number): number {
  const { width, height, luma } = ref;
  const keepAway = margin * hand.scale * 1.5;
  const ratios: number[] = [];
  for (let y = 4; y < height; y += 8) {
    for (let x = 4; x < width; x += 8) {
      const i = y * width + x;
      if (luma[i] < MIN_BOARD_LUMA) continue;
      if (distanceToHand({ x, y }, hand) <= keepAway) continue;
      ratios.push(frame[i] / luma[i]);
    }
  }
  if (ratios.length < 50) return 1;
  ratios.sort((a, b) => a - b);
  return ratios[ratios.length >> 1];
}

export interface ShadowParams {
  /** A pixel is shadow when it is darker than this share of the empty board (0 to 1). */
  shadowRatio: number;
  /** How far past the hand's outline to stay clear of, in hand sizes, so skin is not taken for shadow. */
  handMargin: number;
}

export interface ShadowReading {
  /**
   * How far the tip of the fingertip's shadow is from the fingertip, in hand
   * sizes, not counting the hand's own margin. About 0 when the fingertip touches
   * its shadow and larger the higher the finger is. Null if no shadow was found
   * in the box along the finger.
   */
  gap: number | null;
  /** Where the tip of the fingertip's shadow is, in pixels. */
  shadowTip: Point | null;
  /** How many pixels in the box along the finger are shadow. */
  shadowPixels: number;
  /** How much the picture's exposure has changed since the reference. */
  gain: number;
}

/**
 * Find the tip of a fingertip's shadow. `direction` is the way the finger points
 * (see fingerDirection). If `paint` (RGBA pixels the same size as the picture) is
 * given, the pixels found to be shadow are painted cyan in it.
 */
export function readShadow(
  frame: Float32Array,
  ref: Reference,
  tip: Point,
  direction: Point,
  hand: HandShape,
  params: ShadowParams,
  paint?: Uint8ClampedArray,
): ShadowReading {
  const { width, height, luma } = ref;
  const gain = exposureGain(frame, ref, hand, params.handMargin);
  const margin = params.handMargin * hand.scale;
  const scale = hand.scale;

  // A square around the fingertip that holds the whole box along the finger.
  const radius = Math.max(BAND_AHEAD, BAND_SIDE * Math.SQRT2) * scale;
  const left = Math.max(0, Math.floor(tip.x - radius));
  const top = Math.max(0, Math.floor(tip.y - radius));
  const right = Math.min(width - 1, Math.ceil(tip.x + radius));
  const bottom = Math.min(height - 1, Math.ceil(tip.y + radius));
  const columns = Math.floor((right - left) / SEARCH_STEP) + 1;
  const rows = Math.floor((bottom - top) / SEARCH_STEP) + 1;
  if (columns <= 0 || rows <= 0) return { gap: null, shadowTip: null, shadowPixels: 0, gain };

  // Where a pixel is in the box: how far ahead of the fingertip along the finger, and how far to the side.
  const alongOf = (x: number, y: number) => ((x - tip.x) * direction.x + (y - tip.y) * direction.y) / scale;
  const acrossOf = (x: number, y: number) => ((x - tip.x) * -direction.y + (y - tip.y) * direction.x) / scale;

  // First find the pixels in the box that are darker than the empty board and are not the hand.
  const dark = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = left + column * SEARCH_STEP;
      const y = top + row * SEARCH_STEP;
      const along = alongOf(x, y);
      if (along < -BAND_BEHIND || along > BAND_AHEAD) continue;
      if (Math.abs(acrossOf(x, y)) > BAND_SIDE) continue;
      const i = y * width + x;
      if (luma[i] < MIN_BOARD_LUMA) continue;
      if (frame[i] / luma[i] / gain >= params.shadowRatio) continue;
      if (distanceToHand({ x, y }, hand) <= margin) continue;
      dark[row * columns + column] = 1;
    }
  }

  // Then keep those with at least three dark neighbors, so single noisy pixels do not count.
  const kept: { x: number; y: number; along: number }[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (!dark[row * columns + column]) continue;
      const neighbors =
        (column > 0 ? dark[row * columns + column - 1] : 0) +
        (column < columns - 1 ? dark[row * columns + column + 1] : 0) +
        (row > 0 ? dark[(row - 1) * columns + column] : 0) +
        (row < rows - 1 ? dark[(row + 1) * columns + column] : 0);
      if (neighbors < 3) continue;

      const x = left + column * SEARCH_STEP;
      const y = top + row * SEARCH_STEP;
      kept.push({ x, y, along: alongOf(x, y) });
      if (paint) {
        for (let dy = 0; dy < SEARCH_STEP && y + dy < height; dy++) {
          for (let dx = 0; dx < SEARCH_STEP && x + dx < width; dx++) {
            const p = ((y + dy) * width + x + dx) * 4;
            paint[p] = 34;
            paint[p + 1] = 211;
            paint[p + 2] = 238;
            paint[p + 3] = 190;
          }
        }
      }
    }
  }
  if (kept.length === 0) return { gap: null, shadowTip: null, shadowPixels: 0, gain };

  // The tip of the shadow is where it reaches farthest ahead along the finger.
  let farthest = -Infinity;
  for (const pixel of kept) farthest = Math.max(farthest, pixel.along);
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const pixel of kept) {
    if (pixel.along >= farthest - TIP_DEPTH) {
      sumX += pixel.x;
      sumY += pixel.y;
      count++;
    }
  }
  const shadowTip = { x: sumX / count, y: sumY / count };

  return {
    gap: Math.max(0, distance(shadowTip, tip) - margin) / scale,
    shadowTip,
    shadowPixels: kept.length * SEARCH_STEP * SEARCH_STEP,
    gain,
  };
}

export interface TouchState {
  touching: boolean;
  /** How many frames in a row have disagreed with `touching`. */
  streak: number;
}

/** The gap above which a touch ends. It is higher than the one where a touch starts, so the state does not flicker at the edge. */
export const releaseGap = (touchBelow: number) => touchBelow * 1.5 + 0.05;

/**
 * Update the touching state with one frame's gap. A touch starts when the gap is
 * below `touchBelow` and ends when it is above `releaseGap(touchBelow)` or the
 * shadow is gone. Either change needs FRAMES_TO_SWITCH frames in a row.
 */
export function stepTouch(state: TouchState, gap: number | null, touchBelow: number): TouchState {
  const frameSaysTouching = state.touching
    ? gap !== null && gap <= releaseGap(touchBelow)
    : gap !== null && gap < touchBelow;

  if (frameSaysTouching === state.touching) return { touching: state.touching, streak: 0 };
  const streak = state.streak + 1;
  return streak >= FRAMES_TO_SWITCH
    ? { touching: frameSaysTouching, streak: 0 }
    : { touching: state.touching, streak };
}
