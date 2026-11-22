// Geometry for the floating radial tool menu (RadialMenu.tsx).
// Angles are in degrees, clockwise from pointing right, because screen y points down.

import { SIZE_LIMITS, type SizedTool } from "./settings";
import type { Point } from "./strokes";

/** The round button the menu opens from. */
export const HUB_SIZE = 64;
/** The main ring: tools, board actions, size and color. */
export const ITEM_SIZE = 52;
export const RING_RADIUS = 100;
/** The outer ring that fans out from Eraser, Board, Color or Size. */
export const SUB_ITEM_SIZE = 46;
export const SUB_RING_RADIUS = 164;
/** How thick the band behind an open outer ring is. */
export const SUB_BAND_WIDTH = 58;
/** The disc behind the main ring. */
export const DISC_RADIUS = RING_RADIUS + ITEM_SIZE / 2 + 10;
/** Space between the resting hub and the board's edge. */
export const EDGE_MARGIN = 20;
/** Extra room for shadows when keeping the open menu on the board. */
const SHADOW_ROOM = 10;

/** The items on the main ring, clockwise from the top. */
export type MainItem = "pen" | "eraser" | "text" | "move" | "undo" | "board" | "size" | "color";

/**
 * Where each main item sits. Eight items, 45° apart (eight is where marking menus stay fast and
 * accurate): the tools run clockwise from the top, then undo and the board actions at the
 * bottom, then size and color on the left, beside the pen. The same item is always in the same
 * direction, so a hand learns where it is (Kurtenbach & Buxton's marking-menu studies).
 */
export const MAIN_ANGLES: Record<MainItem, number> = {
  pen: -90,
  eraser: -45,
  text: 0,
  move: 45,
  undo: 90,
  board: 135,
  size: 180,
  color: 225,
};

export const MAIN_ORDER: MainItem[] = [
  "pen",
  "eraser",
  "text",
  "move",
  "undo",
  "board",
  "size",
  "color",
];

/** The main items that open an outer ring. */
export type SubMenu = Extract<MainItem, "eraser" | "board" | "size" | "color">;

/** The outer rings made of buttons (Size is a slider instead). */
export type ButtonRing = Exclude<SubMenu, "size">;

/** Degrees between neighbouring buttons on each outer ring. */
const SUB_STEP: Record<ButtonRing, number> = { eraser: 30, board: 32, color: 26 };

/** The size slider: an arc on the outer ring centered on the Size button, smallest at the bottom. */
export const SIZE_ARC = { from: MAIN_ANGLES.size - 60, to: MAIN_ANGLES.size + 60 };

export interface BoardSize {
  width: number;
  height: number;
}

/** A point `radius` away from the center, in direction `angle`. */
export function polar(angle: number, radius: number): Point {
  const rad = (angle * Math.PI) / 180;
  return { x: Math.cos(rad) * radius, y: Math.sin(rad) * radius };
}

/** Directions for `count` items centered on `center`, `step` degrees apart. */
export function arcAngles(center: number, count: number, step: number): number[] {
  const start = center - ((count - 1) * step) / 2;
  return Array.from({ length: count }, (_, i) => start + i * step);
}

/** Directions for the buttons of an outer ring, fanned out around the item that opened it. */
export function subAngles(ring: ButtonRing, count: number): number[] {
  return arcAngles(MAIN_ANGLES[ring], count, SUB_STEP[ring]);
}

/**
 * A coordinate for an SVG path, rounded to 0.01 px. The server and the browser can disagree in
 * the last digits of `Math.cos`/`Math.sin`, and the path text has to match for hydration.
 */
const coord = (value: number) => (Math.round(value * 100) / 100).toString();

/** An SVG path along a circle of `radius` around (`cx`, `cy`), clockwise from `from` to `to`. */
export function arcPath(cx: number, cy: number, radius: number, from: number, to: number): string {
  const a = polar(from, radius);
  const b = polar(to, radius);
  const largeArc = to - from > 180 ? 1 : 0;
  return `M ${coord(cx + a.x)} ${coord(cy + a.y)} A ${radius} ${radius} 0 ${largeArc} 1 ${coord(cx + b.x)} ${coord(cy + b.y)}`;
}

