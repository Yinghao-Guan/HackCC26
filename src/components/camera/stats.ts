// Rolling numbers that say how steady hand tracking is, so camera angles can be
// compared with numbers instead of by eye. Plain functions, no React.

export interface TipSample {
  /** When the frame was processed, in milliseconds (`performance.now()`). */
  t: number;
  /** The index fingertip in picture pixels, or null if no hand was found. */
  tip: { x: number; y: number } | null;
  /** Was the hand in the writing pose (only the index finger out)? False when there is no hand. */
  pointing: boolean;
}

const LOST_WINDOW_MS = 2000;
const JITTER_WINDOW_MS = 1000;
const MIN_JITTER_SAMPLES = 8;

/** Forget samples older than the longest window reported on. Changes the array. */
export function pruneSamples(samples: TipSample[], now: number): void {
  let old = 0;
  while (old < samples.length && now - samples[old].t > LOST_WINDOW_MS) old++;
  samples.splice(0, old);
}

/** The share of recent frames in which no hand was found (0 to 1), or null before any frame. */
export function lostShare(samples: TipSample[]): number | null {
  if (samples.length === 0) return null;
  let lost = 0;
  for (const sample of samples) if (sample.tip === null) lost++;
  return lost / samples.length;
}

/**
 * Of the recent frames that had a hand, the share in the writing pose (0 to 1).
 * Hold the 👆 pose steadily and watch this: if it drops, the pose is being
 * missed from this camera angle. Null if no hand was seen.
 */
export function pointingShare(samples: TipSample[]): number | null {
  let withHand = 0;
  let pointing = 0;
  for (const sample of samples) {
    if (sample.tip === null) continue;
    withHand++;
    if (sample.pointing) pointing++;
  }
  return withHand === 0 ? null : pointing / withHand;
}

/**
 * How much the fingertip wobbles: its typical distance, in picture pixels, from
 * its own average position over the last second. Only meaningful while the
 * finger is held still. Null if there are too few frames with a hand.
 */
export function jitter(samples: TipSample[], now: number): number | null {
  const tips: { x: number; y: number }[] = [];
  for (const sample of samples) {
    if (sample.tip && now - sample.t <= JITTER_WINDOW_MS) tips.push(sample.tip);
  }
  if (tips.length < MIN_JITTER_SAMPLES) return null;

  let meanX = 0;
  let meanY = 0;
  for (const { x, y } of tips) {
    meanX += x;
    meanY += y;
  }
  meanX /= tips.length;
  meanY /= tips.length;

  let squares = 0;
  for (const { x, y } of tips) squares += (x - meanX) ** 2 + (y - meanY) ** 2;
  return Math.sqrt(squares / tips.length);
}

/** How many frames arrived in the last second. Changes the array. */
export function framesPerSecond(times: number[], now: number): number {
  let old = 0;
  while (old < times.length && now - times[old] > 1000) old++;
  times.splice(0, old);
  return times.length;
}
