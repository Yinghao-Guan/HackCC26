"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { EraserMode, Tool } from "./settings";
import {
  findTextAt,
  paintStroke,
  paintStrokeTail,
  strokeTouchesCircle,
  type Point,
  type Stroke,
  type StrokeDraft,
} from "./strokes";

interface DrawingCanvasProps {
  /** Finished marks (strokes and text), oldest first. */
  strokes: Stroke[];
  /** Style applied to the next gesture. */
  tool: Tool;
  eraserMode: EraserMode;
  color: string;
  size: number;
  /** The board point shown at the top-left corner of the screen. Marks are stored in board points. */
  view: Point;
  /** A piece of text that is being edited elsewhere, so it should not be painted here. */
  hiddenId: number | null;
  onStrokeComplete: (stroke: StrokeDraft) => void;
  /** Called once per erase gesture with every mark it removed. */
  onStrokesErase: (ids: number[]) => void;
  /** The text tool was clicked. `target` is the text under the click, if any. */
  onTextClick: (point: Point, target: Stroke | null) => void;
  /** The board was dragged: move the view by this many screen pixels. */
  onPan: (dx: number, dy: number) => void;
}

/** What the active pointer is doing between pointer down and pointer up. */
type Gesture =
  | { kind: "draw"; pointerId: number; stroke: StrokeDraft }
  | { kind: "erase"; pointerId: number; last: Point; erased: Set<number> }
  | { kind: "pan"; pointerId: number; lastX: number; lastY: number };

