// The One Euro filter smooths a moving point: it holds it steady when it moves
// slowly (so the fingertip's jitter does not shake a line) and follows closely when
// it moves fast (so quick strokes do not lag). It is the default the design docs
// suggest for pen strokes (docs/02-technical-design.md, section 4). Plain code, no React.

import type { Point } from "./shadowTouch";

const lowPass = (value: number, previous: number, alpha: number) => alpha * value + (1 - alpha) * previous;

/** How much of a new value to take, for a cutoff in Hz and a step of `dt` seconds. */
const alphaFor = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

class Channel {
  private previous: number | null = null;
  private slope = 0;
  private time = 0;

  filter(value: number, time: number, minCutoff: number, beta: number, slopeCutoff: number): number {
    if (this.previous === null) {
      this.previous = value;
      this.time = time;
      return value;
    }
    const dt = Math.max(1e-3, time - this.time);
    const rawSlope = (value - this.previous) / dt;
    this.slope = lowPass(rawSlope, this.slope, alphaFor(slopeCutoff, dt));
    const cutoff = minCutoff + beta * Math.abs(this.slope);
    this.previous = lowPass(value, this.previous, alphaFor(cutoff, dt));
    this.time = time;
    return this.previous;
  }
}

export class PointFilter {
  private readonly x = new Channel();
  private readonly y = new Channel();

  /**
   * @param minCutoff how steady a slow point is held, in Hz: lower is steadier but lags more
   * @param beta how quickly the filter lets go when the point moves fast: higher follows fast moves better
   */
  constructor(
    public minCutoff = 1.5,
    public beta = 0.02,
    private readonly slopeCutoff = 1,
  ) {}

  /** The smoothed point for a new one at `time` (seconds). */
  filter(point: Point, time: number): Point {
    return {
      x: this.x.filter(point.x, time, this.minCutoff, this.beta, this.slopeCutoff),
      y: this.y.filter(point.y, time, this.minCutoff, this.beta, this.slopeCutoff),
    };
  }
}
