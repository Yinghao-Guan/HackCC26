// The link between the camera page (which watches the board) and the whiteboard
// (which is projected). They are two pages of the same browser, and talk through a
// BroadcastChannel: no server. This is the "event bus" of the design docs, in its
// simplest form (docs/02-technical-design.md, section 9).
//
// Every position is a share of the whiteboard window: 0 is its left or top edge and
// 1 is its right or bottom edge. The camera page does not need to know the window's
// size in pixels, and positions outside 0 to 1 are simply outside the window.

export const BOARD_CHANNEL = "wiseboard-board";

/** Where the calibration markers sit, as shares of the window's width and height. */
export const MARKER_SHARES = [0.1, 0.5, 0.9] as const;

/** The nine calibration markers, row by row from the top. */
export const MARKER_POINTS: { x: number; y: number }[] = MARKER_SHARES.flatMap((y) =>
  MARKER_SHARES.map((x) => ({ x, y })),
);

/** A rectangle as shares of the whiteboard window. */
export interface ShareRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BoardMessage =
  /** From the whiteboard, every second: it is there, and this is how big its window is. */
  | { type: "alive"; width: number; height: number }
  /** From the camera page, every second: whether it can take a picture of the board (camera on, calibrated). */
  | { type: "camera"; ready: boolean }
  /**
   * To the whiteboard: what to show for calibration. "plain" is the whole window in white, "markers"
   * is the same with the nine black squares on it, and "off" is the whiteboard again. A white window
   * gives every square the same strong contrast, wherever it falls.
   */
  | { type: "markers"; screen: CalibrationScreen }
  /**
   * To the whiteboard: where the fingertip is, and whether it is touching in the writing pose.
   * `draw` says whether a touch on the board itself may draw (otherwise the finger only presses buttons).
   */
  | { type: "pointer"; x: number; y: number; writing: boolean; draw: boolean }
  /** To the whiteboard: the hand is gone. */
  | { type: "pointer-lost" }
  /** To the camera page: take a picture of this part of the window (the drawing area), straightened. */
  | { type: "capture-request"; id: number; area: ShareRect }
  /** To the whiteboard: clear the drawing area to plain board color now (or bring it back), so only real writing shows. */
  | { type: "blank"; id: number; on: boolean }
  /**
   * To the whiteboard: the picture, as a PNG data URL the size of the drawing area times `scale`.
   * It is cleaned up: white where there is no writing, and the writing in shades of gray.
   */
  | { type: "capture"; id: number; image: string; scale: number }
  /** To the whiteboard: the picture could not be taken. */
  | { type: "capture-failed"; id: number; reason: string }
  /**
   * From the whiteboard: what the finger is over (a button's name, "board", or null when there is no
   * finger) and whether it is touching. For showing on the camera page.
   */
  | { type: "finger-state"; over: string | null; touching: boolean }
  /** From the whiteboard: the finger clicked this button. */
  | { type: "finger-click"; label: string };

export type CalibrationScreen = "off" | "plain" | "markers";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isShareRect = (value: unknown): value is ShareRect => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isNumber(v.x) && isNumber(v.y) && isNumber(v.width) && isNumber(v.height) && v.width > 0 && v.height > 0;
};

/** Check a message that came over the channel before using it. */
export function isBoardMessage(value: unknown): value is BoardMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "alive":
      return isNumber(v.width) && isNumber(v.height);
    case "camera":
      return typeof v.ready === "boolean";
    case "markers":
      return v.screen === "off" || v.screen === "plain" || v.screen === "markers";
    case "pointer":
      return isNumber(v.x) && isNumber(v.y) && typeof v.writing === "boolean" && typeof v.draw === "boolean";
    case "pointer-lost":
      return true;
    case "capture-request":
      return isNumber(v.id) && isShareRect(v.area);
    case "blank":
      return isNumber(v.id) && typeof v.on === "boolean";
    case "capture":
      return isNumber(v.id) && typeof v.image === "string" && v.image.startsWith("data:image/png;base64,") && isNumber(v.scale) && v.scale > 0;
    case "capture-failed":
      return isNumber(v.id) && typeof v.reason === "string";
    case "finger-state":
      return (v.over === null || typeof v.over === "string") && typeof v.touching === "boolean";
    case "finger-click":
      return typeof v.label === "string";
    default:
      return false;
  }
}