/** Where a pointer event is on the screen, relative to the canvas. */
function screenPoint(
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/** Where a pointer event is on the board, which may be scrolled. */
function boardPoint(
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
  view: Point,
): Point {
  const p = screenPoint(canvas, event);
  return { x: p.x + view.x, y: p.y + view.y };
}

export function DrawingCanvas({
  strokes,
  tool,
  eraserMode,
  color,
  size,
  view,
  hiddenId,
  onStrokeComplete,
  onStrokesErase,
  onTextClick,
  onPan,
}: DrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const eraserCursorRef = useRef<HTMLDivElement>(null);
  const strokesRef = useRef(strokes);
  const viewRef = useRef(view);
  const hiddenIdRef = useRef(hiddenId);
  const gestureRef = useRef<Gesture | null>(null);

  /** Clear the canvas and repaint every mark from data. */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    // Match the pixel buffer to the displayed size and the screen's density.
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * dpr);
    const height = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Marks are in board points; shift them by the scroll position (this stays
    // set, so live drawing in `paintStrokeTail` lines up too).
    const { x, y } = viewRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, -x * dpr, -y * dpr);

    // Marks the stroke eraser has touched disappear right away; they are only
    // removed from the board's data when the gesture ends.
    const gesture = gestureRef.current;
    const erased = gesture?.kind === "erase" ? gesture.erased : null;

    for (const stroke of strokesRef.current) {
      if (erased?.has(stroke.id) || stroke.id === hiddenIdRef.current) continue;
      paintStroke(ctx, stroke);
    }
    if (gesture?.kind === "draw") paintStroke(ctx, gesture.stroke);
  }, []);

  // Repaint whenever the marks or the scroll position change.
  useLayoutEffect(() => {
    strokesRef.current = strokes;
    viewRef.current = view;
    hiddenIdRef.current = hiddenId;
    redraw();
  }, [strokes, view, hiddenId, redraw]);

  // Repaint when the board is resized (resizing clears a canvas).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  /** Show the eraser circle under the pointer. Moved directly, not via state. */
  const moveEraserCursor = (point: Point) => {
    const cursor = eraserCursorRef.current;
    if (!cursor) return;
    cursor.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`;
    cursor.style.visibility = "visible";
  };

  const hideEraserCursor = () => {
    const cursor = eraserCursorRef.current;
    if (cursor) cursor.style.visibility = "hidden";
  };

  /**
   * Remove every pen stroke and piece of text the eraser circle touches while
   * moving from the gesture's last point to `to`. Returns true if anything new
   * was erased.
   */
  const eraseAlong = (
    gesture: Extract<Gesture, { kind: "erase" }>,
    to: Point,
    radius: number,
  ): boolean => {
    const from = gesture.last;
    // Fast movement skips points, so test along the path in small steps.
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(2, radius / 2)));

    let changed = false;
    for (let i = 1; i <= steps; i++) {
      const center = {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      };
      for (const stroke of strokesRef.current) {
        // Pixel-eraser cuts are not ink, so only pen strokes and text can be removed.
        if (stroke.tool === "eraser" || gesture.erased.has(stroke.id)) continue;
        if (strokeTouchesCircle(stroke, center, radius)) {
          gesture.erased.add(stroke.id);
          changed = true;
        }
      }
    }

    gesture.last = to;
    return changed;
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (gestureRef.current) return; // one gesture at a time

    // Left button draws; the middle mouse button always moves the board.
    const middleButton = e.pointerType === "mouse" && e.button === 1;
    if (e.button !== 0 && !middleButton) return;

    const canvas = e.currentTarget;

    if (tool === "move" || middleButton) {
      e.preventDefault(); // no autoscroll on middle click
      canvas.setPointerCapture(e.pointerId);
      gestureRef.current = {
        kind: "pan",
        pointerId: e.pointerId,
        lastX: e.clientX,
        lastY: e.clientY,
      };
      canvas.style.cursor = "grabbing";
      return;
    }

    const point = boardPoint(canvas, e, viewRef.current);

    if (tool === "text") {
      // Don't let this click move focus away from the text box it opens.
      e.preventDefault();
      onTextClick(point, findTextAt(strokesRef.current, point));
      return;
    }

    canvas.setPointerCapture(e.pointerId);

    if (tool === "eraser" && eraserMode === "stroke") {
      const gesture: Gesture = {
        kind: "erase",
        pointerId: e.pointerId,
        last: point,
        erased: new Set(),
      };
      gestureRef.current = gesture;
      if (eraseAlong(gesture, point, size / 2)) redraw();
      return;
    }

    const stroke: StrokeDraft = { tool, color, size, points: [point] };
    gestureRef.current = { kind: "draw", pointerId: e.pointerId, stroke };

    const ctx = canvas.getContext("2d");
    if (ctx) paintStrokeTail(ctx, stroke);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    if (tool === "eraser") moveEraserCursor(screenPoint(canvas, e));

    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== e.pointerId) return;

    if (gesture.kind === "pan") {
      // Dragging the board right shows what is to the left, so the view moves the other way.
      onPan(gesture.lastX - e.clientX, gesture.lastY - e.clientY);
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
      return;
    }

    // Browsers batch fast movement into one event; use every sample so quick
    // strokes stay smooth.
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const samples = coalesced.length > 0 ? coalesced : [e.nativeEvent];
    const currentView = viewRef.current;

    if (gesture.kind === "draw") {
      const ctx = canvas.getContext("2d");
      for (const sample of samples) {
        gesture.stroke.points.push(boardPoint(canvas, sample, currentView));
        if (ctx) paintStrokeTail(ctx, gesture.stroke);
      }
    } else {
      let changed = false;
      for (const sample of samples) {
        if (eraseAlong(gesture, boardPoint(canvas, sample, currentView), size / 2)) {
          changed = true;
        }
      }
      if (changed) redraw();
    }
  };

  const finishGesture = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== e.pointerId) return;

    gestureRef.current = null;
    if (gesture.kind === "draw") {
      onStrokeComplete(gesture.stroke);
    } else if (gesture.kind === "erase" && gesture.erased.size > 0) {
      onStrokesErase([...gesture.erased]);
    } else if (gesture.kind === "pan") {
      e.currentTarget.style.cursor = ""; // back to the tool's own cursor
    }

    // A finger has no hover, so the circle should not linger after a touch.
    if (e.pointerType === "touch") hideEraserCursor();
  };

  const cursorClass =
    tool === "eraser"
      ? "cursor-none"
      : tool === "text"
        ? "cursor-text"
        : tool === "move"
          ? "cursor-grab"
          : "cursor-crosshair";

  return (
    <div className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Whiteboard drawing area"
        // The eraser draws its own circle, so hide the system cursor for it.
        className={`block h-full w-full touch-none select-none ${cursorClass}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onPointerLeave={hideEraserCursor}
      />

      {tool === "eraser" && (
        <div
          ref={eraserCursorRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 rounded-full border-[1.5px] border-neutral-600 bg-neutral-900/5"
          style={{ width: size, height: size, visibility: "hidden" }}
        />
      )}
    </div>
  );
}
