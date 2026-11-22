// The capped pen: pressing the whiteboard's buttons with a whiteboard marker that has
// its blue cap on, instead of a finger. The pen is straight and has one tip, and the
// projector throws its shadow on the board. Seen by the camera, the cap and its
// shadow make a "V": they meet at the tip when the pen touches the board, and come
// apart as it lifts (the shadow of a tip 1 cm up lands roughly that far away,
// depending on the angle of the light). So touch is read from the gap between the
// tip of the cap and the tip of its shadow, in cap widths, so that it means the
// same near the camera and far from it.
//
// The cap is found by its color: it is clearly bluer than the empty board at the same
// spot. Not blue by a fixed amount: through a real camera the "gray" board can look
// lavender, as blue as a pale cap, and the projected panel has blue buttons. A shadow
// (lit only by the room) and skin are less blue than the board. The cap is found
// roughly in the shrunk picture, then measured in a small piece of the full-size
// picture around it, where a few pixels are a few millimeters. Unlike a fingertip,
// nothing has to be guessed by a hand model: the tip is the end of the blue.
// Plain functions on pixel data, no React, no canvas.

import { labelBlobs } from "./blobs";
import { luminance } from "./luma";
import {
  isSkin,
  MIN_BOARD_LUMA,
  type Pixels,
  type Point,
  type Reference,
  type SkinModel,
} from "./shadowTouch";

/** A pixel is the cap's blue when blue's share of red + green + blue is at least this much above the empty board's there. */
export const DEFAULT_BLUE_GAIN = 0.08;
/** The pen touches when the gap between its tip and its shadow is below this many cap widths. */
export const DEFAULT_PEN_TOUCH_BELOW = 0.3;

const MIN_COLOR_SUM = 45; // r + g + b below this is too dark to tell its color
const MIN_BLUE_SHARE = 0.4; // nothing less blue than this is the cap, whatever the board looks like
// Over something that is already strongly blue on the empty board (a blue button), the cap is lit blue
// too and is no bluer than it, but it is darker: blue at least this share on the board, the cap within
// SAME_BLUE of its blue and darker than DARKER_THAN_BOARD of its brightness.
const BLUE_BOARD = 0.5;
const SAME_BLUE = 0.05;
const DARKER_THAN_BOARD = 0.8;
const EDGE_SPREAD = 2; // pixels of the shrunk picture (see capBoard)
const GROW_MIN_SUM = 18; // the cap's shaded side may be this dark and still be taken in from its lit side
const MAX_GROW_TOLERANCE = 0.08; // how far from the cap's own color its shaded side may be
const MIN_SPOT_AREA = 6; // pixels of blue in the shrunk picture
const MIN_CAP_PIXELS = 30; // pixels of blue in the full-size picture
const TIP_REGION = 1.5; // the last this many cap widths of the cap count as its tip
const SEARCH_RADIUS = 3; // shadow is looked for within this many cap widths of the tip
const MIN_SEARCH_RADIUS = 24; // pixels
const EDGE = 2; // pixels around the cap set aside: its edge blends into the board and looks dark
const MIN_SHADOW_PIXELS = 12;
const NEAREST = 6; // the shadow's end is where its 6th pixel from the end is, so a few stray ones do not move it
const END_DEPTH = 0.25; // cap widths: the shadow's end is this deep, for telling whether it is against the cap
const BRIGHTER = 1.2; // the pen's barrel and the hand behind the cap are brighter than the board by this much

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the cap roughly is in the shrunk picture. */
export interface CapSpot extends Box {
  /** Its middle. */
  x: number;
  y: number;
  /** How many pixels of blue. */
  area: number;
}

/** Blue's share of red + green + blue at every pixel (a third where it is too dark to tell). */
export function blueShareOf(colors: Pixels): Float32Array {
  const { data } = colors;
  const out = new Float32Array(colors.width * colors.height);
  for (let i = 0; i < out.length; i++) {
    const sum = data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2];
    out[i] = sum < MIN_COLOR_SUM ? 1 / 3 : data[i * 4 + 2] / sum;
  }
  return out;
}

/**
 * Is this pixel the cap? It is blue, and bluer than the empty board there by
 * `blueGain` (or, over something already strongly blue, as blue but darker).
 * `boardBlue` and `boardLevel` are the empty board's blue share and brightness at
 * the pixel, the brightness corrected for the camera's exposure.
 */
