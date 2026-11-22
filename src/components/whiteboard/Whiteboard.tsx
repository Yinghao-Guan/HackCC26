"use client";

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import {
  BOARD_CHANNEL,
  isBoardMessage,
  type BoardMessage,
  type CalibrationScreen,
  type ShareRect,
} from "@/lib/boardLink";
import { requestCheck, requestGraph, requestSolve, type AiAction, type AiStatus } from "./ai";
import { AnswerCard } from "./AnswerCard";
import { boardReducer, cardSize, INITIAL_BOARD, type CardContent } from "./board";
import { CalibrationMarkers } from "./CalibrationMarkers";
import { CheckCard } from "./CheckCard";
import { DrawingCanvas, type DrawingCanvasHandle } from "./DrawingCanvas";
import { exportBoardPicture, exportInk, type InkImage } from "./exportInk";
import { FingerUi } from "./fingerUi";
import { Graph3DCard } from "./Graph3DCard";
import { GraphCard } from "./GraphCard";
import { placeCard, viewToReveal, type Rect } from "./layout";
import { MistakeMark } from "./MistakeMark";
import { SettingsPanel } from "./SettingsPanel";
import { boardColor, DEFAULT_SETTINGS, sizeOf, type WhiteboardSettings } from "./settings";
import type { Point, Stroke, StrokeDraft } from "./strokes";
import { TEXT_LINE_HEIGHT } from "./text";
import { TextEditor, type TextEdit } from "./TextEditor";
import { graphFromTypedText } from "./typedGraph";

const ORIGIN: Point = { x: 0, y: 0 };

// The check route accepts at most this many numbered lines.
const MAX_CHECK_LINES = 60;

