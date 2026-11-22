// Shadow touch: telling when a fingertip touches the board from the finger's shadow
// (docs/02-technical-design.md, section 4). The projector lights the board, so the
// hand casts a shadow on it. A fingertip high above the board has its shadow
// ahead of it, and as the finger comes down the shadow tip slides back under it.
// At contact the finger hides its own shadow: the shadow stops at the fingertip
// or behind it.
//
// Method: compare the camera picture with a picture of the empty board (the
// reference). Pixels that are clearly darker than before, and not part of the
// hand, are shadow. Then see how far the shadow reaches ahead of the fingertip
// along the finger, in a box laid along it. That is the gap, in hand sizes so
// that it means the same near and far: 0 when the shadow stops at or behind the
// fingertip (touching), and larger the higher the finger is. (Measuring the
// distance to the shadow's far tip, or to the nearest shadow, does not work: when
// the finger touches, its own shadow is hidden and what is left is a bump of the
// hand's shadow at the knuckle, far behind the fingertip, which looks like a tip.)
// Plain functions on pixel data, no React, no canvas.

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
 * Where to look for the fingertip's shadow: a box laid along the finger, this many
 * hand sizes behind the fingertip, ahead of it, and to either side. It reaches
 * back far enough to take in the hand's own shadow, so that "there is a shadow
 * around the hand, but none past the fingertip" can be told from "no shadow at
 * all". The shadow of the arm mostly lies outside its sides.
 */
export const BAND_BEHIND = 1.6;
export const BAND_AHEAD = 2.4;
export const BAND_SIDE = 1.2;

/** A touch starts and ends only after this many frames in a row agree, so one bad frame cannot break a line. */
export const FRAMES_TO_SWITCH = 2;

const SEARCH_STEP = 2; // look at every second pixel: plenty for shadows, and four times faster
const TIP_DEPTH = 0.06; // the shadow tip is the average of the shadow within this many hand sizes of its farthest point
// The shadow reaches this far ahead only where at least this many shadow pixels do, so a few strays do not count.
const MIN_TIP_PIXELS = 6;
// Fewer shadow pixels than this in the box is not a shadow, just specks along the edge of the hand.
const MIN_SHADOW_CELLS = 10;
// A shadow that ends at or behind the fingertip only means touching if it lies against the hand, within this many hand sizes.
const ADJACENT = 0.3;

// How thick the parts of the hand are, in hand sizes, for hiding the hand from the shadow search.
const FINGER_RADIUS = 0.08; // the core of a finger: the rest of its width is told apart by skin color
const PALM_RADIUS = 0.15;
const FOREARM_RADIUS = 0.45;
const FOREARM_LENGTH = 3;

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

/** A thick line: the part of the picture within `radius` of the segment from `a` to `b`. */
export interface Capsule {
  a: Point;
  b: Point;
  radius: number;
}

/**
 * The part of the picture taken up by a hand, as thick lines along the fingers
 * and the forearm plus the palm. (One convex shape around the whole hand would
 * also cover the lit board between the fingers, and with it any shadow there.)
 */
export interface HandShape {
  capsules: Capsule[];
  /** The palm: the smallest convex shape around the wrist and the knuckles. */
  palm: Point[];
  /** The size of the hand in pixels (palm width or palm length, whichever is larger). */
  scale: number;
}

// The landmarks along each finger, from the base out to the tip (the thumb first).
const FINGER_CHAINS = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];

/**
 * The shape of a hand from its 21 landmarks, in pixels. The forearm is included
 * because it is as dark as the hand and must not be taken for shadow.
 */
export function handShape(points: Point[]): HandShape {
  const wrist = points[0];
  const middleKnuckle = points[9];
  const scale = Math.max(distance(points[5], points[17]), distance(wrist, middleKnuckle));

  const capsules: Capsule[] = [];
  for (const chain of FINGER_CHAINS) {
    for (let i = 0; i < chain.length - 1; i++) {
      capsules.push({ a: points[chain[i]], b: points[chain[i + 1]], radius: FINGER_RADIUS * scale });
    }
  }
  // The forearm continues from the wrist away from the knuckles.
  capsules.push({
    a: wrist,
    b: {
      x: wrist.x + (wrist.x - middleKnuckle.x) * FOREARM_LENGTH,
      y: wrist.y + (wrist.y - middleKnuckle.y) * FOREARM_LENGTH,
    },
    radius: FOREARM_RADIUS * scale,
  });

  const palm = convexHull([wrist, points[1], points[5], points[9], points[13], points[17]]);
  return { capsules, palm, scale };
}

