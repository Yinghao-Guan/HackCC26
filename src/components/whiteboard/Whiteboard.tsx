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
import { CalibrationMarkers } from "./CalibrationMarkers";
import { CheckCard } from "./CheckCard";
import { useCvBus, type BusEvent, type Marker, type Target } from "./cvBus";
import { CvStatus } from "./CvStatus";
import { DrawingCanvas, type DrawingCanvasHandle } from "./DrawingCanvas";
import { exportBoardPicture, exportInk, type InkImage } from "./exportInk";
import { FingerUi } from "./fingerUi";
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
  // The camera page (this browser, see src/lib/boardLink.ts): its calibration screen, whether
  // it can read the marker writing, and a way to ask it to.
  const [calibrationScreen, setCalibrationScreen] = useState<CalibrationScreen>("off");
  const cameraReadyRef = useRef(false);
  const requestPictureRef = useRef<((area: ShareRect) => Promise<{ image: string; scale: number }>) | null>(null);
  // The drawing area goes plain for a moment while the camera takes its picture, so it sees only real writing.
  const [blank, setBlank] = useState(false);

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
      if (!undoing && (ai.state === "loading" || ai.state === "capturing")) {
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

  // A finger seen by the camera page arrives over a channel (see src/lib/boardLink.ts). It writes on
  // the board like a pen, and presses buttons and drags sliders like a finger on a touch screen.
  useEffect(() => {
    const channel = new BroadcastChannel(BOARD_CHANNEL);
    const finger = new FingerUi();
    // What the pointer is over is reported back to the camera page, at most a few times a second.
    let lastReport = { over: null as string | null, touching: false, at: -Infinity };
    const target = {
      get canvas() {
        return canvasRef.current?.canvas() ?? null;
      },
      draw: (point: Point | null, down: boolean) => canvasRef.current?.finger(point, down),
      // Shown with the same marker as the camera service's finger (BusFeedback).
      ring: (point: Point | null, touching: boolean) => {
        if (point) feedbackRef.current?.pointer(point.x, point.y, touching);
        else feedbackRef.current?.hidePointer();
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
        cameraReadyRef.current = message.ready;
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
      if (cameraReadyRef.current && performance.now() - cameraSeen > 2500) cameraReadyRef.current = false;
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
  const calibrating = pattern !== null || targets.length > 0 || calibrationScreen !== "off";

  // Ctrl/Cmd+Z undoes the last change to the board.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo]);

  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <h1 className="sr-only">WiseBoard</h1>

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

        {/* Plain board over everything while the camera page takes its picture of the marker writing. */}
        {blank && <div aria-hidden="true" className="absolute inset-0 z-40 bg-white" />}
      </main>

      {calibrationScreen !== "off" && <CalibrationMarkers screen={calibrationScreen} />}

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

      {busEnabled && !calibrating && <CvStatus status={busStatus} />}
      <BusFeedback ref={feedbackRef} />
      <CalibrationLayer pattern={pattern} targets={targets} probes={probes} onPatternShown={showPatternDone} />
    </div>
  );
}
