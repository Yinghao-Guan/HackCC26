// From a fingertip in the camera picture to a pen on the whiteboard: where it is
// on the whiteboard (smoothed), and whether it is writing. Plain code, no React.

import type { BoardMessage } from "@/lib/boardLink";
import type { Calibration } from "./calibrate";
import { applyHomography } from "./homography";
import { PointFilter } from "./oneEuro";
import type { Point } from "./shadowTouch";
import { OFF, stepSwitch, type Switch } from "./writing";

// The writing pose has to hold for a couple of frames to count, and to be lost for a few to stop,
// so one frame where the hand shape is misjudged does not break a line.
const FRAMES_TO_POINT = 2;
const FRAMES_TO_STOP_POINTING = 3;

export interface PenFrame {
  /** The time of the frame, in seconds. */
  time: number;
  /** The index fingertip in the camera picture, 0 to 1 across it. */
  tip: Point;
  /** Is the hand in the writing pose (only the index finger out)? */
  pointing: boolean;
  /** Is the fingertip touching the board, going by its shadow? */
  touching: boolean;
  /** Where the whiteboard is: the calibration and the size of its window. Null if not known yet. */
  target: { calibration: Calibration; width: number; height: number } | null;
  /** How steady to hold the pen, as the filter's cutoff in Hz: lower is steadier but lags more. */
  smoothing: number;
}

export class Pen {
  private filter = new PointFilter();
  private pointing: Switch = OFF;
  private sending = false;

  /**
   * One camera frame with a hand in it. `writing` is true when the hand holds the
   * writing pose and touches the board. `message` is what to tell the whiteboard
   * (null if its position is not known yet).
   */
  update(frame: PenFrame): { writing: boolean; message: BoardMessage | null } {
    this.pointing = stepSwitch(this.pointing, frame.pointing, FRAMES_TO_POINT, FRAMES_TO_STOP_POINTING);
    const writing = this.pointing.on && frame.touching;
    if (!frame.target) return { writing, message: null };

    const { calibration, width, height } = frame.target;
    const shares = applyHomography(calibration.matrix, frame.tip);
    // Smooth in the whiteboard's own pixels, where the filter's settings mean the same thing everywhere.
    this.filter.minCutoff = frame.smoothing;
    const smooth = this.filter.filter({ x: shares.x * width, y: shares.y * height }, frame.time);
    this.sending = true;
    return {
      writing,
      message: { type: "pointer", x: smooth.x / width, y: smooth.y / height, writing },
    };
  }

  /** No hand in this frame. Gives the message that tells the whiteboard, once. */
  lost(): BoardMessage | null {
    this.pointing = OFF;
    this.filter = new PointFilter(this.filter.minCutoff, this.filter.beta);
    if (!this.sending) return null;
    this.sending = false;
    return { type: "pointer-lost" };
  }
}
