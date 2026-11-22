// A picture of what is written on the board with a marker, for the AI to read. The
// whiteboard clears its drawing area to plain board color for a moment, so the camera
// sees only real writing. The camera frame is then straightened into the whiteboard's
// own layout with the calibration, and cleaned: white everywhere but the writing.
// Plain functions on pixel data, no React.

import type { ShareRect } from "@/lib/boardLink";
import { labelBlobs } from "./blobs";
import type { Matrix } from "./homography";

/** The picture's long side is at most this many pixels. */
export const MAX_PICTURE_SIDE = 1600;

const CELL = 32; // the board's own brightness is measured in squares this big
const BACKGROUND_SHARE = 0.8; // in each square, the board is the brightness 80% of the pixels are darker than
const INK_RATIO = 0.8; // darker than this share of the board around it is writing
const BLACK_RATIO = 0.45; // this dark or darker is drawn fully black
const MIN_INK_AREA = 12; // pixels; smaller specks are noise

/**
 * Straighten part of the whiteboard window out of a camera frame's brightness. Every
 * pixel of the output (which covers `area`, as shares of the window) is looked up in
 * the camera frame through `windowToCamera` (the inverse of the calibration) and its
 * brightness taken there. Pixels outside the camera frame are NaN.
 */
export function straighten(
  luma: Float32Array,
  frameWidth: number,
  frameHeight: number,
  windowToCamera: Matrix,
  area: ShareRect,
  outWidth: number,
  outHeight: number,
): Float32Array {
  const [a, b, c, d, e, f, g, h, k] = windowToCamera;
  const out = new Float32Array(outWidth * outHeight);
  for (let row = 0; row < outHeight; row++) {
    const v = area.y + ((row + 0.5) / outHeight) * area.height;
    for (let column = 0; column < outWidth; column++) {
      const u = area.x + ((column + 0.5) / outWidth) * area.width;
      const w = g * u + h * v + k;
      const x = ((a * u + b * v + c) / w) * frameWidth - 0.5;
      const y = ((d * u + e * v + f) / w) * frameHeight - 0.5;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const index = row * outWidth + column;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= frameWidth || y0 + 1 >= frameHeight) {
        out[index] = NaN;
        continue;
      }
      const fx = x - x0;
      const fy = y - y0;
      const i = y0 * frameWidth + x0;
      out[index] =
        luma[i] * (1 - fx) * (1 - fy) +
        luma[i + 1] * fx * (1 - fy) +
        luma[i + frameWidth] * (1 - fx) * fy +
        luma[i + frameWidth + 1] * fx * fy;
    }
  }
  return out;
}

/**
 * How bright the empty board is around each pixel. The board is not evenly lit (the
 * projector is brighter in the middle, and there may be a glare spot), so it is
 * measured square by square, from the brighter pixels of each square, which are the
 * board rather than the writing, and blended smoothly between squares.
 */
function boardBrightness(luma: Float32Array, width: number, height: number): Float32Array {
  const columns = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const cells = new Float32Array(columns * rows).fill(NaN);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      const values: number[] = [];
      for (let y = cy * CELL; y < Math.min(height, (cy + 1) * CELL); y++) {
        for (let x = cx * CELL; x < Math.min(width, (cx + 1) * CELL); x++) {
          const value = luma[y * width + x];
          if (!Number.isNaN(value)) values.push(value);
        }
      }
      if (values.length > CELL) {
        values.sort((p, q) => p - q);
        cells[cy * columns + cx] = values[Math.floor((values.length - 1) * BACKGROUND_SHARE)];
      }
    }
  }

  // Squares with nothing to measure (outside the camera picture) take the middle value of the rest.
  const known = Array.from(cells).filter((value) => !Number.isNaN(value)).sort((p, q) => p - q);
  const fallback = known.length > 0 ? known[known.length >> 1] : 255;
  for (let i = 0; i < cells.length; i++) if (Number.isNaN(cells[i])) cells[i] = fallback;

  // A glare spot makes the squares it falls in look brighter than the board really is, and the
  // board next to it would then look dark and be taken for writing. Each square takes the middle
  // value of itself and its neighbors, which a spot covering a few squares cannot move.
  const smooth = new Float32Array(cells.length);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      const around: number[] = [];
      for (let ny = Math.max(0, cy - 1); ny <= Math.min(rows - 1, cy + 1); ny++) {
        for (let nx = Math.max(0, cx - 1); nx <= Math.min(columns - 1, cx + 1); nx++) {
          around.push(cells[ny * columns + nx]);
        }
      }
      around.sort((p, q) => p - q);
      smooth[cy * columns + cx] = around[around.length >> 1];
    }
  }

  const background = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(rows - 1, Math.max(0, (y + 0.5) / CELL - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(columns - 1, Math.max(0, (x + 0.5) / CELL - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(columns - 1, x0 + 1);
      const tx = gx - x0;
      const top = smooth[y0 * columns + x0] * (1 - tx) + smooth[y0 * columns + x1] * tx;
      const bottom = smooth[y1 * columns + x0] * (1 - tx) + smooth[y1 * columns + x1] * tx;
      background[y * width + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return background;
}

export interface WritingPicture {
  /** One brightness per pixel, 0 (black) to 255 (white): white everywhere but the writing. */
  gray: Uint8ClampedArray;
  width: number;
  height: number;
  /** How many pixels are writing. */
  inkPixels: number;
}

/**
 * Find the writing in a straightened picture of the board and clean it up: pixels
 * clearly darker than the board around them are writing, drawn darker the darker
 * they are; everything else is white. Specks, and marks that reach the picture's
 * edge (the board's frame, tape at the corners), are dropped.
 */
export function findWriting(luma: Float32Array, width: number, height: number): WritingPicture {
  const background = boardBrightness(luma, width, height);
  const ratio = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < ratio.length; i++) {
    const value = luma[i];
    ratio[i] = Number.isNaN(value) || background[i] <= 0 ? 1 : value / background[i];
    if (ratio[i] < INK_RATIO) mask[i] = 1;
  }

  const { label, area, touchesEdge } = labelBlobs(mask, width, height);
  const gray = new Uint8ClampedArray(width * height).fill(255);
  let inkPixels = 0;
  for (let i = 0; i < gray.length; i++) {
    const id = label[i];
    if (id === 0 || area[id] < MIN_INK_AREA || touchesEdge[id]) continue;
    gray[i] = Math.round((Math.max(0, ratio[i] - BLACK_RATIO) / (1 - BLACK_RATIO)) * 255);
    inkPixels++;
  }
  return { gray, width, height, inkPixels };
}

/** The size of the picture for a drawing area of this many window pixels, and the scale from window pixels to picture pixels. */
export function pictureSize(areaWidth: number, areaHeight: number): { width: number; height: number; scale: number } {
  const scale = Math.min(1, MAX_PICTURE_SIDE / Math.max(areaWidth, areaHeight));
  return {
    width: Math.max(1, Math.round(areaWidth * scale)),
    height: Math.max(1, Math.round(areaHeight * scale)),
    scale,
  };
}