export function isCapColor(
  r: number,
  g: number,
  b: number,
  boardBlue: number,
  boardLevel: number,
  blueGain: number,
): boolean {
  const sum = r + g + b;
  if (sum < MIN_COLOR_SUM || b < r || b < g) return false;
  const share = b / sum;
  if (share < MIN_BLUE_SHARE) return false;
  if (share >= boardBlue + blueGain) return true;
  return boardBlue >= BLUE_BOARD && share >= boardBlue - SAME_BLUE && luminance(r, g, b) < boardLevel * DARKER_THAN_BOARD;
}

/**
 * The empty board as the cap is told from it, the size of the shrunk picture: at
 * every pixel the bluest blue share and the darkest brightness within a couple of
 * pixels (see capBoard).
 */
export interface BoardColors {
  luma: Float32Array;
  blue: Float32Array;
  width: number;
  height: number;
}

/** Each pixel's largest (or smallest) value within `radius` pixels, in a square. */
function spread(values: Float32Array, width: number, height: number, radius: number, largest: boolean): Float32Array {
  const pick = largest ? Math.max : Math.min;
  const across = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let best = values[y * width + x];
      for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) best = pick(best, values[y * width + xx]);
      across[y * width + x] = best;
    }
  }
  const out = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let best = across[y * width + x];
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) best = pick(best, across[yy * width + x]);
      out[y * width + x] = best;
    }
  }
  return out;
}

/**
 * The empty board for telling the cap from it: at every pixel, the bluest blue share
 * and the darkest brightness within EDGE_SPREAD pixels. At the edge of something blue
 * on the projected panel (a blue button, the white writing on it) the camera's blur,
 * a tiny shake and its compression leave pixels a little bluer, or darker, than the
 * empty board at exactly that spot; enough of them looked like a cap. The cap has to
 * beat the bluest and darkest board nearby instead.
 */
export function capBoard(reference: Reference, blue: Float32Array): BoardColors {
  const { width, height } = reference;
  return {
    luma: spread(reference.luma, width, height, EDGE_SPREAD, false),
    blue: spread(blue, width, height, EDGE_SPREAD, true),
    width,
    height,
  };
}

/** Grow the set pixels of a mask by `radius` pixels in every direction (a square). */
export function growMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const across = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) across[y * width + xx] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!across[y * width + x]) continue;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) out[yy * width + x] = 1;
    }
  }
  return out;
}

/**
 * Find the cap roughly, in the shrunk picture: the biggest patch of pixels bluer
 * than the empty board (`board`, the same size, with `gains` the exposure of each
 * row). Only blue inside `allowed` counts when it is given (1 where the cap may be: the
 * whiteboard window and a little around it, so blue clothes at the side of the
 * picture are ignored), and only blue inside `regions` when they are given (around
 * the hands).
 */
export function findCap(
  colors: Pixels,
  board: BoardColors,
  gains: Float32Array | null,
  blueGain: number,
  regions: Box[] | null,
  allowed: Uint8Array | null,
): CapSpot | null {
  const { width, height, data } = colors;
  if (board.width !== width || board.height !== height) return null;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const gain = gains ? gains[y] : 1;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (allowed && allowed.length === mask.length && !allowed[i]) continue;
      if (!isCapColor(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], board.blue[i], board.luma[i] * gain, blueGain)) continue;
      if (regions && !regions.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) continue;
      mask[i] = 1;
    }
  }

  const { label, area } = labelBlobs(mask, width, height);
  let best = 0;
  for (let id = 1; id < area.length; id++) {
    if (area[id] >= MIN_SPOT_AREA && (best === 0 || area[id] > area[best])) best = id;
  }
  if (best === 0) return null;

  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < label.length; i++) {
    if (label[i] !== best) continue;
    const x = i % width;
    const y = (i - x) / width;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    sumX += x;
    sumY += y;
  }
  return { x: sumX / area[best], y: sumY / area[best], area: area[best], left, top, right, bottom };
}

/**
 * Where in the shrunk picture the cap may be: 1 for every pixel that `toWindow`
 * (picture, 0 to 1 across it, to the whiteboard window, 0 to 1 across it) puts
 * inside the window or within `margin` of it.
 */
