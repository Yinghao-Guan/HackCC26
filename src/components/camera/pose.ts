// Hand pose: is the hand in the writing pose, with only the index finger out (👆)?
// Writing is only allowed in that pose, so that other gestures (such as pinching
// the thumb and index finger to switch between pen and eraser) can never draw.
// Plain functions, no React.
//
// The pose is judged from where the landmarks are in the camera picture, not from
// the model's 3D guess. Writing is done with the back of the hand to the camera,
// and from there the curled fingers are hidden behind the knuckles, so the 3D
// guess for them is unreliable (a real frame of that view was rejected by the 3D
// check). In the picture their tips sit close to their knuckles, and that is easy
// to measure.

import type { Point } from "./shadowTouch";

// MediaPipe's hand landmarks: the knuckle (MCP) and the tip of each finger.
const FINGERS = {
  index: { knuckle: 5, tip: 8 },
  middle: { knuckle: 9, tip: 12 },
  ring: { knuckle: 13, tip: 16 },
  pinky: { knuckle: 17, tip: 20 },
} as const;

export type FingerName = keyof typeof FINGERS;
export const FINGER_NAMES = Object.keys(FINGERS) as FingerName[];

/** How far each fingertip is from its knuckle in the picture, in hand sizes. A finger held out is long and a curled one is short. */
export type FingerReach = Record<FingerName, number>;

/** The other three fingers must reach less than this share of what the index finger reaches. */
export const DEFAULT_OTHERS_SHORTER = 0.65;

/** The index finger must reach at least this many hand sizes, so a fist (every finger short) does not count. */
export const MIN_INDEX_REACH = 0.6;

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * How big the hand is in the picture: the palm's width or its length, whichever
 * is larger, so turning the hand does not shrink it much. Landmarks must be in
 * pixels (the same scale on both axes), not 0 to 1.
 */
export function handSize(points: Point[]): number {
  return Math.max(distance(points[5], points[17]), distance(points[0], points[9]));
}

export function fingerReach(points: Point[]): FingerReach {
  const size = handSize(points) || 1;
  const reach = (name: FingerName) =>
    distance(points[FINGERS[name].knuckle], points[FINGERS[name].tip]) / size;
  return {
    index: reach("index"),
    middle: reach("middle"),
    ring: reach("ring"),
    pinky: reach("pinky"),
  };
}

/**
 * True when the index finger is out and the middle, ring and little fingers are
 * curled: clearly shorter than the index finger. The thumb is not looked at:
 * people hold it tucked or out, and a pinch (thumb and index fingertip together)
 * bends the index finger, so it is not long enough.
 */
export function isPointing(reach: FingerReach, othersShorter = DEFAULT_OTHERS_SHORTER): boolean {
  const longestOther = Math.max(reach.middle, reach.ring, reach.pinky);
  return reach.index >= MIN_INDEX_REACH && longestOther <= reach.index * othersShorter;
}
