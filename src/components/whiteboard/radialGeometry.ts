// Geometry for the floating radial AI menu (AiMenu.tsx): where its round button rests on the
// board, and where the open menu's center goes so the whole menu stays on the board.

import type { Point } from "./strokes";

/** The round button the menu opens from. */
export const HUB_SIZE = 64;
/** Space between the resting hub and the board's edge. */
export const EDGE_MARGIN = 20;
/** Extra room for shadows when keeping the open menu on the board. */
const SHADOW_ROOM = 10;

export interface BoardSize {
  width: number;
  height: number;
}

/** How far the open menu reaches from its center, as a box around the center. */
export interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The space an open menu covers: its disc of `discRadius`, plus room for its shadow. */
export function menuExtent(discRadius: number): Extent {
  const reach = discRadius + SHADOW_ROOM;
  return { minX: -reach, minY: -reach, maxX: reach, maxY: reach };
}

/** `value` kept within [min, max]. If the range is empty, its middle. */
export function clampAxis(value: number, min: number, max: number): number {
  return min > max ? (min + max) / 2 : Math.min(max, Math.max(min, value));
}

/**
 * Where the open menu's center goes: at the hub if the whole menu fits there, otherwise
 * slid just far enough onto the board that it does.
 */
export function fitCenter(hub: Point, extent: Extent, board: BoardSize): Point {
  return {
    x: clampAxis(hub.x, -extent.minX, board.width - extent.maxX),
    y: clampAxis(hub.y, -extent.minY, board.height - extent.maxY),
  };
}

const HUB_INSET = EDGE_MARGIN + HUB_SIZE / 2;

/**
 * Where the closed hub rests. `place` is a fraction (0 to 1) of the room it can move in on
 * each axis, so it stays in the same spot relative to the board when the window is resized.
 */
export function restPoint(place: Point, board: BoardSize): Point {
  return {
    x: HUB_INSET + place.x * Math.max(0, board.width - 2 * HUB_INSET),
    y: HUB_INSET + place.y * Math.max(0, board.height - 2 * HUB_INSET),
  };
}

/** The opposite of `restPoint`: the place for a hub dragged to `point`. */
export function placeAt(point: Point, board: BoardSize): Point {
  const fraction = (value: number, length: number) => {
    const room = length - 2 * HUB_INSET;
    return room <= 0 ? 0.5 : Math.min(1, Math.max(0, (value - HUB_INSET) / room));
  };
  return { x: fraction(point.x, board.width), y: fraction(point.y, board.height) };
}
