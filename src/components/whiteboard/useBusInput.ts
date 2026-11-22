"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { BusFeedbackHandle } from "./BusFeedback";
import type { BusEvent } from "./cvBus";
import type { DrawingCanvasHandle } from "./DrawingCanvas";
import { plot3DNear, type Plot3DControls } from "./plot3dControls";

// A touch the camera has said nothing about for this long has ended (the hand left the view).
const LOST_MS = 500;
// A touch on a button counts as a tap if it is released within this long...
const TAP_MAX_MS = 1500;
// ...and the same element is not tapped again this soon (a flickering touch is one tap).
const TAP_REPEAT_MS = 500;

/** What a finger touching the board is doing, decided by what it first touched. */
type Contact =
  | { kind: "draw" }
  | { kind: "tap"; target: Element; startedAt: number }
  | { kind: "turn"; plot: Plot3DControls }
  | { kind: "none" };

interface Touch {
  contact: Contact;
  x: number;
  y: number;
  lastSeen: number;
}

interface BusInputOptions {
  canvas: RefObject<DrawingCanvasHandle | null>;
  feedback: RefObject<BusFeedbackHandle | null>;
  /** Move the view by this many screen pixels (like dragging the board the other way). */
  pan: (dx: number, dy: number) => void;
  /** Pen to eraser, or eraser to pen. */
  toggleTool: () => void;
  /** Back to the start: board position and every 3D angle. Never touches the writing. */
  resetView: () => void;
}

/**
 * Turn the camera service's pointer and gesture events into board actions:
 * - a finger touching the board draws (or erases); touching a button taps it; touching
 *   a 3D graph turns it.
 * - double tap: pen and eraser; fist: move the board; pinch and hold: turn a 3D graph;
 *   pinch with both hands: zoom a 3D graph; both hands open for 2 s: reset the view.
 * Gives the function to call with each event.
 */
export function useBusInput(options: BusInputOptions): (event: BusEvent) => void {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const touches = useRef(new Map<number, Touch>());
  const lastTaps = useRef(new WeakMap<Element, number>());
  const turning = useRef<Plot3DControls | null>(null);
  const zooming = useRef<{ plot: Plot3DControls; startDistance: number } | null>(null);

  /** Where a screen point is relative to the drawing canvas. */
  const onCanvas = (canvas: HTMLCanvasElement, x: number, y: number) => {
    const box = canvas.getBoundingClientRect();
    return { x: x - box.left, y: y - box.top };
  };

  /** A finger touched the board: decide what this touch does from what is under it. */
  const startContact = useCallback((id: number, x: number, y: number): Contact => {
    const canvas = latest.current.canvas.current;
    const board = canvas?.element();
    const under = document.elementFromPoint(x, y);

    if (canvas && board && under === board) {
      canvas.touchStart(id, onCanvas(board, x, y));
      return { kind: "draw" };
    }
    if (under?.closest("[data-plot3d]")) {
      const plot = plot3DNear(x, y);
      if (plot) return { kind: "turn", plot };
    }
    if (under) {
      const target = under.closest("button, a, [role='button']") ?? under;
      return { kind: "tap", target, startedAt: performance.now() };
    }
    return { kind: "none" };
  }, []);

  /** The finger let go (`released`) or the camera lost it. */
  const endContact = useCallback((id: number, released: boolean) => {
    const touch = touches.current.get(id);
    if (!touch) return;
    touches.current.delete(id);
    const { contact } = touch;

    if (contact.kind === "draw") {
      latest.current.canvas.current?.touchEnd(id);
    } else if (contact.kind === "tap" && released) {
      const now = performance.now();
      const under = document.elementFromPoint(touch.x, touch.y);
      const stillOnIt = under !== null && contact.target.contains(under);
      const quick = now - contact.startedAt <= TAP_MAX_MS;
      const repeat = now - (lastTaps.current.get(contact.target) ?? -Infinity) < TAP_REPEAT_MS;
      if (stillOnIt && quick && !repeat) {
        lastTaps.current.set(contact.target, now);
        // A real click event, so React handlers and links work as they do for a mouse.
        contact.target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
    }
    if (!released) latest.current.feedback.current?.hidePointer();
  }, []);

  // End touches the camera stopped reporting, so a stroke is never left hanging.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = performance.now();
      for (const [id, touch] of touches.current) {
        if (now - touch.lastSeen > LOST_MS) endContact(id, false);
      }
    }, 200);
    return () => clearInterval(timer);
  }, [endContact]);

  return useCallback(
    (event: BusEvent) => {
      const { canvas, feedback, pan, toggleTool, resetView } = latest.current;
      const show = feedback.current;

      switch (event.type) {
        case "pointer": {
          show?.pointer(event.x, event.y, event.touching);
          const touch = touches.current.get(event.id);
          if (!event.touching) {
            if (touch) endContact(event.id, true);
            return;
          }
          const now = performance.now();
          if (!touch) {
            const contact = startContact(event.id, event.x, event.y);
            touches.current.set(event.id, { contact, x: event.x, y: event.y, lastSeen: now });
            return;
          }
          const dx = event.x - touch.x;
          const dy = event.y - touch.y;
          touch.x = event.x;
          touch.y = event.y;
          touch.lastSeen = now;
          const board = canvas.current?.element();
          if (touch.contact.kind === "draw" && board) {
            canvas.current?.touchMove(event.id, onCanvas(board, event.x, event.y));
          } else if (touch.contact.kind === "turn") {
            touch.contact.plot.rotate(dx, dy);
          }
          return;
        }

        case "gesture":
          if (event.name === "double_tap") toggleTool();
          if (event.name === "reset") {
            show?.ring(0);
            resetView();
            show?.hint("View reset", 1200);
          }
          return;

        case "reset_progress":
          show?.ring(event.progress);
          return;

        case "pan":
          // The board follows the fist, so the view moves the other way.
          if (event.phase === "start") show?.hint("Moving the board");
          else if (event.phase === "move") pan(-event.dx, -event.dy);
          else show?.hint(null);
          return;

        case "rotate":
          if (event.phase === "start") {
            turning.current = event.x !== null && event.y !== null ? plot3DNear(event.x, event.y) : null;
            show?.hint(turning.current ? "Turning the 3D graph" : "Pinch over a 3D graph to turn it", turning.current ? undefined : 2000);
          } else if (event.phase === "move") {
            turning.current?.rotate(event.dx, event.dy);
          } else {
            if (turning.current) show?.hint(null);
            turning.current = null;
          }
          return;

        case "zoom":
          if (event.phase === "start") {
            const plot = event.cx !== null && event.cy !== null ? plot3DNear(event.cx, event.cy) : null;
            zooming.current = plot ? { plot, startDistance: plot.distance() } : null;
            show?.hint(plot ? "Zooming the 3D graph" : "Two-hand zoom works on 3D graphs", plot ? undefined : 2000);
          } else if (event.phase === "move" && zooming.current) {
            // Hands apart (scale above 1) brings the camera closer.
            zooming.current.plot.setDistance(zooming.current.startDistance / event.scale);
          } else if (event.phase === "end") {
            if (zooming.current) show?.hint(null);
            zooming.current = null;
          }
          return;

        default:
          return;
      }
    },
    [startContact, endContact],
  );
}