/** How far a point is outside a convex shape (0 inside it). */
function distanceToConvex(p: Point, shape: Point[]): number {
  let inside = true;
  let nearest = Infinity;
  for (let i = 0; i < shape.length; i++) {
    const a = shape[i];
    const b = shape[(i + 1) % shape.length];
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < 0) inside = false;
    nearest = Math.min(nearest, distanceToSegment(p, a, b));
  }
  return inside ? 0 : nearest;
}

/** How far a point is outside the hand's shape (0 inside it). */
export function distanceToHand(p: Point, hand: HandShape): number {
  let nearest = distanceToConvex(p, hand.palm) - PALM_RADIUS * hand.scale;
  for (const { a, b, radius } of hand.capsules) {
    nearest = Math.min(nearest, distanceToSegment(p, a, b) - radius);
  }
  return Math.max(0, nearest);
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

/**
 * What the skin looks like: its color without its brightness (the share of red and
 * of green in red + green + blue). Skin is warmer and more colorful than the shadow
 * of a gray or white board, which has only the color of the room's light. That tells
 * the hand's edge from the shadow next to it, to the pixel, where the landmarks
 * alone are good to a few pixels.
 */
export interface SkinModel {
  r: number;
  g: number;
}

const MIN_COLOR_SUM = 60; // darker than this, a pixel's color is mostly noise

function colorAt(colors: Pixels, x: number, y: number, radius: number): [number, number, number] | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let yy = Math.max(0, y - radius); yy <= Math.min(colors.height - 1, y + radius); yy++) {
    for (let xx = Math.max(0, x - radius); xx <= Math.min(colors.width - 1, x + radius); xx++) {
      const i = (yy * colors.width + xx) * 4;
      r += colors.data[i];
      g += colors.data[i + 1];
      b += colors.data[i + 2];
      count++;
    }
  }
  return count === 0 ? null : [r / count, g / count, b / count];
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

/**
 * The skin color of a hand, taken from the picture along its index finger (the
 * landmarks from the knuckle to the tip). The middle value is used, so a few
 * samples that miss the finger do not matter. Null if it cannot be told.
 */
export function skinModelFrom(colors: Pixels, hand: Point[]): SkinModel | null {
  const samples: [number, number, number][] = [];
  for (const [from, to] of [
    [5, 6],
    [6, 7],
    [7, 8],
  ]) {
    for (let k = 0; k < 8; k++) {
      const t = (k + 0.5) / 8;
      const color = colorAt(
        colors,
        Math.round(hand[from].x + (hand[to].x - hand[from].x) * t),
        Math.round(hand[from].y + (hand[to].y - hand[from].y) * t),
        1,
      );
      if (color) samples.push(color);
    }
  }
  if (samples.length < 8) return null;

  const r = median(samples.map((c) => c[0]));
  const g = median(samples.map((c) => c[1]));
  const b = median(samples.map((c) => c[2]));
  const sum = r + g + b;
  return sum < MIN_COLOR_SUM ? null : { r: r / sum, g: g / sum };
}

/** Is this pixel the color of skin? A tolerance of 0 says no to everything (the skin test is off). */
function isSkin(colors: Pixels, index: number, skin: SkinModel, tolerance: number): boolean {
  if (tolerance <= 0) return false;
  const r = colors.data[index * 4];
  const g = colors.data[index * 4 + 1];
  const b = colors.data[index * 4 + 2];
  const sum = r + g + b;
  if (sum < MIN_COLOR_SUM) return false;
  return Math.hypot(r / sum - skin.r, g / sum - skin.g) <= tolerance;
}

export interface ShadowParams {
  /** A pixel is shadow when it is darker than this share of the empty board (0 to 1). */
  shadowRatio: number;
  /** How far past the hand's outline to stay clear of, in hand sizes, so skin is not taken for shadow. */
  handMargin: number;
  /** How far a pixel's color may differ from the skin's and still count as skin (0 turns this off). */
  skinTolerance: number;
}

