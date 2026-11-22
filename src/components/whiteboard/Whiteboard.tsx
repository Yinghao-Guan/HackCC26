"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { parseSpoken, type VoiceCommand } from "@/lib/voice";
import { ActionDial } from "./ActionDial";
import {
  requestAsk,
  requestCheck,
  requestGraph,
  requestSolve,
  type AiAction,
  type AiStatus,
  type VoiceStatus,
} from "./ai";
import { AnswerCard } from "./AnswerCard";
import { boardReducer, cardSize, INITIAL_BOARD, type CardContent } from "./board";
import { BusFeedback, type BusFeedbackHandle } from "./BusFeedback";
import { CalibrationLayer, type Probe } from "./CalibrationLayer";
import { CheckCard } from "./CheckCard";
import { useCvBus, type BusEvent, type Marker, type Target } from "./cvBus";
import { CvStatus } from "./CvStatus";
import { DrawingCanvas, type DrawingCanvasHandle } from "./DrawingCanvas";
import { exportInk } from "./exportInk";
import { Graph3DCard } from "./Graph3DCard";
import { GraphCard } from "./GraphCard";
import { placeCard, viewToReveal, type Rect } from "./layout";
import { MistakeMark, mistakeMarkArea } from "./MistakeMark";
import { resetAllPlots3D } from "./plot3dControls";
import { ReplyCard } from "./ReplyCard";
import type { Point, StrokeDraft } from "./strokes";
import { useBusInput } from "./useBusInput";
import { useSpeechRecognition } from "./useSpeechRecognition";

const ORIGIN: Point = { x: 0, y: 0 };

// The board is drawn with a single, fixed pen: no tool or color picker. A double tap in the
// air (seen by the camera service) swaps it for an eraser that removes whole strokes.
const PEN_COLOR = "#171717";
const PEN_SIZE = 4;
const ERASER_SIZE = 48;
// A check cross from calibration stays this long.
const PROBE_MS = 4000;

// What the panel says when a spoken command is understood.
const VOICE_REPLIES: Record<VoiceCommand, string> = {
  solve: "Solving what's on the board.",
  graph: "Graphing what's on the board.",
  check: "Checking your steps.",
  undo: "Undid the last change.",
};

// Keys for running the board from the laptop, for when a tap on the projected board misses.
const KEYS: [string, string][] = [
  ["S", "Solve"],
  ["G", "Graph"],
  ["C", "Check"],
  ["V", "Speak (again to stop)"],
  ["E", "Pen or eraser"],
  ["R", "Reset the view"],
  ["⌘Z", "Undo"],
  ["?", "Show or hide these keys"],
];

// The check route accepts at most this many numbered lines.
const MAX_CHECK_LINES = 60;

/** Nothing is listening for a text click: the board only ever draws with the pen. */
function ignoreTextClick(): void {}

