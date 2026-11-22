"use client";

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { requestCheck, requestGraph, requestSolve, type AiAction, type AiStatus } from "./ai";
import { AnswerCard } from "./AnswerCard";
import { boardReducer, cardSize, INITIAL_BOARD, type CardContent } from "./board";
import { CheckCard } from "./CheckCard";
import { DrawingCanvas } from "./DrawingCanvas";
import { exportInk } from "./exportInk";
import { Graph3DCard } from "./Graph3DCard";
import { GraphCard } from "./GraphCard";
import { placeCard, viewToReveal, type Rect } from "./layout";
import { MistakeMark } from "./MistakeMark";
import { SettingsPanel } from "./SettingsPanel";
import { DEFAULT_SETTINGS, sizeOf, type WhiteboardSettings } from "./settings";
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

      const ink = exportInk(board.strokes, viewport, { numberLines: action === "check" });
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

      <main
        ref={boardRef}
        onWheel={handleWheel}
        className="relative min-w-0 flex-1 overflow-hidden bg-white"
        // Faint dots that move with the board, so you can see it scroll even where it is empty.
        style={{
          backgroundImage: "radial-gradient(circle, #d4d4d4 1px, transparent 1.5px)",
          backgroundSize: "40px 40px",
          backgroundPosition: `${-view.x}px ${-view.y}px`,
        }}
      >
        <DrawingCanvas
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
      </main>

      <SettingsPanel
        settings={settings}
        onSettingsChange={updateSettings}
        canUndo={board.past.length > 0}
        canClear={board.strokes.length > 0 || board.cards.length > 0}
        canResetView={view.x !== 0 || view.y !== 0}
        ai={ai}
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
