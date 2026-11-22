// The link between the camera page (which watches the finger) and the whiteboard
// (which is projected). They are two pages of the same browser, and talk through a
// BroadcastChannel: no server. This is the "event bus" of the design docs, in its
// simplest form (docs/02-technical-design.md, section 9).
//
// Every position is a share of the whiteboard window: 0 is its left or top edge and
// 1 is its right or bottom edge. The camera page does not need to know the window's
// size in pixels, and positions outside 0 to 1 are simply outside the window.

export const BOARD_CHANNEL = "hackcc26-board";

/** Where the calibration markers sit, as shares of the window's width and height. */
export const MARKER_SHARES = [0.1, 0.5, 0.9] as const;

/** The nine calibration markers, row by row from the top. */
export const MARKER_POINTS: { x: number; y: number }[] = MARKER_SHARES.flatMap((y) =>
  MARKER_SHARES.map((x) => ({ x, y })),
);

export type BoardMessage =
  /** From the whiteboard, every second: it is there, and this is how big its window is. */
  | { type: "alive"; width: number; height: number }
  /** To the whiteboard: show or hide the calibration markers. */
  | { type: "markers"; show: boolean }
  /** To the whiteboard: where the fingertip is, and whether it is writing (in the pose, and touching). */
  | { type: "pointer"; x: number; y: number; writing: boolean }
  /** To the whiteboard: the hand is gone. */
  | { type: "pointer-lost" };

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Check a message that came over the channel before using it. */
export function isBoardMessage(value: unknown): value is BoardMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "alive":
      return isNumber(v.width) && isNumber(v.height);
    case "markers":
      return typeof v.show === "boolean";
    case "pointer":
      return isNumber(v.x) && isNumber(v.y) && typeof v.writing === "boolean";
    case "pointer-lost":
      return true;
    default:
      return false;
  }
}