/** The whole board: a full-bleed drawing area with one circular dial for the AI actions. */
export function Whiteboard() {
  const [board, dispatch] = useReducer(boardReducer, INITIAL_BOARD);
  const [ai, setAi] = useState<AiStatus>({ state: "idle" });
  const [voice, setVoice] = useState<VoiceStatus>({ state: "idle" });
  // Which part of the (endless) board is on screen: the board point at the top-left corner.
  const [view, setView] = useState<Point>(ORIGIN);
  const boardRef = useRef<HTMLElement>(null);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const canvasRef = useRef<DrawingCanvasHandle>(null);
  const feedbackRef = useRef<BusFeedbackHandle>(null);
  // What the camera service asks the board to show while calibrating.
  const [pattern, setPattern] = useState<{ run: number; markers: Marker[] } | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [probes, setProbes] = useState<Probe[]>([]);
  const probeKey = useRef(0);

  const addStroke = useCallback(
    (stroke: StrokeDraft) => dispatch({ type: "add", stroke }),
    [],
  );
  const removeStrokes = useCallback(
    (ids: number[]) => dispatch({ type: "remove", ids }),
    [],
  );
  const undo = useCallback(() => dispatch({ type: "undo" }), []);

  const pan = useCallback(
    (dx: number, dy: number) => setView((v) => ({ x: v.x + dx, y: v.y + dy })),
    [],
  );

  /** Back to the start: board position and every 3D angle. The writing stays as it is. */
  const resetView = useCallback(() => {
    setView(ORIGIN);
    resetAllPlots3D();
  }, []);

  const chooseTool = useCallback((next: "pen" | "eraser") => {
    setTool(next);
    feedbackRef.current?.hint(next === "eraser" ? "Eraser" : "Pen", 1200);
  }, []);
  const toggleTool = useCallback(
    () => chooseTool(tool === "eraser" ? "pen" : "eraser"),
    [chooseTool, tool],
  );

  /** Scroll with the mouse wheel or a trackpad. */
  const handleWheel = (e: WheelEvent<HTMLElement>) => {
    if (e.ctrlKey) return; // a pinch gesture; leave it to the browser
    // Things like the 3D view use the wheel themselves (to zoom).
    if (e.target instanceof Element && e.target.closest("[data-no-pan]")) return;
    const unit = e.deltaMode === 1 ? 16 : 1; // some mouse wheels report lines, not pixels
    pan(e.deltaX * unit, e.deltaY * unit);
  };

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

        // A circled line has a "Step N" tag to its right: the card goes beside that, not over it.
        let near = ink.bounds;
        if (content.kind === "check" && content.mark) {
          const area = mistakeMarkArea(content.mark);
          const left = Math.min(near.x, area.x);
          const top = Math.min(near.y, area.y);
          near = {
            x: left,
            y: top,
            width: Math.max(near.x + near.width, area.x + area.width) - left,
            height: Math.max(near.y + near.height, area.y + area.height) - top,
          };
        }
        addCard(content, near, viewport);
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

  /**
   * Ask the AI a question and write its answer on the board. If something is written on
   * screen it is shown too, in case the question is about it ("explain this step").
   */
  const askAi = useCallback(
    async (question: string) => {
      const rect = boardRef.current?.getBoundingClientRect();
      const viewport = {
        x: view.x,
        y: view.y,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
      };
      const ink = exportInk(board.strokes, viewport);

      // Update the line in the Voice section that says what is happening with this question.
      const say = (text: string) =>
        setVoice((current) =>
          current.state === "message" && current.heard === question ? { ...current, text } : current,
        );

      setAi({ state: "loading", action: "ask" });
      try {
        const result = await requestAsk(question, ink?.dataUrl ?? null);
        // With nothing written, put the answer near the top-left of what you are looking at.
        const near = ink?.bounds ?? { x: viewport.x + 16, y: viewport.y + 16, width: 0, height: 0 };
        addCard({ kind: "reply", question, blocks: result.blocks }, near, viewport);
        setAi({ state: "idle" });
        say("Answered on the board.");
      } catch (error) {
        setAi({
          state: "message",
          tone: "error",
          text: error instanceof Error ? error.message : "Something went wrong.",
        });
        say("Couldn't answer that. See the message above.");
      }
    },
    [board.strokes, view, addCard],
  );

  /** Something was said: do what it asks for, or if it is a question, answer it. */
  const handleSpeech = useCallback(
    (firstGuess: string, otherGuesses: string[]) => {
      let heard = firstGuess;
      let spoken = parseSpoken(heard);
      // A short phrase that is neither a command nor a question was probably misheard ("soul
      // this"). If one of the recognizer's other guesses is a command, go with that.
      if (spoken.kind === "unknown") {
        for (const guess of otherGuesses) {
          const other = parseSpoken(guess);
          if (other.kind === "command") {
            heard = guess;
            spoken = other;
            break;
          }
        }
      }
      if (spoken.kind === "unknown") {
        setVoice({
          state: "message",
          tone: "info",
          heard,
          text: "I didn't catch a command or a question. Try “solve this”, “graph this”, “check my work”, or ask a question.",
        });
        return;
      }

      const undoing = spoken.kind === "command" && spoken.command === "undo";
      if (!undoing && ai.state === "loading") {
        setVoice({
          state: "message",
          tone: "info",
          heard,
          text: "Still working on the last request. Try again in a moment.",
        });
        return;
      }

      if (spoken.kind === "question") {
        setVoice({ state: "message", tone: "info", heard, text: "Thinking about your question." });
        void askAi(heard);
        return;
      }
      setVoice({ state: "message", tone: "info", heard, text: VOICE_REPLIES[spoken.command] });
      if (spoken.command === "undo") undo();
      else void runAi(spoken.command);
    },
    [ai.state, askAi, runAi, undo],
  );

  const {
    listening,
    hearing,
    start: startListening,
    stop: stopListening,
  } = useSpeechRecognition({
    onSpeech: handleSpeech,
    onProblem: (text, tone) => setVoice({ state: "message", tone, text }),
  });
  const toggleVoice = useCallback(() => {
    if (listening) {
      stopListening();
    } else if (startListening()) {
      // Only clear the last message once listening has really begun, so a stray tap doesn't erase it.
      setVoice({ state: "idle" });
    }
  }, [listening, startListening, stopListening]);

  // The camera service: a finger on the board, hand gestures, and calibration.
  const handleBusInput = useBusInput({ canvas: canvasRef, feedback: feedbackRef, pan, toggleTool, resetView });
  const handleBusEvent = useCallback(
    (event: BusEvent) => {
      if (event.type === "calibration_pattern") {
        setPattern(event.markers.length > 0 ? { run: event.run, markers: event.markers } : null);
      } else if (event.type === "calibration_targets") {
        setTargets(event.targets);
      } else if (event.type === "calibration_probe") {
        const probe = { key: ++probeKey.current, x: event.x, y: event.y };
        setProbes((current) => [...current, probe]);
        setTimeout(() => setProbes((current) => current.filter((p) => p !== probe)), PROBE_MS);
      } else {
        handleBusInput(event);
      }
    },
    [handleBusInput],
  );
  const { enabled: busEnabled, status: busStatus, send: busSend } = useCvBus(handleBusEvent);
  const showPatternDone = useCallback(
    (run: number) => busSend({ type: "calibration_pattern_shown", run }),
    [busSend],
  );
  // Calibration needs the board clear, so the controls step aside while it shows things.
  const calibrating = pattern !== null || targets.length > 0;

  // Keys (see KEYS): someone at the laptop can run the board when a tap on the projected
  // board misses. Ctrl/Cmd+Z undoes the last change.
  const [showKeys, setShowKeys] = useState(false);
  const keyActions = useRef({ solve, graph, check, toggleVoice, toggleTool, resetView, undo, busy: false });
  useEffect(() => {
    keyActions.current = {
      solve,
      graph,
      check,
      toggleVoice,
      toggleTool,
      resetView,
      undo,
      // Working on something (asking the AI, or waiting for a picture of the board).
      busy: ai.state !== "idle" && ai.state !== "message",
    };
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const actions = keyActions.current;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        actions.undo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const target = e.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;

      const key = e.key.toLowerCase();
      const aiAction = ({ s: actions.solve, g: actions.graph, c: actions.check } as Record<string, (() => void) | undefined>)[key];
      if (aiAction) {
        if (!actions.busy) aiAction();
      } else if (key === "v") actions.toggleVoice();
      else if (key === "e") actions.toggleTool();
      else if (key === "r") actions.resetView();
      else if (key === "?") setShowKeys((shown) => !shown);
      else if (key === "escape") setShowKeys(false);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <h1 className="sr-only">HackCC26 whiteboard</h1>

      <main
        ref={boardRef}
        onWheel={handleWheel}
        className="absolute inset-0 bg-white"
        // Faint dots that move with the board, so you can see it scroll even where it is empty.
        style={{
          backgroundImage: "radial-gradient(circle, #d4d4d4 1px, transparent 1.5px)",
          backgroundSize: "40px 40px",
          backgroundPosition: `${-view.x}px ${-view.y}px`,
        }}
      >
        <DrawingCanvas
          ref={canvasRef}
          strokes={board.strokes}
          tool={tool}
          eraserMode="stroke"
          color={PEN_COLOR}
          size={tool === "eraser" ? ERASER_SIZE : PEN_SIZE}
          view={view}
          hiddenId={null}
          onStrokeComplete={addStroke}
          onStrokesErase={removeStrokes}
          onTextClick={ignoreTextClick}
          onPan={pan}
        />

        {/* AI cards are placed at board points, so they scroll with the board. */}
        <div
          className="absolute left-0 top-0"
          style={{ transform: `translate(${-view.x}px, ${-view.y}px)` }}
        >
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
              case "reply":
                return <ReplyCard key={card.id} card={card} onDismiss={dismiss} />;
            }
          })}
        </div>
      </main>

      {!calibrating && (
        <ActionDial
          ai={ai}
          voice={listening ? { state: "listening", heard: hearing } : voice}
          onSolve={solve}
          onGraph={graph}
          onCheck={check}
          onVoiceToggle={toggleVoice}
        />
      )}

      {tool === "eraser" && !calibrating && (
        // Also the way back to the pen when the double tap doesn't work.
        <button
          type="button"
          onClick={() => chooseTool("pen")}
          className="fixed right-4 top-4 z-30 rounded-full border border-neutral-300 bg-white/95 px-4 py-2 text-sm font-medium text-neutral-800 shadow-md transition-colors hover:bg-neutral-100"
        >
          Eraser on · tap for pen
        </button>
      )}

      {showKeys && !calibrating && (
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          className="fixed bottom-6 left-6 z-50 rounded-2xl border border-neutral-200 bg-white/95 p-4 text-sm text-neutral-800 shadow-lg"
        >
          <p className="mb-2 font-semibold">Keys</p>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5">
            {KEYS.map(([key, what]) => (
              <Fragment key={key}>
                <dt>
                  <kbd className="rounded-md border border-neutral-300 bg-neutral-50 px-2 py-0.5 font-mono text-xs">{key}</kbd>
                </dt>
                <dd>{what}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}

      {busEnabled && !calibrating && <CvStatus status={busStatus} />}
      <BusFeedback ref={feedbackRef} />
      <CalibrationLayer pattern={pattern} targets={targets} probes={probes} onPatternShown={showPatternDone} />
    </div>
  );
}
