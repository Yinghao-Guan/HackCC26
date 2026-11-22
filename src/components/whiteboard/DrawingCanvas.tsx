"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type Ref,
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
  ref?: Ref<DrawingCanvasHandle>;
}

/** What the board's owner can ask of the canvas. */
export interface DrawingCanvasHandle {
  /**
   * A finger seen by the camera: where its tip is on the canvas (in screen pixels,
   * relative to the canvas), or null if it is gone, and whether it is touching the board.
   */
  finger: (point: Point | null, down: boolean) => void;
  /** The canvas element, to tell what is under a point. */
  canvas: () => HTMLCanvasElement | null;
}

/** The pointer id used for the gesture of a finger seen by the camera: real pointers have ids of 0 or more. */
const FINGER = -1;

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
  ref,
}: DrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const eraserCursorRef = useRef<HTMLDivElement>(null);
  const fingerDotRef = useRef<HTMLDivElement>(null);
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

  /**
   * Start a gesture at a point on the canvas (in screen pixels). `capture` is for
   * real pointers only: it asks the browser to keep sending their events here.
   */
  const beginGesture = (
    pointerId: number,
    screen: Point,
    options: { middleButton?: boolean; capture?: () => void } = {},
  ) => {
    if (gestureRef.current) return; // one gesture at a time
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (tool === "move" || options.middleButton) {
      options.capture?.();
      gestureRef.current = { kind: "pan", pointerId, lastX: screen.x, lastY: screen.y };
      canvas.style.cursor = "grabbing";
      return;
    }

    const point = { x: screen.x + viewRef.current.x, y: screen.y + viewRef.current.y };

    if (tool === "text") {
      onTextClick(point, findTextAt(strokesRef.current, point));
      return;
    }

    options.capture?.();

    if (tool === "eraser" && eraserMode === "stroke") {
      const gesture: Gesture = { kind: "erase", pointerId, last: point, erased: new Set() };
      gestureRef.current = gesture;
      if (eraseAlong(gesture, point, size / 2)) redraw();
      return;
    }

    const stroke: StrokeDraft = { tool, color, size, points: [point] };
    gestureRef.current = { kind: "draw", pointerId, stroke };

    const ctx = canvas.getContext("2d");
    if (ctx) paintStrokeTail(ctx, stroke);
  };

  /** Carry on a pointer's gesture through some new points on the canvas (in screen pixels). */
  const continueGesture = (pointerId: number, screens: Point[]) => {
    const gesture = gestureRef.current;
    const canvas = canvasRef.current;
    if (!gesture || !canvas || gesture.pointerId !== pointerId || screens.length === 0) return;

    if (gesture.kind === "pan") {
      const last = screens[screens.length - 1];
      // Dragging the board right shows what is to the left, so the view moves the other way.
      onPan(gesture.lastX - last.x, gesture.lastY - last.y);
      gesture.lastX = last.x;
      gesture.lastY = last.y;
      return;
    }

    const { x: viewX, y: viewY } = viewRef.current;
    const points = screens.map((screen) => ({ x: screen.x + viewX, y: screen.y + viewY }));

    if (gesture.kind === "draw") {
      const ctx = canvas.getContext("2d");
      for (const point of points) {
        gesture.stroke.points.push(point);
        if (ctx) paintStrokeTail(ctx, gesture.stroke);
      }
    } else {
      let changed = false;
      for (const point of points) {
        if (eraseAlong(gesture, point, size / 2)) changed = true;
      }
      if (changed) redraw();
    }
  };

  /** End a pointer's gesture: a stroke is finished, or what the eraser touched is removed. */
  const endGesture = (pointerId: number) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== pointerId) return;

    gestureRef.current = null;
    if (gesture.kind === "draw") {
      onStrokeComplete(gesture.stroke);
    } else if (gesture.kind === "erase" && gesture.erased.size > 0) {
      onStrokesErase([...gesture.erased]);
    } else if (gesture.kind === "pan" && canvasRef.current) {
      canvasRef.current.style.cursor = ""; // back to the tool's own cursor
    }
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    // Left button draws; the middle mouse button always moves the board.
    const middleButton = e.pointerType === "mouse" && e.button === 1;
    if (e.button !== 0 && !middleButton) return;

    // No autoscroll on middle click, and a click for text must not move focus away from the text box it opens.
    if (tool === "move" || middleButton || tool === "text") e.preventDefault();

    const canvas = e.currentTarget;
    beginGesture(e.pointerId, screenPoint(canvas, e), {
      middleButton,
      capture: () => canvas.setPointerCapture(e.pointerId),
    });
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    if (tool === "eraser") moveEraserCursor(screenPoint(canvas, e));

    // Browsers batch fast movement into one event; use every sample so quick
    // strokes stay smooth.
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const samples = coalesced.length > 0 ? coalesced : [e.nativeEvent];
    continueGesture(
      e.pointerId,
      samples.map((sample) => screenPoint(canvas, sample)),
    );
  };

  const finishGesture = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    endGesture(e.pointerId);

    // A finger has no hover, so the circle should not linger after a touch.
    if (e.pointerType === "touch") hideEraserCursor();
  };

  /**
   * A finger seen by the camera, as a pen: `point` is where its tip is on the
   * canvas (in screen pixels), or null if it is gone, and `down` is whether it
   * is touching the board. It draws, erases and moves the board like the mouse does,
   * and a bright dot shows where it is when it is not erasing.
   */
  const finger = (point: Point | null, down: boolean) => {
    const dot = fingerDotRef.current;
    if (!point) {
      endGesture(FINGER);
      hideEraserCursor();
      if (dot) dot.style.visibility = "hidden";
      return;
    }

    if (tool === "eraser") {
      moveEraserCursor(point);
      if (dot) dot.style.visibility = "hidden";
    } else if (dot) {
      dot.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`;
      dot.style.visibility = "visible";
      dot.dataset.down = down ? "true" : "false";
    }

    const ours = gestureRef.current?.pointerId === FINGER;
    if (down && !ours) beginGesture(FINGER, point);
    else if (down && ours) continueGesture(FINGER, [point]);
    else if (!down && ours) endGesture(FINGER);
  };

  useImperativeHandle(ref, () => ({ finger, canvas: () => canvasRef.current }));

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

      {/* Where the finger is, as a bright ring (filled while it writes). Bright, so it is never taken for a shadow. */}
      <div
        ref={fingerDotRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 size-6 rounded-full border-[3px] border-white data-[down=true]:bg-white"
        style={{ visibility: "hidden" }}
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
