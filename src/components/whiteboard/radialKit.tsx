// The pieces shared by the floating radial menus (the tool menu in RadialMenu.tsx and the AI
// menu in AiMenu.tsx), so both look and move the same: the motion, the round buttons, the disc,
// and a hub that can be dragged around the board and slides the open menu onto it.

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  fitCenter,
  placeAt,
  restPoint,
  type BoardSize,
  type Extent,
} from "./radialGeometry";
import type { Point } from "./strokes";

// Motion. Opening overshoots a little, like a spring, and items follow each other around the
// ring; closing is quicker and plain.
export const SPRING = "cubic-bezier(0.34, 1.5, 0.64, 1)";
export const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";
export const GLIDE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const STAGGER_OPEN_MS = 22;
const STAGGER_CLOSE_MS = 12;

/** A press on the hub that moves less than this is a tap, not a drag. */
const DRAG_THRESHOLD = 6;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True if the system asks for less motion; the menus then open and close without animating. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

/**
 * Put an element's center at `radius` from the menu's center, in direction `angle`. Written as
 * rotate → move out → rotate back so a transition between two of these swings the element along
 * a curve around the center instead of a straight line.
 */
export function polarTransform(angle: number, radius: number, scale: number): string {
  return `translate(-50%, -50%) rotate(${angle}deg) translateX(${radius}px) rotate(${-angle}deg) scale(${scale})`;
}

interface OrbitProps {
  shown: boolean;
  /** Where the item sits while shown. */
  angle: number;
  radius: number;
  /** Where it tucks away to while hidden (and grows out of when shown). */
  fromAngle: number;
  fromRadius: number;
  size: number;
  /** Its place in the ring, for the stagger. */
  index: number;
  count: number;
  reducedMotion: boolean;
  children: ReactNode;
}

