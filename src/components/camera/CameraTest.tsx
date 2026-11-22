"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createHandTracker, type Bone, type Hand, type HandTracker } from "./handTracker";
import { luminanceAround, meanLuminance, paintDarkMask } from "./luma";
import {
  DEFAULT_OTHERS_SHORTER,
  FINGER_NAMES,
  fingerReach,
  isPointing,
  type FingerReach,
} from "./pose";
import {
  addFrame,
  averageOf,
  bandCorners,
  fingerDirection,
  handShape,
  lumaOf,
  readShadow,
  releaseGap,
  skinModelFrom,
  stepTouch,
  type HandShape,
  type Point,
  type Reference,
  type ShadowReading,
  type TouchState,
} from "./shadowTouch";
import {
  framesPerSecond,
  jitter,
  lostShare,
  pointingShare,
  pruneSamples,
  type TipSample,
} from "./stats";

// A page for trying out a camera setup (angle, brightness, lighting) and the
// shadow touch detection. It shows what the camera sees, how well the hand is
// tracked, whether the hand is in the writing pose (only the index finger out),
// whether the fingertip is touching its shadow (and so the board), and how dark
// the shadow is next to the lit board.

const RESOLUTIONS = {
  "480p": { width: 640, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
} as const;
type ResolutionKey = keyof typeof RESOLUTIONS;

const SAMPLE_WIDTH = 640; // the picture is shrunk to this width to measure brightness and shadow
const DEFAULT_DARK_THRESHOLD = 90;
const DEFAULT_SHADOW_RATIO = 0.75;
const DEFAULT_HAND_MARGIN = 0.03;
const DEFAULT_SKIN_TOLERANCE = 0.06;
const DEFAULT_TOUCH_BELOW = 0.1;
const REFERENCE_FRAMES = 10; // frames averaged into the picture of the empty board
const COUNTDOWN_MS = 3000; // time to take your hand away before the empty board is captured
const TRACE_MS = 6000; // how much of the gap's history the trace shows
const TRACE_MAX_GAP = 1.5;
const LAST_CAMERA_KEY = "hackcc26.camera";
const THUMB_TIP = 4;
const INDEX_MIDDLE_JOINT = 6; // the finger's direction is taken from here to the tip
const INDEX_TIP = 8;

type CameraState =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "live";
      label: string;
      width: number;
      height: number;
      fps: number | null;
      capabilities: string;
    }
  | { kind: "error"; message: string };

type ModelState =
  | { kind: "loading" }
  | { kind: "ready"; delegate: "GPU" | "CPU" }
  | { kind: "error"; message: string };

/** A spot on the picture, as 0 to 1 across it. */
interface Spot {
  fx: number;
  fy: number;
}

/** A hand with how far its fingers reach and whether it is in the writing pose. */
interface Found {
  /** The landmarks as 0 to 1 across the picture, for drawing. */
  hand: Hand;
  /** The same landmarks in the shrunk picture's pixels, where shadow is looked for. */
  pixels: Point[];
  reach: FingerReach;
  pointing: boolean;
}

/** Where the picture of the empty board (the reference for finding shadow) stands. */
type ReferenceStatus =
  | { kind: "none" }
  | { kind: "countdown"; seconds: number }
  | { kind: "capturing" }
  | { kind: "ready" }
  | { kind: "mismatch" };

/** One moment of the shadow touch reading, for the trace. */
interface GapSample {
  t: number;
  gap: number | null;
  touching: boolean;
}

/** The numbers shown in the panel. The video loop writes them, a timer copies them into state. */
interface Readout {
  hands: number;
  /** The index fingertip of the hand being followed, in picture pixels. */
  tip: { x: number; y: number } | null;
  pointing: boolean;
  reach: FingerReach | null;
  /** How far the tip of the fingertip's shadow is from the fingertip, in hand sizes. About 0 when touching. */
  gap: number | null;
  touching: boolean;
  shadowPixels: number | null;
  /** How many dark pixels near the hand were set aside because they are the color of skin. */
  skinPixels: number | null;
  /** How much the camera's exposure has changed since the empty board was captured. */
  gain: number | null;
  reference: ReferenceStatus;
  /** What is happening with a snapshot being saved, if anything. */
  snapshot: string | null;
  fps: number;
  inferenceMs: number | null;
  lost: number | null;
  pointingShare: number | null;
  jitter: number | null;
  meanLuma: number | null;
  hoverLuma: number | null;
  pinLuma: number | null;
  darkShare: number | null;
}

const EMPTY_READOUT: Readout = {
  hands: 0,
  tip: null,
  pointing: false,
  reach: null,
  gap: null,
  touching: false,
  shadowPixels: null,
  skinPixels: null,
  gain: null,
  reference: { kind: "none" },
  snapshot: null,
  fps: 0,
  inferenceMs: null,
  lost: null,
  pointingShare: null,
  jitter: null,
  meanLuma: null,
  hoverLuma: null,
  pinLuma: null,
  darkShare: null,
};

function openStream(deviceId: string, resolution: ResolutionKey): Promise<MediaStream> {
  const { width, height } = RESOLUTIONS[resolution];
  return navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
}

function describeCameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
      return "Camera access was blocked. Allow it in the browser's address bar, then press Start camera.";
    case "NotFoundError":
      return "No camera was found. Check that the camera (or its phone app) is running and connected.";
    case "NotReadableError":
      return "The camera is busy or not sending video. Close other apps that use it and try again.";
    case "OverconstrainedError":
      return "That camera is not available any more. Pick another one.";
    default:
      return error instanceof Error ? error.message : "The camera could not be started.";
  }
}

const videoInputs = (all: MediaDeviceInfo[]) => all.filter((device) => device.kind === "videoinput");