export function windowArea(
  width: number,
  height: number,
  toWindow: (p: Point) => Point,
  margin: number,
): Uint8Array {
  const area = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = toWindow({ x: (x + 0.5) / width, y: (y + 0.5) / height });
      if (p.x >= -margin && p.x <= 1 + margin && p.y >= -margin && p.y <= 1 + margin) area[y * width + x] = 1;
    }
  }
  return area;
}

/** A value of a picture-sized array at a point (pixels, may fall between them). */
export function valueAt(values: Float32Array, width: number, height: number, x: number, y: number): number {
  const fx = Math.max(0, Math.min(width - 1, x));
  const fy = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (xx: number, yy: number) => values[yy * width + xx];
  return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}

/** The empty board's brightness at a point of its picture (pixels, may fall between them). */
export function referenceAt(ref: Reference, x: number, y: number): number {
  return valueAt(ref.luma, ref.width, ref.height, x, y);
}

/**
 * How much brighter or darker the picture is than the empty board (1 is the same):
 * cameras change their exposure on their own. The middle value over the whole
 * picture is used, so the pen, the hand and their shadow, which cover little of it,
 * do not pull it.
 */
export function boardGain(frame: Float32Array, ref: Reference): number {
  const ratios: number[] = [];
  for (let y = 4; y < ref.height; y += 8) {
    for (let x = 4; x < ref.width; x += 8) {
      const i = y * ref.width + x;
      if (ref.luma[i] < MIN_BOARD_LUMA) continue;
      ratios.push(frame[i] / ref.luma[i]);
    }
  }
  if (ratios.length < 50) return 1;
  ratios.sort((a, b) => a - b);
  return ratios[ratios.length >> 1];
}

export interface PenInput {
  /** A piece of the full-size picture around the cap. */
  crop: Pixels;
  /** Where the piece is in the full-size picture. */
  left: number;
  top: number;
  /** The empty board's brightness at a pixel of the full-size picture, already corrected for the camera's exposure. */
  boardAt: (x: number, y: number) => number;
  /**
   * The empty board as the cap is told from it (see capBoard), at a pixel of the
   * full-size picture: the bluest blue share nearby, and the darkest brightness
   * nearby, corrected for the camera's exposure.
   */
  capBlueAt: (x: number, y: number) => number;
  capLevelAt: (x: number, y: number) => number;
  /** How much bluer than the empty board the cap is at least (see isCapColor). */
  blueGain: number;
  /** A pixel is shadow when it is darker than this share of the empty board. */
  shadowRatio: number;
  /** The middle of the hand holding the pen, in the full-size picture, if it is seen: the tip is the end away from it. */
  palm: Point | null;
  /** The tip in the last frame, in the full-size picture: the tip stays the end near it. */
  previousTip: Point | null;
  /** The skin's color, to keep the fingers holding the pen from being taken for shadow. */
  skin: SkinModel | null;
  skinTolerance: number;
  /** RGBA pixels the size of the crop: the cap is painted blue in it, the shadow cyan and dark skin orange. */
  paint?: Uint8ClampedArray;
}