/**
 * An SVG path for a band along an arc whose half-thickness at each angle is `halfWidthAt(angle)`,
 * with round ends. Used for the size slider's track, which gets thicker as sizes get bigger.
 */
export function taperedArcPath(
  cx: number,
  cy: number,
  radius: number,
  from: number,
  to: number,
  halfWidthAt: (angle: number) => number,
): string {
  if (to <= from) return "";
  const steps = Math.max(2, Math.ceil((to - from) / 3));
  const outer: string[] = [];
  const inner: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = from + ((to - from) * i) / steps;
    const w = halfWidthAt(angle);
    const o = polar(angle, radius + w);
    const n = polar(angle, radius - w);
    outer.push(`${coord(cx + o.x)} ${coord(cy + o.y)}`);
    inner.push(`${coord(cx + n.x)} ${coord(cy + n.y)}`);
  }
  const endW = coord(halfWidthAt(to));
  const startW = coord(halfWidthAt(from));
  inner.reverse();
  return [
    `M ${outer.join(" L ")}`,
    `A ${endW} ${endW} 0 0 1 ${inner[0]}`,
    `L ${inner.join(" L ")}`,
    `A ${startW} ${startW} 0 0 1 ${outer[0]}`,
    "Z",
  ].join(" ");
}

/**
 * How far along an arc (0 at `from`, 1 at `to`) the direction `angle` points. Directions outside
 * the arc count as its nearer end, so dragging past either end holds the slider there.
 */
export function arcFraction(angle: number, from: number, to: number): number {
  const half = (to - from) / 2;
  const offset = ((((angle - (from + half)) % 360) + 540) % 360) - 180; // -180 to 180
  return (Math.min(half, Math.max(-half, offset)) + half) / (2 * half);
}

/** How far the open menu reaches from its center, as a box around the center. */
export interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The space the open menu covers: the disc, plus the band of an open outer ring (its span). */
export function menuExtent(openSpan: readonly [number, number] | null): Extent {
  const disc = DISC_RADIUS + SHADOW_ROOM;
  const extent = { minX: -disc, minY: -disc, maxX: disc, maxY: disc };
  if (!openSpan) return extent;

  // The band is a thick arc with round ends: every point within half its width of the arc.
  const pad = SUB_BAND_WIDTH / 2 + SHADOW_ROOM;
  const [from, to] = openSpan;
  for (let angle = from; ; angle = Math.min(angle + 5, to)) {
    const p = polar(angle, SUB_RING_RADIUS);
    extent.minX = Math.min(extent.minX, p.x - pad);
    extent.minY = Math.min(extent.minY, p.y - pad);
    extent.maxX = Math.max(extent.maxX, p.x + pad);
    extent.maxY = Math.max(extent.maxY, p.y + pad);
    if (angle >= to) break;
  }
  return extent;
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

/** How far `size` is through `tool`'s size range, from 0 (smallest) to 1 (biggest). */
export function sizeFraction(tool: SizedTool, size: number): number {
  const { min, max } = SIZE_LIMITS[tool];
  return Math.min(1, Math.max(0, (size - min) / (max - min)));
}

/** The size at fraction `t` (0 to 1) of `tool`'s size range, in whole pixels. */
export function sizeAtFraction(tool: SizedTool, t: number): number {
  const { min, max } = SIZE_LIMITS[tool];
  return Math.round(min + Math.min(1, Math.max(0, t)) * (max - min));
}

/** A diameter between `smallest` and `largest` that shows how big `size` is for `tool`. */
export function previewDiameter(
  tool: SizedTool,
  size: number,
  smallest: number,
  largest: number,
): number {
  return smallest + sizeFraction(tool, size) * (largest - smallest);
}