/** Holds one menu item and moves it between its tucked-away spot and its place on a ring. */
export function Orbit({
  shown,
  angle,
  radius,
  fromAngle,
  fromRadius,
  size,
  index,
  count,
  reducedMotion,
  children,
}: OrbitProps) {
  const delay = shown ? index * STAGGER_OPEN_MS : (count - 1 - index) * STAGGER_CLOSE_MS;
  return (
    <div
      role="none"
      className="absolute left-0 top-0"
      style={{
        width: size,
        height: size,
        transform: shown
          ? polarTransform(angle, radius, 1)
          : polarTransform(fromAngle, fromRadius, 0.4),
        opacity: shown ? 1 : 0,
        transition: reducedMotion
          ? "none"
          : shown
            ? `transform 360ms ${SPRING} ${delay}ms, opacity 160ms ease-out ${delay}ms`
            : `transform 180ms ${EASE_IN} ${delay}ms, opacity 150ms ease-in ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900";

/** What every round menu button shares: shape, shadow, hover and press, disabled and focus. */
export function itemBase(shown: boolean): string {
  return `flex size-full flex-col items-center justify-center gap-0.5 rounded-full shadow-md transition-[scale,background-color,color,box-shadow] duration-150 hover:scale-110 active:scale-95 disabled:opacity-40 disabled:hover:scale-100 ${focusRing} ${
    shown ? "pointer-events-auto" : "pointer-events-none"
  }`;
}

/**
 * How a round menu button looks: "selected" is the current tool (filled), "open" is an item
 * whose outer ring is showing (pressed in), "chosen" is the current value on an outer ring
 * (outlined), "danger" is a destructive action.
 */
export const ITEM_LOOKS = {
  plain: "bg-white text-neutral-800 ring-1 ring-black/10 hover:bg-neutral-50",
  selected: "bg-neutral-900 text-white ring-1 ring-neutral-900",
  open: "bg-neutral-200 text-neutral-900 ring-1 ring-black/15",
  chosen: "bg-white text-neutral-900 ring-[2.5px] ring-neutral-900",
  danger: "bg-white text-red-600 ring-1 ring-red-200 hover:bg-red-50",
} as const;

export type ItemLook = keyof typeof ITEM_LOOKS;

export function itemClass(shown: boolean, look: ItemLook): string {
  return `${itemBase(shown)} ${ITEM_LOOKS[look]}`;
}

/** The hub's icons swap with a quarter turn. */
export function hubSwap(shown: boolean, turn: number, reducedMotion: boolean): CSSProperties {
  return {
    opacity: shown ? 1 : 0,
    transform: shown ? "rotate(0deg) scale(1)" : `rotate(${turn}deg) scale(0.6)`,
    transition: reducedMotion ? "none" : `opacity 160ms ease-out, transform 280ms ${SPRING}`,
  };
}

/** The frosted disc behind a menu's main ring. Taps on it, between items, do nothing. */
export function MenuDisc({
  open,
  radius,
  reducedMotion,
}: {
  open: boolean;
  radius: number;
  reducedMotion: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={`absolute left-0 top-0 rounded-full border border-black/5 bg-white/85 shadow-xl backdrop-blur-sm ${
        open ? "pointer-events-auto" : "pointer-events-none"
      }`}
      onPointerDown={(e) => e.preventDefault()}
      style={{
        width: 2 * radius,
        height: 2 * radius,
        transform: `translate(-50%, -50%) scale(${open ? 1 : 0.3})`,
        opacity: open ? 1 : 0,
        transition: reducedMotion
          ? "none"
          : open
            ? `transform 380ms ${SPRING}, opacity 180ms ease-out`
            : `transform 220ms ${EASE_IN} 60ms, opacity 200ms ease-in 60ms`,
      }}
    />
  );
}

/** Arrow keys move focus around the ring that has it (items are marked `data-item`). */
export function moveAroundRing(e: ReactKeyboardEvent<HTMLElement>) {
  const step =
    e.key === "ArrowRight" || e.key === "ArrowDown"
      ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : 0;
  const target = e.target;
  if (step === 0 || !(target instanceof HTMLElement)) return;
  const ring = target.closest("[data-ring]");
  if (!ring) return;
  const items = Array.from(ring.querySelectorAll<HTMLElement>("[data-item]")).filter(
    (item) => !item.matches(":disabled"),
  );
  const index = items.indexOf(target);
  if (index === -1) return;
  e.preventDefault();
  items[(index + step + items.length) % items.length].focus();
}

/** A press on the hub that may turn into a drag. */
interface HubDrag {
  pointerId: number;
  startX: number;
  startY: number;
  from: Point;
  moved: boolean;
}

interface FloatingHubOptions {
  /** Where the hub starts, as fractions (0 to 1) of the room it can move in. */
  initialPlace: Point;
  open: boolean;
  /** How far the open menu reaches from its center, to keep it all on the board. */
  extent: Extent;
}

/**
 * A hub that floats on the board: it tracks the board's size, can be dragged anywhere, and while
 * its menu is open finds a center that keeps the whole menu on the board. Spread
 * `hubPointerHandlers` on the hub button, and start its click handler with `clickEndsDrag()`.
 */
export function useFloatingHub({ initialPlace, open, extent }: FloatingHubOptions) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<BoardSize | null>(null);
  const [place, setPlace] = useState<Point>(initialPlace);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<HubDrag | null>(null);
  const ignoreClickRef = useRef(false);

  // Track the board's size, to keep the hub and the open menu on it.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBoard((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      );
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const rest = board ? restPoint(place, board) : { x: 0, y: 0 };
  const center = board && open ? fitCenter(rest, extent, board) : rest;

  const finishPress = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) return;
    setDragging(false);
    if (cancelled || !board) return;
    // Land exactly where the pointer was let go; the last move event can fall a little short.
    setPlace(
      placeAt({ x: drag.from.x + e.clientX - drag.startX, y: drag.from.y + e.clientY - drag.startY }, board),
    );
    // The click that follows the end of a drag must not toggle the menu.
    ignoreClickRef.current = true;
  };

  const hubPointerHandlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      ignoreClickRef.current = false;
      if (open || !board || e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        from: rest,
        moved: false,
      };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId || !board) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        drag.moved = true;
        setDragging(true);
      }
      setPlace(placeAt({ x: drag.from.x + dx, y: drag.from.y + dy }, board));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finishPress(e, false),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finishPress(e, true),
  };

  /** True (once) if this click is the end of a drag and should be ignored. */
  const clickEndsDrag = () => {
    if (!ignoreClickRef.current) return false;
    ignoreClickRef.current = false;
    return true;
  };

  return { rootRef, board, rest, center, dragging, hubPointerHandlers, clickEndsDrag };
}

interface RadialFrameProps {
  hub: ReturnType<typeof useFloatingHub>;
  open: boolean;
  onClose: () => void;
  reducedMotion: boolean;
  /** The menu's center: a zero-size element everything in the menu is placed around. */
  anchorRef: RefObject<HTMLDivElement | null>;
  /** The menu itself, placed around its center. */
  children: ReactNode;
  /** Anything placed on the board rather than around the menu (the AI menu's status bubble). */
  outside?: ReactNode;
}

/**
 * The layer a floating menu lives in. While open it rises above the other menu, and a tap
 * anywhere else on the board just closes it (it doesn't draw).
 */
export function RadialFrame({
  hub,
  open,
  onClose,
  reducedMotion,
  anchorRef,
  children,
  outside,
}: RadialFrameProps) {
  const { rootRef, board, rest, center } = hub;
  return (
    <div
      ref={rootRef}
      className={`pointer-events-none absolute inset-0 overflow-hidden ${open ? "z-30" : "z-20"}`}
      // Hidden until the board has been measured, so it doesn't flash in the wrong corner.
      style={{ visibility: board ? undefined : "hidden" }}
    >
      {open && (
        <div
          aria-hidden="true"
          className="pointer-events-auto absolute inset-0"
          onPointerDown={(e) => {
            e.preventDefault();
            onClose();
          }}
        />
      )}

      {/*
        The menu's center. It sits where the hub rests, and while open it slides (via the
        transform) just far enough to fit the whole menu on the board.
      */}
      <div
        ref={anchorRef}
        className="absolute"
        onKeyDown={moveAroundRing}
        style={{
          left: rest.x,
          top: rest.y,
          transform: `translate(${center.x - rest.x}px, ${center.y - rest.y}px)`,
          transition: reducedMotion ? "none" : `transform 340ms ${GLIDE}`,
        }}
      >
        {children}
      </div>

      {outside}
    </div>
  );
}