export interface PenReading {
  /** The tip of the cap, in the full-size picture. */
  tip: Point;
  /** The other end of the blue that is seen. */
  back: Point;
  /** How wide and how long the cap looks, in pixels. */
  width: number;
  length: number;
  /**
   * The gap between the tip of the cap and the tip of its shadow, in cap widths:
   * about 0 when the pen touches the board, larger the higher it is. Null when there
   * is no shadow near the tip (the pen is far from the board, or its shadow is out of view).
   */
  gap: number | null;
  /**
   * The tip of the cap's shadow, and the far end of the part of it that was looked
   * at, in the full-size picture. When the shadow's tip is hidden under the cap,
   * `shadowTip` is the point of the shadow's line nearest the tip of the cap.
   */
  shadowTip: Point | null;
  shadowEnd: Point | null;
  /** Does the shadow go on under the cap, with its tip hidden? */
  shadowHidden: boolean;
  /** How far around the tip shadow was looked for, in pixels. */
  searchRadius: number;
  capPixels: number;
  shadowPixels: number;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

/** Find the cap, its tip, and the gap between the tip and its shadow, in a piece of the full-size picture. */
export function readPen(input: PenInput): PenReading | null {
  const { crop, left, top, boardAt, paint } = input;
  const { width, height, data } = crop;
  const count = width * height;

  // 1. The cap's core: the biggest patch of pixels clearly bluer than the empty board.
  const core = new Uint8Array(count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const level = input.capLevelAt(x + left, y + top);
      const blue = input.capBlueAt(x + left, y + top);
      if (isCapColor(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], blue, level, input.blueGain)) core[i] = 1;
    }
  }
  const labels = labelBlobs(core, width, height);
  let best = 0;
  for (let id = 1; id < labels.area.length; id++) {
    if (best === 0 || labels.area[id] > labels.area[best]) best = id;
  }
  if (best === 0 || labels.area[best] < MIN_CAP_PIXELS) return null;

  // 2. The cap's own color, without its brightness.
  const reds: number[] = [];
  const greens: number[] = [];
  for (let i = 0; i < count; i++) {
    if (labels.label[i] !== best) continue;
    const sum = data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2];
    reds.push(data[i * 4] / sum);
    greens.push(data[i * 4 + 1] / sum);
  }
  const capRed = median(reds);
  const capGreen = median(greens);
  // Its shaded side has the same color, only darker. Take in pixels up to halfway to plain gray.
  const tolerance = Math.min(MAX_GROW_TOLERANCE, 0.5 * Math.hypot(capRed - 1 / 3, capGreen - 1 / 3));

  // 3. Grow from the core into the pixels of the same color next to it, however dark.
  const cap = new Uint8Array(count);
  const stack = new Int32Array(count);
  let stackTop = 0;
  for (let i = 0; i < count; i++) {
    if (labels.label[i] === best) {
      cap[i] = 1;
      stack[stackTop++] = i;
    }
  }
  const sameColor = (i: number) => {
    if (core[i]) return true;
    const sum = data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2];
    if (sum < GROW_MIN_SUM) return false;
    return Math.hypot(data[i * 4] / sum - capRed, data[i * 4 + 1] / sum - capGreen) <= tolerance;
  };
  while (stackTop > 0) {
    const i = stack[--stackTop];
    const x = i % width;
    const y = (i - x) / width;
    const neighbors = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
    for (const j of neighbors) {
      if (j >= 0 && !cap[j] && sameColor(j)) {
        cap[j] = 1;
        stack[stackTop++] = j;
      }
    }
  }

  // 4. Its axis (the direction it is most spread along), its width, and its two ends.
  let capPixels = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < count; i++) {
    if (!cap[i]) continue;
    const x = i % width;
    sumX += x;
    sumY += (i - x) / width;
    capPixels++;
  }
  const middle = { x: sumX / capPixels, y: sumY / capPixels };
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (let i = 0; i < count; i++) {
    if (!cap[i]) continue;
    const x = i % width;
    const dx = x - middle.x;
    const dy = (i - x) / width - middle.y;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  xx /= capPixels;
  xy /= capPixels;
  yy /= capPixels;
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const across = (xx + yy) / 2 - Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy);
  // A bar of width w spreads w² / 12 across.
  const capWidth = Math.max(2, Math.sqrt(12 * Math.max(0, across)));

  const along = new Float32Array(capPixels);
  for (let i = 0, k = 0; i < count; i++) {
    if (!cap[i]) continue;
    const x = i % width;
    along[k++] = (x - middle.x) * axis.x + ((i - x) / width - middle.y) * axis.y;
  }
  along.sort();
  // The ends, leaving out a few stray pixels.
  const low = along[Math.floor(0.02 * (capPixels - 1))];
  const high = along[Math.ceil(0.98 * (capPixels - 1))];
  const endLow = { x: middle.x + axis.x * low, y: middle.y + axis.y * low };
  const endHigh = { x: middle.x + axis.x * high, y: middle.y + axis.y * high };

  // 5. Which end is the tip: the one away from the hand, else the one where the tip was, else the one
  // with less of the bright barrel and hand beyond it.
  const inCrop = (p: Point | null) => (p ? { x: p.x - left, y: p.y - top } : null);
  const palm = inCrop(input.palm);
  const previous = inCrop(input.previousTip);
  let tipIsHigh: boolean;
  if (palm) {
    tipIsHigh = distance(endHigh, palm) >= distance(endLow, palm);
  } else if (previous && Math.min(distance(endHigh, previous), distance(endLow, previous)) < 3 * capWidth) {
    tipIsHigh = distance(endHigh, previous) <= distance(endLow, previous);
  } else {
    const brightBeyond = (end: Point, sign: number) => {
      const centre = { x: end.x + sign * axis.x * capWidth, y: end.y + sign * axis.y * capWidth };
      let bright = 0;
      for (let y = Math.max(0, Math.floor(centre.y - capWidth)); y <= Math.min(height - 1, centre.y + capWidth); y++) {
        for (let x = Math.max(0, Math.floor(centre.x - capWidth)); x <= Math.min(width - 1, centre.x + capWidth); x++) {
          const i = y * width + x;
          if (cap[i] || Math.hypot(x - centre.x, y - centre.y) > capWidth) continue;
          const level = luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
          if (level > boardAt(x + left, y + top) * BRIGHTER) bright++;
        }
      }
      return bright;
    };
    tipIsHigh = brightBeyond(endHigh, 1) <= brightBeyond(endLow, -1);
  }
  const tip = tipIsHigh ? endHigh : endLow;
  const back = tipIsHigh ? endLow : endHigh;
  const toTip = tipIsHigh ? axis : { x: -axis.x, y: -axis.y };

  // 6. The shadow near the tip: pixels clearly darker than the empty board, that are not the cap
  // (nor its edge, which blends into the board) and not skin.
  const nearCap = growMask(cap, width, height, EDGE);
  const searchRadius = Math.max(MIN_SEARCH_RADIUS, SEARCH_RADIUS * capWidth);
  const fromX = Math.max(0, Math.floor(tip.x - searchRadius));
  const toX = Math.min(width - 1, Math.ceil(tip.x + searchRadius));
  const fromY = Math.max(0, Math.floor(tip.y - searchRadius));
  const toY = Math.min(height - 1, Math.ceil(tip.y + searchRadius));
  const dark = new Uint8Array(count);
  const setPaint = (i: number, red: number, green: number, blue: number, alpha: number) => {
    if (!paint) return;
    paint[i * 4] = red;
    paint[i * 4 + 1] = green;
    paint[i * 4 + 2] = blue;
    paint[i * 4 + 3] = alpha;
  };
  for (let y = fromY; y <= toY; y++) {
    for (let x = fromX; x <= toX; x++) {
      const i = y * width + x;
      if (nearCap[i] || Math.hypot(x - tip.x, y - tip.y) > searchRadius) continue;
      const board = boardAt(x + left, y + top);
      if (board < MIN_BOARD_LUMA) continue;
      if (luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) / board >= input.shadowRatio) continue;
      if (input.skin && isSkin(crop, i, input.skin, input.skinTolerance)) {
        setPaint(i, 251, 146, 60, 170);
        continue;
      }
      dark[i] = 1;
    }
  }

  // 7. Keep only shadow pixels with at least three dark neighbors, so noise does not count, and find
  // the one nearest the tip's part of the cap (its last cap widths, as a rounded bar ending at the tip).
  const barEnd = { x: tip.x - toTip.x * capWidth * 0.5, y: tip.y - toTip.y * capWidth * 0.5 };
  const barStart = { x: barEnd.x - toTip.x * capWidth * TIP_REGION, y: barEnd.y - toTip.y * capWidth * TIP_REGION };
  const shadow = new Uint8Array(count);
  let shadowPixels = 0;
  let nearestIndex = -1;
  let nearestDistance = Infinity;
  for (let y = fromY; y <= toY; y++) {
    for (let x = fromX; x <= toX; x++) {
      const i = y * width + x;
      if (!dark[i]) continue;
      const neighbors =
        (x > 0 ? dark[i - 1] : 0) +
        (x < width - 1 ? dark[i + 1] : 0) +
        (y > 0 ? dark[i - width] : 0) +
        (y < height - 1 ? dark[i + width] : 0);
      if (neighbors < 3) continue;
      shadow[i] = 1;
      shadowPixels++;
      setPaint(i, 34, 211, 238, 190);
      const d = distanceToSegment({ x, y }, barStart, barEnd);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearestIndex = i;
      }
    }
  }
  if (paint) {
    for (let i = 0; i < count; i++) if (cap[i]) setPaint(i, 59, 130, 246, 150);
  }

  const reading: PenReading = {
    tip: { x: tip.x + left, y: tip.y + top },
    back: { x: back.x + left, y: back.y + top },
    width: capWidth,
    length: high - low,
    gap: null,
    shadowTip: null,
    shadowEnd: null,
    shadowHidden: false,
    searchRadius,
    capPixels,
    shadowPixels,
  };
  if (nearestIndex < 0) return reading;

  // 8. The cap's shadow: the patch of shadow that comes nearest the tip. It is a band like the cap
  // itself, and its tip is the shadow of the cap's tip: find the band's line (the direction it is most
  // spread along) and where it ends on the side of the tip. Its end is measured along that line, so a
  // band whose end is partly hidden behind the cap still ends in the right place as long as a corner
  // of it shows. (The distance from the cap to the nearest shadow pixel does not work: both are a cap
  // width wide, and the edges of the two bands stay close long after their tips have come apart.)
  const band: number[] = [];
  stackTop = 0;
  stack[stackTop++] = nearestIndex;
  shadow[nearestIndex] = 2;
  while (stackTop > 0) {
    const i = stack[--stackTop];
    band.push(i);
    const x = i % width;
    const y = (i - x) / width;
    const neighbors = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
    for (const j of neighbors) {
      if (j >= 0 && shadow[j] === 1) {
        shadow[j] = 2;
        stack[stackTop++] = j;
      }
    }
  }
  if (band.length < MIN_SHADOW_PIXELS) return reading;

  let bandX = 0;
  let bandY = 0;
  for (const i of band) {
    const x = i % width;
    bandX += x;
    bandY += (i - x) / width;
  }
  bandX /= band.length;
  bandY /= band.length;
  let bxx = 0;
  let bxy = 0;
  let byy = 0;
  for (const i of band) {
    const x = i % width;
    const dx = x - bandX;
    const dy = (i - x) / width - bandY;
    bxx += dx * dx;
    bxy += dx * dy;
    byy += dy * dy;
  }
  const bandAngle = 0.5 * Math.atan2(2 * bxy, bxx - byy);
  let bandAxis = { x: Math.cos(bandAngle), y: Math.sin(bandAngle) };
  // Point the line away from the tip, so the band's end on the tip's side is its lowest point along it.
  if ((tip.x - bandX) * bandAxis.x + (tip.y - bandY) * bandAxis.y > 0) bandAxis = { x: -bandAxis.x, y: -bandAxis.y };

  // Where each pixel of the band is: along its line (away from the tip) and across it.
  const bandNormal = { x: -bandAxis.y, y: bandAxis.x };
  const bandAlong = new Float32Array(band.length);
  const bandAcross = new Float32Array(band.length);
  const againstCap = new Uint8Array(band.length);
  const isAgainstCap = (i: number) => {
    const x = i % width;
    const y = (i - x) / width;
    return (
      (x > 0 && nearCap[i - 1] === 1) ||
      (x < width - 1 && nearCap[i + 1] === 1) ||
      (y > 0 && nearCap[i - width] === 1) ||
      (y < height - 1 && nearCap[i + width] === 1)
    );
  };
  band.forEach((i, k) => {
    const x = i % width;
    const dx = x - bandX;
    const dy = (i - x) / width - bandY;
    bandAlong[k] = dx * bandAxis.x + dy * bandAxis.y;
    bandAcross[k] = dx * bandNormal.x + dy * bandNormal.y;
    againstCap[k] = isAgainstCap(i) ? 1 : 0;
  });
  const sorted = bandAlong.slice().sort();
  const start = sorted[Math.min(NEAREST, band.length) - 1];
  const end = sorted[band.length - 1];

  // The band's middle line. Near the cap only its outer side may show (the cap hides the inner side), so
  // the middle of what shows is off to the outside there. So the band is cut into slices across: where a
  // slice shows both edges its middle is between them, and where the cap cuts its inner edge its middle
  // is half the band's width in from the outer edge. The band's width is taken where it shows whole.
  const capSide = Math.sign((middle.x - bandX) * bandNormal.x + (middle.y - bandY) * bandNormal.y) || 1;
  const sliceSize = Math.max(2, Math.round(capWidth / 4));
  const slices = new Map<number, { min: number; max: number; minAgainst: boolean; maxAgainst: boolean; clipped: boolean }>();
  band.forEach((i, k) => {
    const key = Math.floor(bandAlong[k] / sliceSize);
    const x = i % width;
    const clipped = Math.hypot(x - tip.x, (i - x) / width - tip.y) > searchRadius - 1.5;
    const across = bandAcross[k];
    const slice = slices.get(key);
    if (!slice) {
      slices.set(key, { min: across, max: across, minAgainst: againstCap[k] === 1, maxAgainst: againstCap[k] === 1, clipped });
      return;
    }
    if (across < slice.min) {
      slice.min = across;
      slice.minAgainst = againstCap[k] === 1;
    }
    if (across > slice.max) {
      slice.max = across;
      slice.maxAgainst = againstCap[k] === 1;
    }
    slice.clipped ||= clipped;
  });
  const whole: number[] = [];
  for (const slice of slices.values()) {
    if (!slice.clipped && !slice.minAgainst && !slice.maxAgainst) whole.push(slice.max - slice.min + 1);
  }
  const bandWidth = whole.length >= 2 ? median(whole) : capWidth;
  // Least squares: across = a + b * along, through the middles of the slices.
  let n = 0;
  let sumT = 0;
  let sumL = 0;
  let sumTT = 0;
  let sumTL = 0;
  for (const [key, slice] of slices) {
    if (slice.clipped) continue;
    const innerAgainst = capSide > 0 ? slice.maxAgainst : slice.minAgainst;
    const outerAgainst = capSide > 0 ? slice.minAgainst : slice.maxAgainst;
    if (outerAgainst) continue;
    const outer = capSide > 0 ? slice.min : slice.max;
    const centre = innerAgainst ? outer + capSide * (bandWidth - 1) / 2 : (slice.min + slice.max) / 2;
    const t = (key + 0.5) * sliceSize;
    n++;
    sumT += t;
    sumL += centre;
    sumTT += t * t;
    sumTL += t * centre;
  }
  const spread = n * sumTT - sumT * sumT;
  const slope = n >= 2 && spread > 1e-6 ? (n * sumTL - sumT * sumL) / spread : 0;
  const offset = n >= 1 ? (sumL - slope * sumT) / n : 0;
  const onLine = (t: number) => {
    const across = offset + slope * t;
    return { x: bandX + bandAxis.x * t + bandNormal.x * across, y: bandY + bandAxis.y * t + bandNormal.y * across };
  };
  let shadowTip = onLine(start);
  const shadowEnd = onLine(end);

  // 9. Is the band's end against the cap? Then the shadow goes on under the cap and its tip is hidden
  // (in a narrow V the cap covers it when touching). Lifting the pen moves its shadow away from the
  // cap, out from under it, so a hidden tip is at the V's point or close to it: the gap is then how far
  // the shadow's line passes from the tip of the cap. Otherwise it is the distance between the two tips.
  const endDepth = Math.max(2, END_DEPTH * capWidth);
  let hidden = false;
  for (let k = 0; k < band.length && !hidden; k++) {
    hidden = bandAlong[k] <= start + endDepth && againstCap[k] === 1;
  }
  let gapPixels = distance(tip, shadowTip);
  if (hidden) {
    // The point of the shadow's middle line nearest the tip of the cap.
    const tipAlong = (tip.x - bandX) * bandAxis.x + (tip.y - bandY) * bandAxis.y;
    const tipAcross = (tip.x - bandX) * bandNormal.x + (tip.y - bandY) * bandNormal.y;
    const t = tipAlong + (slope * (tipAcross - offset - slope * tipAlong)) / (1 + slope * slope);
    const foot = onLine(t);
    if (distance(tip, foot) < gapPixels) {
      gapPixels = distance(tip, foot);
      shadowTip = foot;
    }
  }

  reading.gap = gapPixels / capWidth;
  reading.shadowHidden = hidden;
  reading.shadowTip = { x: shadowTip.x + left, y: shadowTip.y + top };
  reading.shadowEnd = { x: shadowEnd.x + left, y: shadowEnd.y + top };
  return reading;
}
