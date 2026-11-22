// Calibration: find out where the whiteboard is in the camera picture. The
// whiteboard shows a grid of black markers on white, the camera sees it, and a homography
// fitted to the nine marker positions turns any point in the camera picture into a
// position on the whiteboard. Comparing a picture without the markers with one
// with them leaves only the markers, whatever else is bright (glare, the settings
// panel). This is the manual-calibration fallback of the design docs; automatic
// calibration with ArUco markers can replace it later by producing the same matrix.
// Plain functions, no React.

import { MARKER_POINTS } from "@/lib/boardLink";
import { findBlobs } from "./blobs";
import { fitHomography, rmsError, type Matrix } from "./homography";
import type { Point } from "./shadowTouch";

export interface Calibration {
  /** Takes a point in the camera picture (0 to 1 across it) to the whiteboard window (0 to 1 across it). */
  matrix: Matrix;
  /** How far the markers land from where they should, on average, as a share of the window's width. */
  error: number;
  /** How many markers were used. */
  markers: number;
}

/** The result, with the markers that were found (0 to 1 across the camera picture), to show where they were. */
export type CalibrationResult =
  | { ok: true; calibration: Calibration; found: Point[] }
  | { ok: false; reason: string; found: Point[] };

const MIN_STEP = 35; // a marker changes the brightness of its spot by at least this much
const MIN_AREA = 60; // pixels
const MAX_ERROR = 0.02; // beyond this the markers do not form a clean grid

/**
 * Work out the calibration from two pictures of the whiteboard, as brightness
 * arrays: one without the markers and one with them.
 */
export function calibrationFrom(
  without: Float32Array,
  withMarkers: Float32Array,
  width: number,
  height: number,
): CalibrationResult {
  // The markers are what changed. They are black squares, which stand out on the gray board and on
  // the white settings panel alike (white ones would vanish on the panel), so the change can go
  // either way. A fixed step is used rather than one relative to the biggest change, because a
  // marker on the white panel changes much more than one on the gray board.
  const mask = new Uint8Array(without.length);
  let changed = 0;
  for (let i = 0; i < without.length; i++) {
    if (Math.abs(withMarkers[i] - without[i]) >= MIN_STEP) {
      mask[i] = 1;
      changed++;
    }
  }
  if (changed === 0) {
    return {
      ok: false,
      reason: "The markers did not show up in the camera picture. Is the whiteboard window visible and in view of the camera?",
      found: [],
    };
  }

  const blobs = findBlobs(mask, width, height, MIN_AREA)
    .sort((a, b) => b.area - a.area)
    .slice(0, MARKER_POINTS.length);
  const found = blobs.map((blob) => ({ x: blob.x / width, y: blob.y / height }));
  if (blobs.length < MARKER_POINTS.length) {
    return {
      ok: false,
      reason: `Found ${blobs.length} of ${MARKER_POINTS.length} markers (circled in green on the picture). Keep your hand and body out of the picture, and check that the whole whiteboard window is in view of the camera.`,
      found,
    };
  }

  // Three rows from the top, and each row from the left.
  const byHeight = [...blobs].sort((a, b) => a.y - b.y);
  const ordered: Point[] = [];
  for (let row = 0; row < 3; row++) {
    byHeight
      .slice(row * 3, row * 3 + 3)
      .sort((a, b) => a.x - b.x)
      .forEach((blob) => ordered.push({ x: blob.x / width, y: blob.y / height }));
  }

  const matrix = fitHomography(ordered, MARKER_POINTS);
  if (!matrix) return { ok: false, reason: "The markers do not pin down the position of the whiteboard.", found };

  const error = rmsError(matrix, ordered, MARKER_POINTS);
  if (error > MAX_ERROR) {
    return {
      ok: false,
      reason: "The markers are not in a clean grid in the picture. Check the camera angle and try again.",
      found,
    };
  }
  return { ok: true, calibration: { matrix, error, markers: ordered.length }, found };
}