export interface ShadowReading {
  /**
   * How far the shadow reaches past the fingertip along the finger, in hand sizes.
   * 0 when the shadow stops at the fingertip or behind it and lies against the
   * hand, which is what touching looks like (the finger hides its own shadow).
   * Larger the higher the finger is, because the shadow's tip then shows up ahead
   * of the fingertip. Null when there is no shadow in the box along the finger, or
   * when the shadow there is not against the hand (a hand high above the board).
   */
  gap: number | null;
  /**
   * The far end of the shadow in the box, in pixels. When touching this is not the
   * fingertip's shadow but a bump of the hand's shadow behind the fingertip.
   */
  shadowTip: Point | null;
  /** How many pixels in the box along the finger are shadow. */
  shadowPixels: number;
  /** How many dark pixels in the box were set aside because they are the color of skin. */
  skinPixels: number;
  /** How much the picture's exposure has changed since the reference. */
  gain: number;
}

export interface ShadowInput {
  /** The brightness of the picture. */
  luma: Float32Array;
  /** The colors of the picture, the same size. */
  colors: Pixels;
  reference: Reference;
  /** The fingertip, in pixels. */
  tip: Point;
  /** The way the finger points (see fingerDirection). */
  direction: Point;
  hand: HandShape;
  /** The color of the skin, or null if it could not be told (then only the hand's shape is used). */
  skin: SkinModel | null;
  params: ShadowParams;
  /** RGBA pixels the same size as the picture: shadow found is painted cyan in it, and skin-colored dark pixels orange. */
  paint?: Uint8ClampedArray;
}

const noReading = (gain: number): ShadowReading => ({
  gap: null,
  shadowTip: null,
  shadowPixels: 0,
  skinPixels: 0,
  gain,
});

/** See how far the shadow reaches past a fingertip, and whether it lies against the hand. */
export function readShadow(input: ShadowInput): ShadowReading {
  const { luma: frame, colors, reference: ref, tip, direction, hand, skin, params, paint } = input;
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
  if (columns <= 0 || rows <= 0) return noReading(gain);

  // Where a pixel is in the box: how far ahead of the fingertip along the finger, and how far to the side.
  const alongOf = (x: number, y: number) => ((x - tip.x) * direction.x + (y - tip.y) * direction.y) / scale;
  const acrossOf = (x: number, y: number) => ((x - tip.x) * -direction.y + (y - tip.y) * direction.x) / scale;

  const paintBlock = (x: number, y: number, red: number, green: number, blue: number, alpha: number) => {
    if (!paint) return;
    for (let dy = 0; dy < SEARCH_STEP && y + dy < height; dy++) {
      for (let dx = 0; dx < SEARCH_STEP && x + dx < width; dx++) {
        const p = ((y + dy) * width + x + dx) * 4;
        paint[p] = red;
        paint[p + 1] = green;
        paint[p + 2] = blue;
        paint[p + 3] = alpha;
      }
    }
  };

  // First find the pixels in the box that are darker than the empty board, are not the hand, and are
  // not the color of skin. How far each is from the hand is kept, to see whether the shadow lies against it.
  const dark = new Uint8Array(columns * rows);
  const fromHand = new Float32Array(columns * rows);
  let skinPixels = 0;
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
      const away = distanceToHand({ x, y }, hand);
      if (away <= margin) continue;
      if (skin && isSkin(colors, i, skin, params.skinTolerance)) {
        skinPixels++;
        paintBlock(x, y, 251, 146, 60, 170);
        continue;
      }
      dark[row * columns + column] = 1;
      fromHand[row * columns + column] = away;
    }
  }

  // Then keep those with at least three dark neighbors, so single noisy pixels do not count.
  const kept: { x: number; y: number; along: number }[] = [];
  let nearestToHand = Infinity;
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
      nearestToHand = Math.min(nearestToHand, fromHand[row * columns + column]);
      paintBlock(x, y, 34, 211, 238, 190);
    }
  }
  // A few specks along the edge of the hand are not a shadow.
  if (kept.length < MIN_SHADOW_CELLS) return { ...noReading(gain), skinPixels };

  // Where the shadow reaches farthest ahead along the finger, ignoring a few stray pixels.
  const alongs = kept.map((pixel) => pixel.along).sort((a, b) => b - a);
  const farthest = alongs[Math.min(MIN_TIP_PIXELS, alongs.length) - 1];
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

  // A shadow that ends at or behind the fingertip counts as touching only if it lies against the hand
  // (the hand's own shadow). A shadow that is somewhere else, with the hand high above the board, does not.
  const againstHand = nearestToHand <= ADJACENT * scale;
  return {
    gap: farthest > 0 ? farthest : againstHand ? 0 : null,
    shadowTip,
    shadowPixels: kept.length * SEARCH_STEP * SEARCH_STEP,
    skinPixels,
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
