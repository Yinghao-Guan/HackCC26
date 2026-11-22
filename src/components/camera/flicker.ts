// Flicker bands: a camera filming a projector often shows dark bands across the
// picture that roll up or down. The projector's light flickers faster than the eye
// can see, and the camera reads its rows one after another, so some rows catch
// more of the light than others. Compared with the picture of the empty board, a
// band looks like a long shadow across the board, and it moves every frame.
//
// A band darkens a whole row, while a shadow covers only a small part of one. So
// each row gets its own exposure correction: the middle value, along the row, of
// how bright the picture is next to the empty board. That follows the bands and
// ignores the shadows. Plain functions, no React.

import { MIN_BOARD_LUMA, type Reference } from "./shadowTouch";

const STEP = 4; // look at every 4th pixel along a row: plenty for a middle value
const MIN_SAMPLES = 24; // a row with fewer lit board pixels than this takes its neighbors' value
const SMOOTH = 2; // rows on each side averaged in: bands are soft, noise is not

/**
 * How much brighter or darker each row of the picture is than the same row of the
 * empty board (1 is the same). `frame` is the picture's brightness, the size of the reference.
 */
export function rowGains(frame: Float32Array, ref: Reference): Float32Array {
  const { width, height, luma } = ref;
  const raw = new Float32Array(height).fill(Number.NaN);
  const ratios: number[] = [];
  for (let y = 0; y < height; y++) {
    ratios.length = 0;
    // Start each row at a different pixel, so the rows together see every column.
    for (let x = y % STEP; x < width; x += STEP) {
      const i = y * width + x;
      if (luma[i] < MIN_BOARD_LUMA) continue;
      ratios.push(frame[i] / luma[i]);
    }
    if (ratios.length < MIN_SAMPLES) continue;
    ratios.sort((a, b) => a - b);
    raw[y] = ratios[ratios.length >> 1];
  }

  // Rows that could not be measured (off the board) take the nearest row that could, or 1.
  let last = Number.NaN;
  for (let y = 0; y < height; y++) {
    if (Number.isNaN(raw[y])) raw[y] = last;
    else last = raw[y];
  }
  last = Number.NaN;
  for (let y = height - 1; y >= 0; y--) {
    if (Number.isNaN(raw[y])) raw[y] = last;
    else last = raw[y];
  }

  const gains = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let count = 0;
    for (let yy = Math.max(0, y - SMOOTH); yy <= Math.min(height - 1, y + SMOOTH); yy++) {
      if (Number.isNaN(raw[yy])) continue;
      sum += raw[yy];
      count++;
    }
    gains[y] = count > 0 && sum > 0 ? sum / count : 1;
  }
  return gains;
}

/** The gain at a row that may fall between two rows. */
export function gainAt(gains: Float32Array, y: number): number {
  const fy = Math.max(0, Math.min(gains.length - 1, y));
  const y0 = Math.floor(fy);
  const y1 = Math.min(gains.length - 1, y0 + 1);
  return gains[y0] + (gains[y1] - gains[y0]) * (fy - y0);
}

/** The picture's brightness with each row divided by its gain: as if it had been taken with the empty board's light, row by row. */
export function evenRows(frame: Float32Array, gains: Float32Array, width: number): Float32Array {
  const out = new Float32Array(frame.length);
  for (let y = 0; y < gains.length; y++) {
    const gain = gains[y];
    for (let x = 0, i = y * width; x < width; x++, i++) out[i] = frame[i] / gain;
  }
  return out;
}