/** The empty board's brightness as a grey PNG, for saving. */
function lumaToDataUrl(luma: Float32Array, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < luma.length; i++) {
    const level = Math.max(0, Math.min(255, Math.round(luma[i])));
    image.data[i * 4] = level;
    image.data[i * 4 + 1] = level;
    image.data[i * 4 + 2] = level;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Save a snapshot of this moment as one JSON file in the browser's downloads: the
 * camera picture, the empty-board reference, where the hand's landmarks are, and
 * what was measured. The shadow detection can then be replayed on real frames
 * outside the browser. `label` says what the snapshot shows ("touching" or "hovering").
 * Returns the file name, or null if it could not be saved.
 */
function saveSnapshot(args: {
  label: string;
  picture: HTMLCanvasElement;
  reference: Reference | null;
  hands: Found[];
  primary: number;
  reading: ShadowReading | null;
  touching: boolean;
  params: Record<string, number>;
}): string | null {
  try {
    const { picture, reference } = args;
    const round = (value: number) => Math.round(value * 10) / 10;
    const data = {
      label: args.label,
      savedAt: new Date().toISOString(),
      sample: { width: picture.width, height: picture.height },
      // The camera picture, shrunk to the size the detection works on, with nothing drawn on it.
      frame: picture.toDataURL("image/png"),
      reference: reference ? lumaToDataUrl(reference.luma, reference.width, reference.height) : null,
      hands: args.hands.map((item) => ({
        landmarks: item.pixels.map((point) => [round(point.x), round(point.y)]),
        reach: item.reach,
        pointing: item.pointing,
      })),
      primary: args.primary,
      reading: args.reading,
      touching: args.touching,
      params: args.params,
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `hackcc26-snapshot-${args.label}-${stamp}.json`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    return fileName;
  } catch {
    return null;
  }
}

function describeReference(status: ReferenceStatus): string {
  switch (status.kind) {
    case "none":
      return "There is no picture of the empty board yet. Without it the shadow cannot be found.";
    case "countdown":
      return `Take your hand away from the board… ${status.seconds}`;
    case "capturing":
      return "Capturing the empty board…";
    case "ready":
      return "The empty board is captured. Capture it again if the projected picture or the camera changes.";
    case "mismatch":
      return "The camera picture changed size. Capture the empty board again.";
  }
}

function describeCapabilities(track: MediaStreamTrack): string {
  if (typeof track.getCapabilities !== "function") {
    return "This browser does not report what the camera can do.";
  }
  return JSON.stringify(track.getCapabilities(), null, 2);
}

// Browser storage can be missing or blocked, and nothing here depends on it.
function recallCamera(): string {
  try {
    return localStorage.getItem(LAST_CAMERA_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberCamera(deviceId: string) {
  try {
    localStorage.setItem(LAST_CAMERA_KEY, deviceId);
  } catch {
    // Not remembering the camera is fine.
  }
}

function ring(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  line: number,
) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.lineWidth = line * 2.5;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.stroke();
  ctx.lineWidth = line * 1.2;
  ctx.strokeStyle = color;
  ctx.stroke();
}

/** Draw each hand's bones and joints, with rings on the thumb tip and index fingertip. */
function drawHands(
  ctx: CanvasRenderingContext2D,
  found: Found[],
  bones: Bone[],
  width: number,
  height: number,
) {
  const line = Math.max(2, width / 320);
  ctx.lineCap = "round";

  for (const { hand: points, pointing } of found) {

    ctx.beginPath();
    for (const { start, end } of bones) {
      ctx.moveTo(points[start].x * width, points[start].y * height);
      ctx.lineTo(points[end].x * width, points[end].y * height);
    }
    ctx.lineWidth = line * 2.4;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
    ctx.stroke();
    ctx.lineWidth = line;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.stroke();

    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point.x * width, point.y * height, line * 1.1, 0, Math.PI * 2);
      ctx.fillStyle = "#facc15";
      ctx.fill();
    }

    const thumb = points[THUMB_TIP];
    const index = points[INDEX_TIP];
    ring(ctx, thumb.x * width, thumb.y * height, line * 3, "#fb923c", line);
    // Green when the hand is in the writing pose, red when it is not.
    ring(ctx, index.x * width, index.y * height, line * 4.5, pointing ? "#22c55e" : "#ef4444", line);
  }
}

/**
 * Show what the shadow touch detection is working with: the hand's shape with its
 * margin (shadow is only looked for outside it), the box along the finger where
 * shadow is looked for, a line across the finger at the fingertip (shadow that
 * reaches past it means the finger is above the board), and a line to the far end
 * of the shadow. `sampleToPicture` turns the shrunk picture's pixels into the video's.
 */
function drawShadowDebug(
  ctx: CanvasRenderingContext2D,
  hand: HandShape,
  tip: Point,
  direction: Point,
  reading: ShadowReading | null,
  margin: number,
  sampleToPicture: number,
  touching: boolean,
) {
  const line = Math.max(2, ctx.canvas.width / 320);

  // The box along the finger.
  ctx.beginPath();
  bandCorners(tip, direction, hand.scale).forEach((corner, index) => {
    const x = corner.x * sampleToPicture;
    const y = corner.y * sampleToPicture;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.lineWidth = line;
  ctx.setLineDash([line * 4, line * 3]);
  ctx.strokeStyle = "rgba(14, 165, 233, 0.85)";
  ctx.stroke();
  ctx.setLineDash([]);

  // The line across the finger at the fingertip.
  const side = { x: -direction.y, y: direction.x };
  const half = 0.6 * hand.scale;
  ctx.beginPath();
  ctx.moveTo((tip.x - side.x * half) * sampleToPicture, (tip.y - side.y * half) * sampleToPicture);
  ctx.lineTo((tip.x + side.x * half) * sampleToPicture, (tip.y + side.y * half) * sampleToPicture);
  ctx.lineWidth = line * 1.5;
  ctx.strokeStyle = "rgba(14, 165, 233, 0.95)";
  ctx.stroke();

  // The hand, with its margin: each finger and the forearm as a thick line, and the palm.
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(236, 72, 153, 0.2)";
  for (const { a, b, radius } of hand.capsules) {
    ctx.beginPath();
    ctx.moveTo(a.x * sampleToPicture, a.y * sampleToPicture);
    ctx.lineTo(b.x * sampleToPicture, b.y * sampleToPicture);
    ctx.lineWidth = 2 * (radius + margin * hand.scale) * sampleToPicture;
    ctx.stroke();
  }
  ctx.beginPath();
  hand.palm.forEach((point, index) => {
    const x = point.x * sampleToPicture;
    const y = point.y * sampleToPicture;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(236, 72, 153, 0.2)";
  ctx.fill();
  ctx.lineWidth = 2 * (0.15 + margin) * hand.scale * sampleToPicture;
  ctx.stroke();

  if (reading?.shadowTip) {
    const color = touching ? "#22c55e" : "#38bdf8";
    const tipX = reading.shadowTip.x * sampleToPicture;
    const tipY = reading.shadowTip.y * sampleToPicture;
    ctx.beginPath();
    ctx.moveTo(tip.x * sampleToPicture, tip.y * sampleToPicture);
    ctx.lineTo(tipX, tipY);
    ctx.lineWidth = line * 2.5;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.stroke();
    ctx.lineWidth = line * 1.2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ring(ctx, tipX, tipY, line * 2.5, color, line);
  }
}

/** Draw the gap over the last few seconds, with the touch thresholds and the times the board was touched. */
function drawTrace(
  canvas: HTMLCanvasElement,
  history: GapSample[],
  now: number,
  touchBelow: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  const x = (t: number) => ((t - (now - TRACE_MS)) / TRACE_MS) * width;
  const y = (gap: number) => height - (Math.min(gap, TRACE_MAX_GAP) / TRACE_MAX_GAP) * height;

  ctx.clearRect(0, 0, width, height);

  // Green bands where the board was judged to be touched.
  ctx.fillStyle = "rgba(34, 197, 94, 0.2)";
  let since: number | null = null;
  for (const sample of history) {
    if (sample.touching && since === null) since = sample.t;
    if (!sample.touching && since !== null) {
      ctx.fillRect(x(since), 0, x(sample.t) - x(since), height);
      since = null;
    }
  }
  if (since !== null) ctx.fillRect(x(since), 0, width - x(since), height);

  // Where a touch starts (green) and where it ends (amber).
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 6]);
  for (const [gap, color] of [
    [touchBelow, "#16a34a"],
    [releaseGap(touchBelow), "#d97706"],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(0, y(gap));
    ctx.lineTo(width, y(gap));
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // The gap itself. The line breaks where no shadow was found.
  ctx.beginPath();
  let penDown = false;
  for (const sample of history) {
    if (sample.gap === null) {
      penDown = false;
      continue;
    }
    if (penDown) ctx.lineTo(x(sample.t), y(sample.gap));
    else ctx.moveTo(x(sample.t), y(sample.gap));
    penDown = true;
  }
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#0f172a";
  ctx.stroke();
}

const show = (value: number | null, digits = 0, unit = "") =>
  value === null ? "–" : `${value.toFixed(digits)}${unit}`;
const showPercent = (share: number | null) => show(share === null ? null : share * 100, 0, "%");

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-sm font-medium">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-5 accent-neutral-900"
      />
      {label}
    </label>
  );
}

function Marker({ at, pinned = false }: { at: Spot; pinned?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.6)] ${
        pinned ? "border-sky-400" : "border-white"
      }`}
      style={{ left: `${at.fx * 100}%`, top: `${at.fy * 100}%` }}
    />
  );
}

const buttonClass =
  "h-11 rounded-lg border px-4 text-base font-medium transition-colors disabled:pointer-events-none disabled:opacity-40";
const selectClass =
  "h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-900";

export function CameraTest() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [resolution, setResolution] = useState<ResolutionKey>("720p");
  const [mirror, setMirror] = useState(false);
  const [camera, setCamera] = useState<CameraState>({ kind: "idle" });
  const [model, setModel] = useState<ModelState>({ kind: "loading" });
  const [showHands, setShowHands] = useState(true);
  const [othersShorter, setOthersShorter] = useState(DEFAULT_OTHERS_SHORTER);
  const [showShadow, setShowShadow] = useState(true);
  const [shadowRatio, setShadowRatio] = useState(DEFAULT_SHADOW_RATIO);
  const [handMargin, setHandMargin] = useState(DEFAULT_HAND_MARGIN);
  const [skinTolerance, setSkinTolerance] = useState(DEFAULT_SKIN_TOLERANCE);
  const [touchBelow, setTouchBelow] = useState(DEFAULT_TOUCH_BELOW);
  const [maskOn, setMaskOn] = useState(false);
  const [threshold, setThreshold] = useState(DEFAULT_DARK_THRESHOLD);
  const [hover, setHover] = useState<Spot | null>(null);
  const [pin, setPin] = useState<Spot | null>(null);
  const [readout, setReadout] = useState<Readout>(EMPTY_READOUT);

  const cameraId = useId();
  const resolutionId = useId();
  const othersShorterId = useId();
  const shadowRatioId = useId();
  const handMarginId = useId();
  const skinToleranceId = useId();
  const touchBelowId = useId();
  const thresholdId = useId();

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const traceRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Counts camera starts, so a start that was overtaken by a newer one can tell and stop.
  const startCountRef = useRef(0);
  const trackerRef = useRef<HandTracker | null>(null);
  // What the video loop needs from the controls, kept in refs so the loop never restarts.
  const optionsRef = useRef({
    showHands: true,
    maskOn: false,
    threshold: DEFAULT_DARK_THRESHOLD,
    othersShorter: DEFAULT_OTHERS_SHORTER,
    showShadow: true,
    shadowRatio: DEFAULT_SHADOW_RATIO,
    handMargin: DEFAULT_HAND_MARGIN,
    skinTolerance: DEFAULT_SKIN_TOLERANCE,
    touchBelow: DEFAULT_TOUCH_BELOW,
  });
  // The picture of the empty board that shadow is found against. It outlives camera restarts.
  const referenceRef = useRef<Reference | null>(null);
  // A snapshot that is counting down before it is saved.
  const snapshotRef = useRef<{ label: "touching" | "hovering"; startAt: number } | null>(null);
  // A capture of the empty board that is counting down or collecting frames.
  const captureRef = useRef<{ startAt: number; sum: Float32Array | null; count: number } | null>(
    null,
  );
  const hoverRef = useRef<Spot | null>(null);
  const pinRef = useRef<Spot | null>(null);
  const metricsRef = useRef<Readout>({ ...EMPTY_READOUT });

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(videoInputs(await navigator.mediaDevices.enumerateDevices()));
    } catch {
      // Keep the list as it was.
    }
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(
    async (wantedId: string, wantedResolution: ResolutionKey) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera({
          kind: "error",
          message: "This page cannot open a camera here. Use http://localhost or https.",
        });
        return;
      }

      const startId = ++startCountRef.current;
      stopStream();
      setCamera({ kind: "starting" });

      try {
        const stream = await openStream(wantedId, wantedResolution).catch((error: unknown) => {
          // A remembered camera may be unplugged: fall back to the default one.
          if (wantedId && error instanceof DOMException && error.name === "OverconstrainedError") {
            return openStream("", wantedResolution);
          }
          throw error;
        });

        const video = videoRef.current;
        if (startId !== startCountRef.current || !video) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        video.srcObject = stream;
        await video.play();
        if (startId !== startCountRef.current) return;

        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings();
        track.addEventListener("ended", () => {
          if (startId === startCountRef.current) {
            setCamera({ kind: "error", message: "The camera stopped sending video." });
          }
        });

        const actualId = settings.deviceId ?? wantedId;
        setDeviceId(actualId);
        if (actualId) rememberCamera(actualId);
        setCamera({
          kind: "live",
          label: track.label,
          width: settings.width ?? video.videoWidth,
          height: settings.height ?? video.videoHeight,
          fps: settings.frameRate ?? null,
          capabilities: describeCapabilities(track),
        });
        // Camera names are only given out once the camera has been allowed.
        await refreshDevices();
      } catch (error) {
        if (startId === startCountRef.current) {
          setCamera({ kind: "error", message: describeCameraError(error) });
        }
      }
    },
    [refreshDevices, stopStream],
  );

  /** Let go of the camera, and make any start that is still under way give up. */
  const releaseCamera = useCallback(() => {
    startCountRef.current++;
    stopStream();
  }, [stopStream]);

  const stopCamera = useCallback(() => {
    releaseCamera();
    setCamera({ kind: "idle" });
  }, [releaseCamera]);

  // Load the hand model as soon as the page opens, so it is ready when the camera starts.
  useEffect(() => {
    let cancelled = false;
    let created: HandTracker | null = null;

    createHandTracker().then(
      (tracker) => {
        if (cancelled) {
          tracker.close();
          return;
        }
        created = tracker;
        trackerRef.current = tracker;
        setModel({ kind: "ready", delegate: tracker.delegate });
      },
      (error: unknown) => {
        if (cancelled) return;
        setModel({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "The hand model could not be loaded. It is downloaded the first time, so check the internet connection.",
        });
      },
    );

    return () => {
      cancelled = true;
      trackerRef.current = null;
      created?.close();
    };
  }, []);

  // Keep the camera list up to date (a phone camera app can start after the page opens).
  // Names show up straight away if the browser already allows this page to use the camera;
  // otherwise they appear after the first start.
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media) return;
    let cancelled = false;
    media.enumerateDevices().then(
      (all) => {
        if (!cancelled) setDevices(videoInputs(all));
      },
      () => {},
    );
    media.addEventListener("devicechange", refreshDevices);
    return () => {
      cancelled = true;
      media.removeEventListener("devicechange", refreshDevices);
    };
  }, [refreshDevices]);

  // Let go of the camera when leaving the page.
  useEffect(() => releaseCamera, [releaseCamera]);

  useEffect(() => {
    optionsRef.current = {
      showHands,
      maskOn,
      threshold,
      othersShorter,
      showShadow,
      shadowRatio,
      handMargin,
      skinTolerance,
      touchBelow,
    };
  }, [
    showHands,
    maskOn,
    threshold,
    othersShorter,
    showShadow,
    shadowRatio,
    handMargin,
    skinTolerance,
    touchBelow,
  ]);

  // Copy the numbers into state a few times a second (state per video frame would be wasteful).
  useEffect(() => {
    const timer = window.setInterval(() => setReadout({ ...metricsRef.current }), 250);
    return () => window.clearInterval(timer);
  }, []);

  const live = camera.kind === "live";

  // The video loop: find hands, check the pose, and measure brightness, once per camera frame.
  useEffect(() => {
    if (!live) return;
    const video = videoRef.current;
    const overlay = overlayRef.current;
    const mask = maskRef.current;
    if (!video || !overlay || !mask) return;
    const overlayCtx = overlay.getContext("2d");
    const maskCtx = mask.getContext("2d");
    const sample = document.createElement("canvas");
    const sampleCtx = sample.getContext("2d", { willReadFrequently: true });
    if (!overlayCtx || !maskCtx || !sampleCtx) return;

    metricsRef.current = { ...EMPTY_READOUT };
    const trace = traceRef.current;
    const samples: TipSample[] = [];
    const history: GapSample[] = [];
    const frameTimes: number[] = [];
    let touch: TouchState = { touching: false, streak: 0 };
    let maskImage: ImageData | null = null;
    let maskDrawn = false;
    let inferenceMs: number | null = null;
    let lastVideoTime = -1;
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      // Only work on new camera frames.
      if (video.readyState < 2 || video.videoWidth === 0 || video.currentTime === lastVideoTime) {
        return;
      }
      lastVideoTime = video.currentTime;

      const now = performance.now();
      const options = optionsRef.current;
      const metrics = metricsRef.current;
      const width = video.videoWidth;
      const height = video.videoHeight;

      if (overlay.width !== width || overlay.height !== height) {
        overlay.width = width;
        overlay.height = height;
      }
      overlayCtx.clearRect(0, 0, width, height);

      // The picture, shrunk, for measuring brightness and finding shadow.
      const sampleHeight = Math.max(1, Math.round((SAMPLE_WIDTH * height) / width));
      const sampleToPicture = width / SAMPLE_WIDTH;
      if (sample.width !== SAMPLE_WIDTH || sample.height !== sampleHeight) {
        sample.width = SAMPLE_WIDTH;
        sample.height = sampleHeight;
      }
      sampleCtx.drawImage(video, 0, 0, SAMPLE_WIDTH, sampleHeight);
      const picture = sampleCtx.getImageData(0, 0, SAMPLE_WIDTH, sampleHeight);
      const luma = lumaOf(picture);

      // Taking the picture of the empty board: count down, then average a few frames.
      const capture = captureRef.current;
      if (capture) {
        if (now < capture.startAt) {
          metrics.reference = { kind: "countdown", seconds: Math.ceil((capture.startAt - now) / 1000) };
        } else {
          if (!capture.sum || capture.sum.length !== luma.length) {
            capture.sum = new Float32Array(luma.length);
            capture.count = 0;
          }
          addFrame(capture.sum, luma);
          capture.count++;
          metrics.reference = { kind: "capturing" };
          if (capture.count >= REFERENCE_FRAMES) {
            referenceRef.current = {
              luma: averageOf(capture.sum, capture.count),
              width: SAMPLE_WIDTH,
              height: sampleHeight,
            };
            captureRef.current = null;
          }
        }
      }
      const reference = referenceRef.current;
      if (!captureRef.current) {
        metrics.reference = !reference
          ? { kind: "none" }
          : reference.width === SAMPLE_WIDTH && reference.height === sampleHeight
            ? { kind: "ready" }
            : { kind: "mismatch" };
      }

      // Hands, and whether the hand is in the writing pose.
      let primaryTip: Point | null = null;
      let primaryDirection: Point | null = null;
      let primaryShape: HandShape | null = null;
      let found: Found[] = [];
      let primary: Found | null = null;
      const tracker = trackerRef.current;
      if (tracker) {
        const started = performance.now();
        try {
          found = tracker.detect(video, now).map((hand) => {
            const pixels = hand.map((point) => ({
              x: point.x * SAMPLE_WIDTH,
              y: point.y * sampleHeight,
            }));
            const reach = fingerReach(pixels);
            return { hand, pixels, reach, pointing: isPointing(reach, options.othersShorter) };
          });
        } catch {
          // A bad frame counts as no hand.
        }
        const spent = performance.now() - started;
        inferenceMs = inferenceMs === null ? spent : inferenceMs * 0.9 + spent * 0.1;

        // Follow the hand in the writing pose if there is one, so the other hand cannot take over.
        primary = found.find((item) => item.pointing) ?? found[0] ?? null;
        const tip = primary
          ? {
              x: primary.hand[INDEX_TIP].x * width,
              y: primary.hand[INDEX_TIP].y * height,
            }
          : null;
        if (primary) {
          primaryTip = primary.pixels[INDEX_TIP];
          primaryDirection = fingerDirection(primary.pixels[INDEX_MIDDLE_JOINT], primary.pixels[INDEX_TIP]);
          primaryShape = handShape(primary.pixels);
        }
        samples.push({ t: now, tip, pointing: primary?.pointing ?? false });
        pruneSamples(samples, now);

        if (options.showHands) drawHands(overlayCtx, found, tracker.bones, width, height);

        metrics.hands = found.length;
        metrics.tip = tip;
        metrics.pointing = primary?.pointing ?? false;
        metrics.reach = primary?.reach ?? null;
        metrics.inferenceMs = inferenceMs;
        metrics.lost = lostShare(samples);
        metrics.pointingShare = pointingShare(samples);
        metrics.jitter = jitter(samples, now);
      }
      frameTimes.push(now);
      metrics.fps = framesPerSecond(frameTimes, now);

      // Brightness of the board and of the shadow.
      metrics.meanLuma = meanLuminance(picture);
      const hoverAt = hoverRef.current;
      const pinAt = pinRef.current;
      metrics.hoverLuma = hoverAt ? luminanceAround(picture, hoverAt.fx, hoverAt.fy) : null;
      metrics.pinLuma = pinAt ? luminanceAround(picture, pinAt.fx, pinAt.fy) : null;

      // The layer over the picture: dark areas painted red, and the shadow that was found painted cyan.
      const paintLayer = options.maskOn || options.showShadow;
      let paint: Uint8ClampedArray | undefined;
      if (paintLayer) {
        if (mask.width !== SAMPLE_WIDTH || mask.height !== sampleHeight) {
          mask.width = SAMPLE_WIDTH;
          mask.height = sampleHeight;
          maskImage = null;
        }
        if (!maskImage) maskImage = maskCtx.createImageData(SAMPLE_WIDTH, sampleHeight);
        if (options.maskOn) {
          metrics.darkShare = paintDarkMask(picture, maskImage, options.threshold);
        } else {
          maskImage.data.fill(0);
          metrics.darkShare = null;
        }
        if (options.showShadow) paint = maskImage.data;
      } else {
        metrics.darkShare = null;
      }

      // Shadow touch: does the shadow reach past the fingertip, or stop at it against the hand?
      let reading: ShadowReading | null = null;
      if (
        reference &&
        reference.width === SAMPLE_WIDTH &&
        reference.height === sampleHeight &&
        primary &&
        primaryTip &&
        primaryDirection &&
        primaryShape
      ) {
        reading = readShadow({
          luma,
          colors: picture,
          reference,
          tip: primaryTip,
          direction: primaryDirection,
          hand: primaryShape,
          skin: skinModelFrom(picture, primary.pixels),
          params: {
            shadowRatio: options.shadowRatio,
            handMargin: options.handMargin,
            skinTolerance: options.skinTolerance,
          },
          paint,
        });
      }
      touch = stepTouch(touch, reading ? reading.gap : null, options.touchBelow);
      metrics.gap = reading ? reading.gap : null;
      metrics.touching = touch.touching;
      metrics.shadowPixels = reading ? reading.shadowPixels : null;
      metrics.skinPixels = reading ? reading.skinPixels : null;
      metrics.gain = reading ? reading.gain : null;

      if (paintLayer && maskImage) {
        maskCtx.putImageData(maskImage, 0, 0);
        maskDrawn = true;
      } else if (maskDrawn) {
        maskCtx.clearRect(0, 0, mask.width, mask.height);
        maskDrawn = false;
      }
      if (options.showShadow && primaryShape && primaryTip && primaryDirection) {
        drawShadowDebug(
          overlayCtx,
          primaryShape,
          primaryTip,
          primaryDirection,
          reading,
          options.handMargin,
          sampleToPicture,
          touch.touching,
        );
      }

      // A snapshot of this moment (the picture, the hand and what was measured), saved as a file
      // so the detection can be studied and tuned on real frames.
      const pendingSnapshot = snapshotRef.current;
      if (pendingSnapshot) {
        if (now < pendingSnapshot.startAt) {
          metrics.snapshot = `Saving the ${pendingSnapshot.label} snapshot in ${Math.ceil((pendingSnapshot.startAt - now) / 1000)}…`;
        } else {
          snapshotRef.current = null;
          const fileName = saveSnapshot({
            label: pendingSnapshot.label,
            picture: sample,
            reference: reference && reference.width === SAMPLE_WIDTH ? reference : null,
            hands: found,
            primary: primary ? found.indexOf(primary) : -1,
            reading,
            touching: touch.touching,
            params: {
              shadowRatio: options.shadowRatio,
              handMargin: options.handMargin,
              skinTolerance: options.skinTolerance,
              touchBelow: options.touchBelow,
              othersShorter: options.othersShorter,
            },
          });
          metrics.snapshot = fileName ? `Saved ${fileName} to your Downloads folder.` : "The snapshot could not be saved.";
        }
      }

      // The trace of the gap over the last few seconds.
      if (trackerRef.current) {
        history.push({ t: now, gap: metrics.gap, touching: touch.touching });
        while (history.length > 0 && now - history[0].t > TRACE_MS) history.shift();
      }
      if (trace) drawTrace(trace, history, now, options.touchBelow);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      maskCtx.clearRect(0, 0, mask.width, mask.height);
      trace?.getContext("2d")?.clearRect(0, 0, trace.width, trace.height);
      metricsRef.current = { ...EMPTY_READOUT };
    };
  }, [live]);

  const spotFrom = (e: ReactPointerEvent<HTMLDivElement>): Spot => {
    // The box is flipped on screen when mirrored, but the picture's own coordinates are not.
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    return { fx: mirror ? 1 - x : x, fy: (e.clientY - rect.top) / rect.height };
  };
  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const spot = spotFrom(e);
    hoverRef.current = spot;
    setHover(spot);
  };
  const handlePointerLeave = () => {
    hoverRef.current = null;
    setHover(null);
  };
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const spot = spotFrom(e);
    pinRef.current = spot;
    setPin(spot);
  };
  const clearPin = () => {
    pinRef.current = null;
    setPin(null);
  };

  /** Take a picture of the empty board after a short countdown, so there is time to move the hand away. */
  const captureReference = () => {
    captureRef.current = { startAt: performance.now() + COUNTDOWN_MS, sum: null, count: 0 };
  };

  /** Save a labelled snapshot after a short countdown, so there is time to put the finger in place. */
  const requestSnapshot = (label: "touching" | "hovering") => {
    snapshotRef.current = { label, startAt: performance.now() + COUNTDOWN_MS };
  };

  const handleCameraChange = (id: string) => {
    setDeviceId(id);
    if (camera.kind === "live" || camera.kind === "starting") void startCamera(id, resolution);
  };
  const handleResolutionChange = (key: ResolutionKey) => {
    setResolution(key);
    if (camera.kind === "live" || camera.kind === "starting") void startCamera(deviceId, key);
  };

  const aspect = camera.kind === "live" ? camera.width / camera.height : 16 / 9;
  const brightnessGap =
    readout.pinLuma !== null && readout.hoverLuma !== null
      ? Math.abs(readout.pinLuma - readout.hoverLuma)
      : null;

  const poseText =
    readout.hands === 0
      ? "No hand"
      : readout.pointing
        ? "👆 Index finger only: writing allowed"
        : "Other pose: no writing";
  const poseClass =
    readout.hands === 0
      ? "bg-neutral-200 text-neutral-600"
      : readout.pointing
        ? "bg-emerald-100 text-emerald-800"
        : "bg-amber-100 text-amber-800";

  // Writing needs both: the hand in the writing pose, and the fingertip touching its shadow.
  const writing = readout.pointing && readout.touching;
  const referenceReady = readout.reference.kind === "ready";
  const touchText = !referenceReady
    ? "Capture the empty board first"
    : readout.hands === 0
      ? "No hand"
      : readout.gap === null
        ? "No shadow seen around the hand"
        : readout.touching
          ? "Touching the board"
          : "Hovering above the board";
  const touchClass = !referenceReady || readout.hands === 0
    ? "bg-neutral-200 text-neutral-600"
    : readout.touching
      ? "bg-emerald-100 text-emerald-800"
      : "bg-sky-100 text-sky-800";

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-neutral-100 text-neutral-900">
      <h1 className="sr-only">Camera test</h1>

      <main className="flex min-w-0 flex-1 items-center justify-center p-4">
        <div
          className="relative overflow-hidden rounded-lg bg-black"
          style={{
            aspectRatio: aspect,
            // As large as fits: the full width, unless the height runs out first.
            width: `min(100%, calc((100dvh - 2rem) * ${aspect}))`,
          }}
        >
          {/* Picture and everything drawn on it are flipped together when mirrored. */}
          <div
            className="absolute inset-0 cursor-crosshair touch-none select-none"
            style={{ transform: mirror ? "scaleX(-1)" : undefined }}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onPointerDown={handlePointerDown}
          >
            <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full" />
            <canvas
              ref={maskRef}
              className="pointer-events-none absolute inset-0 h-full w-full"
              style={{ imageRendering: "pixelated" }}
            />
            <canvas
              ref={overlayRef}
              className="pointer-events-none absolute inset-0 h-full w-full"
            />
            {hover && <Marker at={hover} />}
            {pin && <Marker at={pin} pinned />}
          </div>

          {camera.kind !== "live" && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-neutral-300">
              {camera.kind === "starting"
                ? "Starting the camera…"
                : camera.kind === "error"
                  ? camera.message
                  : "The camera is off. Press Start camera."}
            </div>
          )}
        </div>
      </main>

      <aside
        aria-label="Camera test controls"
        className="flex w-96 shrink-0 flex-col gap-8 overflow-y-auto border-l border-neutral-200 bg-neutral-50 p-5"
      >
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Camera test</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Open the whiteboard (<code>/</code>) on the projector and this page on the laptop, then
            try camera angles and board brightness.
          </p>
        </div>

        <Section title="Camera">
          {live || camera.kind === "starting" ? (
            <button
              type="button"
              onClick={stopCamera}
              className={`${buttonClass} border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100`}
            >
              Stop camera
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void startCamera(deviceId || recallCamera(), resolution)}
              className={`${buttonClass} border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-700`}
            >
              Start camera
            </button>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor={cameraId} className="text-sm font-medium">
              Camera
            </label>
            <select
              id={cameraId}
              value={deviceId}
              onChange={(e) => handleCameraChange(e.target.value)}
              className={selectClass}
            >
              <option value="">Default camera</option>
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={resolutionId} className="text-sm font-medium">
              Resolution
            </label>
            <select
              id={resolutionId}
              value={resolution}
              onChange={(e) => handleResolutionChange(e.target.value as ResolutionKey)}
              className={selectClass}
            >
              {(Object.keys(RESOLUTIONS) as ResolutionKey[]).map((key) => (
                <option key={key} value={key}>
                  {key} ({RESOLUTIONS[key].width}×{RESOLUTIONS[key].height})
                </option>
              ))}
            </select>
          </div>

          <Toggle label="Mirror the picture" checked={mirror} onChange={setMirror} />

          {camera.kind === "live" && (
            <>
              <p className="text-sm text-neutral-500">
                {camera.label || "Camera"}: {camera.width}×{camera.height}
                {camera.fps ? ` at ${Math.round(camera.fps)} fps` : ""}
              </p>
              <details className="text-sm text-neutral-500">
                <summary className="cursor-pointer">What the browser can control</summary>
                <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-white p-2 text-xs">
                  {camera.capabilities}
                </pre>
              </details>
            </>
          )}
          {camera.kind === "error" && <p className="text-sm text-red-700">{camera.message}</p>}
        </Section>

        <Section title="Hand tracking">
          <p
            role="status"
            className={`text-sm ${model.kind === "error" ? "text-red-700" : "text-neutral-500"}`}
          >
            {model.kind === "loading"
              ? "Loading the hand model (downloaded the first time)…"
              : model.kind === "ready"
                ? `Hand model ready (running on the ${model.delegate}).`
                : model.message}
          </p>
          <Toggle label="Draw the hand on the picture" checked={showHands} onChange={setShowHands} />
          <dl className="flex flex-col gap-1.5">
            <Row label="Hands found" value={readout.hands} />
            <Row
              label="Index fingertip (picture pixels)"
              value={readout.tip ? `${Math.round(readout.tip.x)}, ${Math.round(readout.tip.y)}` : "–"}
            />
            <Row label="Camera frames per second" value={show(readout.fps)} />
            <Row label="Model time per frame" value={show(readout.inferenceMs, 1, " ms")} />
            <Row label="Frames with no hand (last 2 s)" value={showPercent(readout.lost)} />
            <Row label="Fingertip jitter (last 1 s)" value={show(readout.jitter, 1, " px")} />
          </dl>
          <p className="text-sm text-neutral-500">
            Hold your fingertip still for a second to read the jitter. For both numbers lower is
            better, so use them to compare camera angles.
          </p>
        </Section>

        <Section title="Writing pose">
          <p className={`rounded-lg px-3 py-2 text-sm font-medium ${poseClass}`}>{poseText}</p>
          <div className="grid grid-cols-4 gap-2 text-center text-sm">
            {FINGER_NAMES.map((name) => {
              const reach = readout.reach?.[name] ?? null;
              // The index finger should be the long one; the others should be short next to it.
              const isShort =
                reach !== null && readout.reach !== null && name !== "index"
                  ? reach <= readout.reach.index * othersShorter
                  : null;
              return (
                <div
                  key={name}
                  className={`rounded-lg border px-1 py-1.5 ${
                    reach === null
                      ? "border-neutral-200 text-neutral-400"
                      : name === "index" || isShort
                        ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                        : "border-amber-300 bg-amber-50 text-amber-900"
                  }`}
                >
                  <div className="text-xs capitalize">{name}</div>
                  <div className="font-medium tabular-nums">{show(reach, 2)}</div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between text-sm">
            <label htmlFor={othersShorterId} className="font-medium">
              Other fingers shorter than
            </label>
            <span className="tabular-nums text-neutral-500">
              {Math.round(othersShorter * 100)}% of the index
            </span>
          </div>
          <input
            id={othersShorterId}
            type="range"
            min={0.3}
            max={0.95}
            step={0.01}
            value={othersShorter}
            onChange={(e) => setOthersShorter(Number(e.target.value))}
            className="h-8 w-full cursor-pointer accent-neutral-900"
          />
          <dl>
            <Row label="Hand in this pose (last 2 s)" value={showPercent(readout.pointingShare)} />
          </dl>
          <p className="text-sm text-neutral-500">
            Writing is only allowed with the index finger out and the middle, ring and little
            fingers curled. The number under each finger is how far its tip is from its knuckle in
            the picture, in hand sizes: a finger held out is long and a curled one is short. It
            works from the back of the hand and from the palm. The thumb is ignored. Raise the
            slider if your 👆 is not recognized, lower it if a fist or a pinch is. This only checks
            the shape of the hand, not whether it touches the board: that is decided from the
            shadow, below.
          </p>
        </Section>

        <Section title="Shadow touch">
          <p
            className={`rounded-lg px-3 py-2 text-base font-semibold ${
              writing ? "bg-emerald-600 text-white" : "bg-neutral-200 text-neutral-700"
            }`}
          >
            {writing
              ? "✍️ Writing: 👆 and touching"
              : readout.touching
                ? "Touching, but not in the 👆 pose: no writing"
                : "Not writing"}
          </p>
          <p className={`rounded-lg px-3 py-2 text-sm font-medium ${touchClass}`}>{touchText}</p>

          <button
            type="button"
            onClick={captureReference}
            disabled={!live}
            className={`${buttonClass} border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-700`}
          >
            Capture empty board (3 s)
          </button>
          <p className="text-sm text-neutral-500">{describeReference(readout.reference)}</p>
          <Toggle
            label="Show the shadow it found and where it looks"
            checked={showShadow}
            onChange={setShowShadow}
          />

          <dl className="flex flex-col gap-1.5">
            <Row label="Shadow past the fingertip (hand sizes)" value={show(readout.gap, 2)} />
            <Row label="Shadow pixels around the hand" value={show(readout.shadowPixels)} />
            <Row label="Skin-colored pixels set aside" value={show(readout.skinPixels)} />
            <Row
              label="Exposure change since the empty board"
              value={readout.gain === null ? "–" : `×${readout.gain.toFixed(2)}`}
            />
          </dl>

          <canvas
            ref={traceRef}
            width={640}
            height={160}
            role="img"
            aria-label="The gap between the fingertip and its shadow over the last 6 seconds"
            className="w-full rounded-lg border border-neutral-200 bg-white"
          />
          <p className="text-xs text-neutral-500">
            The line is how far the shadow reaches past your fingertip, over the last 6 seconds (0
            at the bottom, 1.5 at the top). A touch starts below the green dashed line and ends
            above the amber one. Green bands are the times it counted as touching.
          </p>

          <div className="flex items-center justify-between text-sm">
            <label htmlFor={touchBelowId} className="font-medium">
              Touching when the shadow reaches less than
            </label>
            <span className="tabular-nums text-neutral-500">{touchBelow.toFixed(2)}</span>
          </div>
          <input
            id={touchBelowId}
            type="range"
            min={0.02}
            max={1}
            step={0.01}
            value={touchBelow}
            onChange={(e) => setTouchBelow(Number(e.target.value))}
            className="h-8 w-full cursor-pointer accent-neutral-900"
          />
          <div className="flex items-center justify-between text-sm">
            <label htmlFor={shadowRatioId} className="font-medium">
              Shadow is darker than
            </label>
            <span className="tabular-nums text-neutral-500">{Math.round(shadowRatio * 100)}%</span>
          </div>
          <input
            id={shadowRatioId}
            type="range"
            min={0.3}
            max={0.95}
            step={0.01}
            value={shadowRatio}
            onChange={(e) => setShadowRatio(Number(e.target.value))}
            className="h-8 w-full cursor-pointer accent-neutral-900"
          />
          <div className="flex items-center justify-between text-sm">
            <label htmlFor={handMarginId} className="font-medium">
              Hand margin
            </label>
            <span className="tabular-nums text-neutral-500">{handMargin.toFixed(2)}</span>
          </div>
          <input
            id={handMarginId}
            type="range"
            min={0}
            max={0.6}
            step={0.01}
            value={handMargin}
            onChange={(e) => setHandMargin(Number(e.target.value))}
            className="h-8 w-full cursor-pointer accent-neutral-900"
          />
          <div className="flex items-center justify-between text-sm">
            <label htmlFor={skinToleranceId} className="font-medium">
              Skin color tolerance
            </label>
            <span className="tabular-nums text-neutral-500">
              {skinTolerance === 0 ? "off" : skinTolerance.toFixed(3)}
            </span>
          </div>
          <input
            id={skinToleranceId}
            type="range"
            min={0}
            max={0.2}
            step={0.005}
            value={skinTolerance}
            onChange={(e) => setSkinTolerance(Number(e.target.value))}
            className="h-8 w-full cursor-pointer accent-neutral-900"
          />

          <p className="text-sm text-neutral-500">
            Take your hand away from the board, press Capture, and keep still for a moment. Then
            touch the board with your finger and lift it, and watch the line: it should drop below
            the green line when you touch and rise above it when you hover. The dashed blue box
            lies along your finger and only the shadow inside it counts (cyan: pixels darker than
            the empty board by the set share). The solid blue line across the finger marks your
            fingertip. When you hover, the shadow reaches past that line, ahead of the fingertip.
            When you touch, your finger hides its own shadow, so the shadow stops at the line or
            behind it (the ring at the end of the other line is the far end of the shadow, which
            then is a bump of your hand&apos;s shadow). This assumes the light comes from behind
            your hand, so that the shadow falls ahead of the fingertip when it is above the board.
            Dark pixels that are the color of your skin are set aside (orange), because they are
            your hand, not a shadow: the skin color is read from your index finger on every frame,
            and a shadow is more gray than skin. Raise the tolerance if skin still shows up as
            cyan; lower it (or turn it off) if real shadow turns orange. If the shadow found is
            not against your hand, or none is found, it does not count as touching, so a hand far
            above the board is not mistaken for a touch. Raise Hand margin if the pink outline
            does not cover your skin. Do not write on the board while testing: projected ink is
            as dark as a shadow.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => requestSnapshot("touching")}
              disabled={!live}
              className={`${buttonClass} border-neutral-300 bg-white px-2 text-sm text-neutral-900 hover:bg-neutral-100`}
            >
              Save touching snapshot
            </button>
            <button
              type="button"
              onClick={() => requestSnapshot("hovering")}
              disabled={!live}
              className={`${buttonClass} border-neutral-300 bg-white px-2 text-sm text-neutral-900 hover:bg-neutral-100`}
            >
              Save hovering snapshot
            </button>
          </div>
          {readout.snapshot && <p className="text-sm text-neutral-700">{readout.snapshot}</p>}
          <p className="text-xs text-neutral-500">
            A snapshot saves the camera picture, the empty board and where the hand is, as one file
            in your Downloads folder, 3 seconds after you press the button so there is time to put
            your finger in place. Save a few of each (touching the board and hovering above it) so
            the detection can be tuned on real frames.
          </p>
        </Section>

        <Section title="Brightness probe">
          <Toggle label="Paint dark areas red" checked={maskOn} onChange={setMaskOn} />
          <div className="flex items-center justify-between text-sm">
            <label htmlFor={thresholdId} className="font-medium">
              Darker than
            </label>
            <span className="tabular-nums text-neutral-500">{threshold}</span>
          </div>
          <input
            id={thresholdId}
            type="range"
            min={0}
            max={255}
            step={1}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="h-8 w-full cursor-pointer accent-neutral-900"
          />
          <dl className="flex flex-col gap-1.5">
            <Row label="Picture brightness (0 to 255)" value={show(readout.meanLuma)} />
            <Row label="Under the pointer" value={show(readout.hoverLuma)} />
            <Row label="At the pinned spot" value={show(readout.pinLuma)} />
            <Row label="Difference" value={show(brightnessGap)} />
            <Row label="Picture that is darker" value={showPercent(readout.darkShare)} />
          </dl>
          <button
            type="button"
            onClick={clearPin}
            disabled={!pin}
            className={`${buttonClass} border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100`}
          >
            Clear pinned spot
          </button>
          <p className="text-sm text-neutral-500">
            Click the board in the picture to pin a spot, put the pointer on the finger&apos;s shadow,
            and read the difference. A shadow that is clearly darker than the board can be found by
            software. Compare the difference at different board brightness levels and camera angles.
          </p>
        </Section>
      </aside>
    </div>
  );
}