/** The whole board: a drawing area on the left, a settings panel on the right. */
export function Whiteboard() {
  const [settings, setSettings] = useState<WhiteboardSettings>(DEFAULT_SETTINGS);
  const [board, dispatch] = useReducer(boardReducer, INITIAL_BOARD);
  const [ai, setAi] = useState<AiStatus>({ state: "idle" });
  const [edit, setEdit] = useState<TextEdit | null>(null);
  // Which part of the (endless) board is on screen: the board point at the top-left corner.
  const [view, setView] = useState<Point>(ORIGIN);
  const boardRef = useRef<HTMLElement>(null);
  const canvasHandleRef = useRef<DrawingCanvasHandle>(null);
  // The calibration screen is shown while the camera page works out where this window is.
  const [calibrationScreen, setCalibrationScreen] = useState<CalibrationScreen>("off");
  // A ring that shows where the camera sees the pointer (finger or pen), anywhere in the window.
  const ringRef = useRef<HTMLDivElement>(null);
  // Whether the camera page can read the marker writing on the board, and a way to ask it to.
  const [cameraReady, setCameraReady] = useState(false);
  const cameraReadyRef = useRef(false);
  const requestPictureRef = useRef<((area: ShareRect) => Promise<{ image: string; scale: number }>) | null>(null);
  // The drawing area goes plain for a moment while the camera takes its picture, so it sees only real writing.
  const [blank, setBlank] = useState(false);

  // The text box being edited lives in state (so it renders) and in a ref (so
  // events that arrive out of order always see the latest value).
  const editRef = useRef<TextEdit | null>(null);
  const editKeyRef = useRef(0);
  const setEditing = useCallback((next: TextEdit | null) => {
    editRef.current = next;
    setEdit(next);
  }, []);

  const updateSettings = useCallback(
    (patch: Partial<WhiteboardSettings>) =>
      setSettings((prev) => ({ ...prev, ...patch })),
    [],
  );
  const addStroke = useCallback(
    (stroke: StrokeDraft) => dispatch({ type: "add", stroke }),
    [],
  );
  const removeStrokes = useCallback(
    (ids: number[]) => dispatch({ type: "remove", ids }),
    [],
  );
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);

  const pan = useCallback(
    (dx: number, dy: number) => setView((v) => ({ x: v.x + dx, y: v.y + dy })),
    [],
  );
  const resetView = useCallback(() => setView(ORIGIN), []);

  /** Scroll with the mouse wheel or a trackpad. */
  const handleWheel = (e: WheelEvent<HTMLElement>) => {
    if (e.ctrlKey) return; // a pinch gesture; leave it to the browser
    // Things like the 3D view use the wheel themselves (to zoom).
    if (e.target instanceof Element && e.target.closest("[data-no-pan]")) return;
    const unit = e.deltaMode === 1 ? 16 : 1; // some mouse wheels report lines, not pixels
    pan(e.deltaX * unit, e.deltaY * unit);
  };

  /**
   * Close the text box being edited and keep what was typed. An empty new box
   * is dropped, and emptying an existing one deletes it. Pass the `key` of the
   * box an event came from, so a late event from an older box is ignored.
   */
  const finishEdit = useCallback(
    (key?: number) => {
      const current = editRef.current;
      if (!current || (key !== undefined && key !== current.key)) return;

      setEditing(null);
      const text = current.text.trimEnd();
      if (current.id === null) {
        if (text.trim() === "") return;
        dispatch({
          type: "add",
          stroke: {
            tool: "text",
            color: current.color,
            size: current.size,
            points: [{ x: current.x, y: current.y }],
            text,
          },
        });
      } else {
        dispatch({ type: "setText", id: current.id, text });
      }
    },
    [setEditing],
  );

  /** The text tool was clicked: edit the text under the click, or start a new box there. */
  const startText = useCallback(
    (point: Point, target: Stroke | null) => {
      finishEdit();
      const key = ++editKeyRef.current;

      if (target?.text !== undefined) {
        setEditing({
          key,
          id: target.id,
          x: target.points[0].x,
          y: target.points[0].y,
          text: target.text,
          color: target.color,
          size: target.size,
        });
      } else {
        // Put the first line's middle at the click.
        setEditing({
          key,
          id: null,
          x: point.x,
          y: point.y - (settings.textSize * TEXT_LINE_HEIGHT) / 2,
          text: "",
          color: settings.color,
          size: settings.textSize,
        });
      }
    },
    [finishEdit, setEditing, settings.color, settings.textSize],
  );

  /** Put a card beside the writing it belongs to, and scroll to it if it isn't on screen. */
  const addCard = useCallback(
    (content: CardContent, ink: Rect, viewport: Rect) => {
      const size = cardSize(content);
      const taken = board.cards.map((card) => ({ x: card.x, y: card.y, ...cardSize(card) }));
      const position = placeCard(ink, viewport, taken, size);
      dispatch({ type: "addCard", content, ...position });
      // Use the view as it is now, in case you scrolled while waiting.
      setView((current) =>
        viewToReveal(ink, { ...position, ...size }, { ...viewport, x: current.x, y: current.y }),
      );
    },
    [board.cards],
  );

  /**
   * Have the AI read what is on screen and write its result (an answer, a
   * graph, or a check of your steps) on the board next to the writing.
   */
  const runAi = useCallback(
    async (action: AiAction) => {
      const rect = boardRef.current?.getBoundingClientRect();
      const viewport = {
        x: view.x,
        y: view.y,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
      };

      // Typed equations can be graphed on the spot: no AI, no waiting.
      if (action === "graph") {
        const typed = graphFromTypedText(board.strokes, viewport);
        if (typed) {
          addCard(
            typed.dimension === "3d"
              ? { kind: "graph3d", surfaces: typed.surfaces, points: typed.points, window: typed.window3d }
              : { kind: "graph", curves: typed.curves, window: typed.window },
            typed.ink,
            viewport,
          );
          setAi({ state: "idle" });
          return;
        }
      }

      // What to read: when the camera page is ready, the marker writing on the board (with any marks
      // made with the mouse on top); otherwise the marks made on the board.
      let ink: InkImage | null;
      const requestPicture = requestPictureRef.current;
      if (cameraReadyRef.current && requestPicture && rect) {
        setAi({ state: "capturing", action });
        try {
          const shot = await requestPicture({
            x: rect.left / window.innerWidth,
            y: rect.top / window.innerHeight,
            width: rect.width / window.innerWidth,
            height: rect.height / window.innerHeight,
          });
          ink = await exportBoardPicture(shot.image, shot.scale, board.strokes, viewport, {
            numberLines: action === "check",
          });
        } catch (error) {
          setAi({
            state: "message",
            tone: "error",
            text: error instanceof Error ? error.message : "The camera could not take a picture of the board.",
          });
          return;
        }
        if (!ink) {
          setAi({
            state: "message",
            tone: "info",
            text: "I couldn't see any writing on the board. Write a little larger and darker, inside the drawing area, and keep your hand away while the picture is taken.",
          });
          return;
        }
      } else {
        ink = exportInk(board.strokes, viewport, { numberLines: action === "check" });
      }
      if (!ink) {
        const somethingElsewhere = board.strokes.some((s) => s.tool !== "eraser");
        const nothingYet = {
          solve: "Write a math problem on the board first.",
          graph: "Write an equation on the board first.",
          check: "Write your worked steps on the board first.",
        }[action];
        setAi({
          state: "message",
          tone: "info",
          text: somethingElsewhere
            ? "I read what's on screen. Scroll to your writing and try again."
            : nothingYet,
        });
        return;
      }
      if (action === "check" && ink.lines.length > MAX_CHECK_LINES) {
        setAi({
          state: "message",
          tone: "info",
          text: "That is a lot of lines. Scroll so fewer are on screen and try again.",
        });
        return;
      }

      setAi({ state: "loading", action });
      try {
        let content: CardContent;
        if (action === "solve") {
          const result = await requestSolve(ink.dataUrl);
          if (result.status !== "solved") {
            setAi({ state: "message", tone: "info", text: result.message });
            return;
          }
          content = { kind: "answer", read: result.read, steps: result.steps, answer: result.answer };
        } else if (action === "graph") {
          const result = await requestGraph(ink.dataUrl);
          if (result.status !== "graphed") {
            setAi({ state: "message", tone: "info", text: result.message });
            return;
          }
          content =
            result.dimension === "3d"
              ? { kind: "graph3d", surfaces: result.surfaces, points: result.points, window: result.window3d }
              : { kind: "graph", curves: result.curves, window: result.window };
        } else {
          const result = await requestCheck(ink.dataUrl, ink.lines.length);
          if (result.status === "mistake") {
            content = {
              kind: "check",
              verdict: "mistake",
              step: result.wrongLine,
              // The line numbers on the image are our own, so we know exactly where that line is.
              mark: result.wrongLine ? (ink.lines[result.wrongLine - 1] ?? null) : null,
              explanation: result.explanation,
              correctedLine: result.correctedLine,
              steps: result.steps,
              answer: result.answer,
            };
          } else if (result.status === "correct") {
            content = {
              kind: "check",
              verdict: "correct",
              step: null,
              mark: null,
              explanation: result.explanation,
              correctedLine: "",
              steps: [],
              answer: result.answer,
            };
          } else {
            setAi({ state: "message", tone: "info", text: result.message });
            return;
          }
        }

        addCard(content, ink.bounds, viewport);
        setAi({ state: "idle" });
      } catch (error) {
        setAi({
          state: "message",
          tone: "error",
          text: error instanceof Error ? error.message : "Something went wrong.",
        });
      }
    },
    [board.strokes, view, addCard],
  );
  const solve = useCallback(() => runAi("solve"), [runAi]);
  const graph = useCallback(() => runAi("graph"), [runAi]);
  const check = useCallback(() => runAi("check"), [runAi]);

  // A finger seen by the camera page arrives over a channel (see src/lib/boardLink.ts). It writes on
  // the board like a pen, and presses buttons and drags sliders like a finger on a touch screen.
  useEffect(() => {
    const channel = new BroadcastChannel(BOARD_CHANNEL);
    const finger = new FingerUi();
    // What the pointer is over is reported back to the camera page, at most a few times a second.
    let lastReport = { over: null as string | null, touching: false, at: -Infinity };
    const target = {
      get canvas() {
        return canvasHandleRef.current?.canvas() ?? null;
      },
      draw: (point: Point | null, down: boolean) => canvasHandleRef.current?.finger(point, down),
      ring: (point: Point | null, touching: boolean) => {
        const ring = ringRef.current;
        if (!ring) return;
        if (!point) {
          ring.style.visibility = "hidden";
          return;
        }
        ring.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`;
        ring.style.visibility = "visible";
        ring.dataset.touching = touching ? "true" : "false";
      },
      report: (over: string | null, touching: boolean) => {
        const now = performance.now();
        if (over === lastReport.over && touching === lastReport.touching && now - lastReport.at < 500) return;
        lastReport = { over, touching, at: now };
        const message: BoardMessage = { type: "finger-state", over, touching };
        channel.postMessage(message);
      },
      clicked: (label: string) => {
        const message: BoardMessage = { type: "finger-click", label };
        channel.postMessage(message);
      },
    };

    // If the camera page goes away during calibration, the calibration screen must not stay up for good.
    let markersTimer = 0;

    // Pictures of the marker writing asked of the camera page, by request number.
    const pending = new Map<
      number,
      { resolve: (shot: { image: string; scale: number }) => void; reject: (error: Error) => void; timer: number }
    >();
    let nextId = 1;
    let cameraSeen = -Infinity;
    const setReady = (ready: boolean) => {
      cameraReadyRef.current = ready;
      setCameraReady(ready);
    };
    requestPictureRef.current = (area) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = window.setTimeout(() => {
          pending.delete(id);
          setBlank(false);
          reject(new Error("The camera page did not send a picture. Is it open, with the camera on and calibrated?"));
        }, 12_000);
        pending.set(id, { resolve, reject, timer });
        const request: BoardMessage = { type: "capture-request", id, area };
        channel.postMessage(request);
      });

    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!isBoardMessage(message)) return;

      if (message.type === "camera") {
        cameraSeen = performance.now();
        if (message.ready !== cameraReadyRef.current) setReady(message.ready);
      } else if (message.type === "blank") {
        if (pending.has(message.id)) setBlank(message.on);
      } else if (message.type === "capture" || message.type === "capture-failed") {
        const waiting = pending.get(message.id);
        if (!waiting) return;
        pending.delete(message.id);
        window.clearTimeout(waiting.timer);
        setBlank(false);
        if (message.type === "capture") waiting.resolve({ image: message.image, scale: message.scale });
        else waiting.reject(new Error(message.reason));
      } else if (message.type === "markers") {
        window.clearTimeout(markersTimer);
        setCalibrationScreen(message.screen);
        if (message.screen !== "off") markersTimer = window.setTimeout(() => setCalibrationScreen("off"), 20_000);
      } else if (message.type === "pointer") {
        finger.update(
          message.x * window.innerWidth,
          message.y * window.innerHeight,
          message.writing,
          message.draw,
          target,
        );
      } else if (message.type === "pointer-lost") {
        finger.lost(target);
      }
    };

    // Tell the camera page that this window is here, and how big it is.
    const announce = () => {
      const alive: BoardMessage = { type: "alive", width: window.innerWidth, height: window.innerHeight };
      channel.postMessage(alive);
    };
    announce();
    const timer = window.setInterval(() => {
      announce();
      // The camera page says every second whether it is ready; silence means it is gone.
      if (cameraReadyRef.current && performance.now() - cameraSeen > 2500) setReady(false);
    }, 1000);
    window.addEventListener("resize", announce);

    return () => {
      window.clearInterval(timer);
      window.clearTimeout(markersTimer);
      window.removeEventListener("resize", announce);
      finger.lost(target);
      requestPictureRef.current = null;
      for (const waiting of pending.values()) {
        window.clearTimeout(waiting.timer);
        waiting.reject(new Error("The whiteboard was closed."));
      }
      pending.clear();
      channel.close();
    };
  }, []);

  // Ctrl/Cmd+Z undoes the last change to the board.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Inside a text box, undo means undoing typing, which the browser handles.
      if (e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo]);

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <h1 className="sr-only">HackCC26 whiteboard</h1>

      {calibrationScreen !== "off" && <CalibrationMarkers screen={calibrationScreen} />}

      {/* Where the camera sees the pointer: a light ring (filled while touching), light so it is never taken for a shadow. */}
      <div
        ref={ringRef}
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-40 size-8 rounded-full border-[3px] border-amber-300 data-[touching=true]:bg-amber-200/70"
        style={{ visibility: "hidden" }}
      />

      <main
        ref={boardRef}
        onWheel={handleWheel}
        className="relative min-w-0 flex-1 overflow-hidden"
        // The board can be dimmed to cut projector glare (see BRIGHTNESS_LIMITS). The ink
        // and the image sent to the AI do not depend on it: that image is always on white.
        // Faint dots that move with the board, so you can see it scroll even where it is
        // empty. They are translucent black, so they stay a little darker than any board.
        style={{
          backgroundColor: boardColor(settings.boardBrightness),
          backgroundImage: "radial-gradient(circle, rgba(0, 0, 0, 0.17) 1px, transparent 1.5px)",
          backgroundSize: "40px 40px",
          backgroundPosition: `${-view.x}px ${-view.y}px`,
        }}
      >
        <DrawingCanvas
          ref={canvasHandleRef}
          strokes={board.strokes}
          tool={settings.tool}
          eraserMode={settings.eraserMode}
          color={settings.color}
          size={sizeOf(settings)}
          view={view}
          hiddenId={edit?.id ?? null}
          onStrokeComplete={addStroke}
          onStrokesErase={removeStrokes}
          onTextClick={startText}
          onPan={pan}
        />

        {/* Things placed at board points (the text box and AI cards) scroll with the board. */}
        <div
          className="absolute left-0 top-0"
          style={{ transform: `translate(${-view.x}px, ${-view.y}px)` }}
        >
          {edit && (
            <TextEditor
              key={edit.key}
              edit={edit}
              onChange={(text) => setEditing({ ...edit, text })}
              onFinish={() => finishEdit(edit.key)}
            />
          )}

          {board.cards.map((card) => {
            const dismiss = () => dispatch({ type: "removeCard", id: card.id });
            switch (card.kind) {
              case "answer":
                return <AnswerCard key={card.id} card={card} onDismiss={dismiss} />;
              case "graph":
                return <GraphCard key={card.id} card={card} onDismiss={dismiss} />;
              case "graph3d":
                return <Graph3DCard key={card.id} card={card} onDismiss={dismiss} />;
              case "check":
                return (
                  <div key={card.id}>
                    {card.mark && <MistakeMark box={card.mark} step={card.step} />}
                    <CheckCard card={card} onDismiss={dismiss} />
                  </div>
                );
            }
          })}
        </div>

        {/* Plain board color over everything while the camera takes its picture of the marker writing. */}
        {blank && (
          <div
            aria-hidden="true"
            className="absolute inset-0 z-40"
            style={{ backgroundColor: boardColor(settings.boardBrightness) }}
          />
        )}
      </main>

      <SettingsPanel
        settings={settings}
        onSettingsChange={updateSettings}
        canUndo={board.past.length > 0}
        canClear={board.strokes.length > 0 || board.cards.length > 0}
        canResetView={view.x !== 0 || view.y !== 0}
        ai={ai}
        cameraReady={cameraReady}
        onSolve={solve}
        onGraph={graph}
        onCheck={check}
        onUndo={undo}
        onClear={clear}
        onResetView={resetView}
      />
    </div>
  );
}
