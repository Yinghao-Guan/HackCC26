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
import {
  BOARD_CHANNEL,
  isBoardMessage,
  type BoardMessage,
  type CalibrationScreen,
  type ShareRect,
} from "@/lib/boardLink";
import { findWriting, pictureSize, straighten } from "./boardPicture";
import { calibrationFrom, type Calibration } from "./calibrate";
import { evenRows, gainAt, rowGains } from "./flicker";
import { applyHomography, invertMatrix } from "./homography";
import { createHandTracker, type Bone, type Hand, type HandTracker } from "./handTracker";
import { luminanceAround, meanLuminance, paintDarkMask } from "./luma";
import { Pen } from "./pen";
import {
  blueShareOf,
  boardGain,
  capBoard,
  DEFAULT_BLUE_GAIN,
  DEFAULT_PEN_TOUCH_BELOW,
  findCap,
  readPen,
  referenceAt,
  valueAt,
  type BoardColors,
  type Box,
  type CapSpot,
  type PenReading,
  windowArea,
} from "./penTip";
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
// tracked, and whether the pointer touches the board: a marker with its blue cap
// on (the tip meets its shadow), or a finger in the writing pose (only the index
// finger out) whose shadow stops at the fingertip. It also shows how dark the
// shadow is next to the lit board.

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
const DEFAULT_SMOOTHING = 1.5; // Hz: how steady the pen is held (lower is steadier but lags more)
const CALIBRATION_KEY = "wiseboard.calibration";
// Where a calibration was saved before the project was named WiseBoard; still read, so it is not lost.
const OLD_CALIBRATION_KEY = "hackcc26.calibration";
const CALIBRATION_HIDE_MS = 2000; // time for the whiteboard to turn white, and the camera's exposure to settle
const CALIBRATION_SHOW_MS = 1500; // time for the whiteboard to put its markers up
const CALIBRATION_SHOW_FOUND_MS = 10_000; // how long the markers found stay circled on the picture
const CALIBRATION_FRAMES = 6; // frames averaged into each of the two calibration pictures
const BOARD_ALIVE_MS = 2500; // the whiteboard is gone if it has not been heard from for this long
// Taking a picture of the marker writing for the whiteboard:
const HAND_FREE_MS = 300; // the hand must be out of view this long first
const PICTURE_TIMEOUT_MS = 6000; // give up if it does not go away in this time
const BLANK_SETTLE_MS = 500; // time for the projector and the camera to show the cleared board
const PICTURE_FRAMES = 3; // frames averaged into the picture
// Keeping the picture of the empty board up to date while no hand is in view:
const NO_HAND_MS = 1500; // the hand must have been gone this long
const STABLE_FRAMES = 10; // and the picture still for this many frames
const MOTION_LIMIT = 1.5; // still: the average change between frames is below this (0 to 255)
const AUTO_REFERENCE_EVERY_MS = 3000; // at most this often
const REFERENCE_FRAMES = 10; // frames averaged into the picture of the empty board
const COUNTDOWN_MS = 3000; // time to take your hand away before the empty board is captured
const TRACE_MS = 6000; // how much of the gap's history the trace shows
const TRACE_MAX_GAP = 1.5;
const LAST_CAMERA_KEY = "wiseboard.camera";
const OLD_LAST_CAMERA_KEY = "hackcc26.camera"; // as for OLD_CALIBRATION_KEY
// The capped pen: a cap missing for fewer frames than this is held where it was, so one bad frame does not drop a press.
const CAP_LOST_FRAMES = 4;
// A cap that has lain still with no hand in view this long is put down, not held: it may become part of the empty board.
const CAP_PARKED_MS = 5000;
const CAP_PARKED_MOVE = 4; // pixels: the cap moved if its tip moved more than this
const CAP_WINDOW_MARGIN = 0.05; // the cap is looked for this far around the whiteboard window (shares of it)
const MAX_CROP = 1000; // the piece of the full-size picture measured around the cap is at most this wide and high
const PALM = [0, 5, 9, 13, 17]; // the wrist and the knuckles: their middle is the middle of the hand
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

/** What presses the whiteboard's buttons: a marker with its blue cap on, or a finger. */
type PointerKind = "pen" | "finger";

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

/** Where the calibration (which says where the whiteboard is in the camera picture) stands. */
type CalibrationStatus =
  | { kind: "none" }
  | { kind: "running"; step: string }
  | { kind: "failed"; reason: string }
  | { kind: "ready"; error: number; markers: number; savedAt: string };

/** The calibration, with when it was made. */
type SavedCalibration = Calibration & { savedAt: string };

/** The steps of a calibration: hide the markers, take a picture, show them, take another. */
interface CalibrationJob {
  phase: "hide" | "before" | "show" | "after";
  /** When a waiting phase ends (performance.now()). */
  until: number;
  /** Frames added up for the picture being taken. */
  sum: Float32Array | null;
  count: number;
  /** The picture without the markers, once it is taken. */
  before: Float32Array | null;
}

/** A picture of the marker writing that the whiteboard asked for. */
interface PictureJob {
  id: number;
  /** The whiteboard's drawing area, as shares of its window. */
  area: ShareRect;
  /** Waiting for the hand to leave, waiting for the cleared board to show, or collecting frames. */
  phase: "wait" | "blank" | "grab";
  started: number;
  handFreeSince: number | null;
  until: number;
  sum: Float32Array | null;
  count: number;
}

/** A gray picture as a PNG data URL. */
function grayToDataUrl(picture: { gray: Uint8ClampedArray; width: number; height: number }): string {
  const canvas = document.createElement("canvas");
  canvas.width = picture.width;
  canvas.height = picture.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const image = ctx.createImageData(picture.width, picture.height);
  for (let i = 0; i < picture.gray.length; i++) {
    const level = picture.gray[i];
    image.data[i * 4] = level;
    image.data[i * 4 + 1] = level;
    image.data[i * 4 + 2] = level;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

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
  /** How strong the flicker bands are: the brightest row against the darkest, next to the empty board (0 is none). */
  flicker: number | null;
  reference: ReferenceStatus;
  /** Is the hand writing: in the writing pose and touching the board (held for a few frames)? */
  writing: boolean;
  /** Is the whiteboard window open and answering? */
  linked: boolean;
  calibration: CalibrationStatus;
  /** What the whiteboard says the pointer is over ("board", a button's name), or null. */
  pointerOver: string | null;
  pointerTouching: boolean;
  /** The last button the pointer clicked on the whiteboard, and how long ago. */
  lastClick: string | null;
  /** What is happening with a snapshot being saved, if anything. */
  snapshot: string | null;
  /** The capped pen: is its blue cap in view, how wide it looks, and the gap from its tip to its shadow (cap widths). */
  penFound: boolean;
  /** The tip of the cap, in picture pixels. */
  penTip: Point | null;
  penWidth: number | null;
  penGap: number | null;
  /** Is the tip of the cap's shadow hidden under the cap (the gap is then measured across, to the shadow's line)? */
  penShadowHidden: boolean;
  penShadowPixels: number | null;
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
  flicker: null,
  reference: { kind: "none" },
  writing: false,
  linked: false,
  calibration: { kind: "none" },
  pointerOver: null,
  pointerTouching: false,
  lastClick: null,
  snapshot: null,
  penFound: false,
  penTip: null,
  penWidth: null,
  penGap: null,
  penShadowHidden: false,
  penShadowPixels: null,
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
    const fileName = `wiseboard-snapshot-${args.label}-${stamp}.json`;
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

// Browser storage can be missing or blocked, and the calibration can then simply be made again.
function loadCalibration(): SavedCalibration | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CALIBRATION_KEY) ?? localStorage.getItem(OLD_CALIBRATION_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { matrix, error, markers, savedAt } = value as Record<string, unknown>;
    if (
      !Array.isArray(matrix) ||
      matrix.length !== 9 ||
      !matrix.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ||
      typeof error !== "number" ||
      typeof markers !== "number" ||
      typeof savedAt !== "string"
    ) {
      return null;
    }
    return { matrix, error, markers, savedAt };
  } catch {
    return null;
  }
}

function saveCalibration(calibration: SavedCalibration) {
  try {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
  } catch {
    // Not remembering it is fine.
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
    return localStorage.getItem(LAST_CAMERA_KEY) ?? localStorage.getItem(OLD_LAST_CAMERA_KEY) ?? "";
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

/** A box around a hand in the shrunk picture, reaching as far again as the hand is big on every side: a pen held in it is inside. */
function handBox(pixels: Point[]): Box {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of pixels) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  const size = Math.max(right - left, bottom - top);
  return { left: left - size, top: top - size, right: right + size, bottom: bottom + size };
}

const inBox = (point: Point, box: Box) =>
  point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;

/** The middle of a hand (the wrist and the knuckles), in the same pixels as its landmarks. */
function palmOf(pixels: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const index of PALM) {
    x += pixels[index].x;
    y += pixels[index].y;
  }
  return { x: x / PALM.length, y: y / PALM.length };
}

/** Canvases for measuring the capped pen: the piece of the full-size picture around it, and what was found in it. */
interface CapCanvases {
  piece: HTMLCanvasElement;
  pieceCtx: CanvasRenderingContext2D;
  paint: HTMLCanvasElement;
  paintCtx: CanvasRenderingContext2D;
}

/**
 * Find the capped pen: roughly in the shrunk picture (near a hand if one is seen),
 * then measured in a piece of the full-size picture around it. When `overlay` is
 * given, the cap and the shadow found are painted on it.
 */
function measureCap(input: {
  video: HTMLVideoElement;
  /** The full-size picture's size. */
  width: number;
  height: number;
  /** The shrunk picture and its brightness. */
  picture: ImageData;
  luma: Float32Array;
  /** How much brighter each row of the shrunk picture is than the empty board (flicker bands), or null. */
  gains: Float32Array | null;
  /** The empty board, the same size as the shrunk picture, or null if there is none, and as the cap is told from it. */
  reference: Reference | null;
  capBoard: BoardColors | null;
  /** Where in the shrunk picture the cap may be (the whiteboard window and a little around it), or null for anywhere. */
  area: Uint8Array | null;
  hands: Found[];
  previousTip: Point | null;
  blueGain: number;
  shadowRatio: number;
  skinTolerance: number;
  canvases: CapCanvases;
  overlay: CanvasRenderingContext2D | null;
}): { reading: PenReading | null; gain: number | null } {
  const { width, height, picture, luma, reference, hands, canvases, gains } = input;
  const scale = width / picture.width;
  // The cap is told from the board by being bluer than the empty board, so it needs the empty board.
  const board = input.capBoard;
  if (!reference || !board || board.width !== reference.width || board.height !== reference.height) {
    return { reading: null, gain: null };
  }

  // Blue near a hand, or anywhere if no hand is seen near any blue (the hand model can miss a hand).
  const boxes = hands.map((hand) => handBox(hand.pixels));
  const spot: CapSpot | null =
    (boxes.length > 0 ? findCap(picture, board, gains, input.blueGain, boxes, input.area) : null) ??
    findCap(picture, board, gains, input.blueGain, null, input.area);
  if (!spot) return { reading: null, gain: null };

  // The piece of the full-size picture around the cap, with room for its shadow.
  const size = Math.max(spot.right - spot.left, spot.bottom - spot.top) + 1;
  const margin = Math.max(size * 1.2, 16);
  const left = Math.max(0, Math.floor((spot.left - margin) * scale));
  const top = Math.max(0, Math.floor((spot.top - margin) * scale));
  const right = Math.min(width, left + MAX_CROP, Math.ceil((spot.right + 1 + margin) * scale));
  const bottom = Math.min(height, top + MAX_CROP, Math.ceil((spot.bottom + 1 + margin) * scale));
  const pieceWidth = right - left;
  const pieceHeight = bottom - top;
  if (pieceWidth < 8 || pieceHeight < 8) return { reading: null, gain: null };
  const { piece, pieceCtx } = canvases;
  if (piece.width !== pieceWidth || piece.height !== pieceHeight) {
    piece.width = pieceWidth;
    piece.height = pieceHeight;
  }
  pieceCtx.drawImage(input.video, left, top, pieceWidth, pieceHeight, 0, 0, pieceWidth, pieceHeight);
  const crop = pieceCtx.getImageData(0, 0, pieceWidth, pieceHeight);

  // The empty board under each full-size pixel, from the shrunk picture of it: its brightness corrected for
  // the exposure of its row (which takes out flicker bands), and its blue share.
  const gain = boardGain(luma, reference);
  const boardAt = (x: number, y: number) => {
    const sy = (y + 0.5) / scale - 0.5;
    return referenceAt(reference, (x + 0.5) / scale - 0.5, sy) * (gains ? gainAt(gains, sy) : gain);
  };
  const capBlueAt = (x: number, y: number) =>
    valueAt(board.blue, board.width, board.height, (x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5);
  const capLevelAt = (x: number, y: number) => {
    const sy = (y + 0.5) / scale - 0.5;
    return valueAt(board.luma, board.width, board.height, (x + 0.5) / scale - 0.5, sy) * (gains ? gainAt(gains, sy) : gain);
  };

  // The hand holding the pen: the tip is the end away from it, and its skin is not shadow.
  const holder = hands.find((hand) => inBox(spot, handBox(hand.pixels))) ?? null;
  const palm = holder ? palmOf(holder.pixels) : null;

  const paint = input.overlay ? new ImageData(pieceWidth, pieceHeight) : null;
  const reading = readPen({
    crop,
    left,
    top,
    boardAt,
    capBlueAt,
    capLevelAt,
    blueGain: input.blueGain,
    shadowRatio: input.shadowRatio,
    palm: palm ? { x: palm.x * scale, y: palm.y * scale } : null,
    previousTip: input.previousTip,
    skin: holder ? skinModelFrom(picture, holder.pixels) : null,
    skinTolerance: input.skinTolerance,
    paint: paint?.data,
  });

  if (paint && input.overlay) {
    const { paint: paintCanvas, paintCtx } = canvases;
    if (paintCanvas.width !== pieceWidth || paintCanvas.height !== pieceHeight) {
      paintCanvas.width = pieceWidth;
      paintCanvas.height = pieceHeight;
    }
    paintCtx.putImageData(paint, 0, 0);
    input.overlay.drawImage(paintCanvas, left, top);
  }
  return { reading, gain };
}

/**
 * Show what was found of the capped pen: the line along the cap from the back to
 * the tip, a ring on the tip (green while touching), how far around the tip shadow
 * was looked for (dashed), the line along its shadow, and a line from the tip of
 * the cap to the tip of the shadow (the gap). The two lines are the "V".
 */
function drawPenDebug(ctx: CanvasRenderingContext2D, reading: PenReading, touching: boolean) {
  const line = Math.max(2, ctx.canvas.width / 320);
  const { tip, back, shadowTip, shadowEnd } = reading;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.arc(tip.x, tip.y, reading.searchRadius, 0, Math.PI * 2);
  ctx.lineWidth = line * 0.8;
  ctx.setLineDash([line * 3, line * 3]);
  ctx.strokeStyle = "rgba(14, 165, 233, 0.8)";
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.moveTo(back.x, back.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.lineWidth = line * 2.5;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.stroke();
  ctx.lineWidth = line;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.stroke();

  if (shadowTip && shadowEnd) {
    ctx.beginPath();
    ctx.moveTo(shadowEnd.x, shadowEnd.y);
    ctx.lineTo(shadowTip.x, shadowTip.y);
    ctx.lineWidth = line * 2.5;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.stroke();
    ctx.lineWidth = line;
    ctx.strokeStyle = "#22d3ee";
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(shadowTip.x, shadowTip.y);
    ctx.lineWidth = line * 1.2;
    ctx.strokeStyle = "#f59e0b";
    ctx.stroke();
    ring(ctx, shadowTip.x, shadowTip.y, line * 1.5, "#f59e0b", line * 0.8);
  }
  ring(ctx, tip.x, tip.y, line * 3, touching ? "#22c55e" : "#38bdf8", line);
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
  const [pointerKind, setPointerKind] = useState<PointerKind>("pen");
  const [penTouchBelow, setPenTouchBelow] = useState(DEFAULT_PEN_TOUCH_BELOW);
  const [blueGain, setBlueGain] = useState(DEFAULT_BLUE_GAIN);
  const [sendToBoard, setSendToBoard] = useState(true);
  const [smoothing, setSmoothing] = useState(DEFAULT_SMOOTHING);
  // Off by default: writing is done with a marker, and the finger only presses buttons.
  const [fingerDraws, setFingerDraws] = useState(false);
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
  const pointerKindId = useId();
  const penTouchBelowId = useId();
  const blueGainId = useId();
  const smoothingId = useId();
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
    pointerKind: "pen" as PointerKind,
    penTouchBelow: DEFAULT_PEN_TOUCH_BELOW,
    blueGain: DEFAULT_BLUE_GAIN,
    sendToBoard: true,
    smoothing: DEFAULT_SMOOTHING,
    fingerDraws: false,
  });
  // The channel to the whiteboard window (src/lib/boardLink.ts), and when it was last heard from.
  const channelRef = useRef<BroadcastChannel | null>(null);
  const boardRef = useRef<{ width: number; height: number; seen: number } | null>(null);
  // Where the whiteboard is in the camera picture. Undefined until it is looked for in storage.
  const calibrationRef = useRef<SavedCalibration | null | undefined>(undefined);
  const calibrationJobRef = useRef<CalibrationJob | null>(null);
  const calibrationFailureRef = useRef<string | null>(null);
  // What the whiteboard reports about the pointer, and the last click.
  const boardPointerRef = useRef<{ over: string | null; touching: boolean; at: number } | null>(null);
  const lastClickRef = useRef<{ label: string; at: number } | null>(null);
  // The markers found in the last calibration (0 to 1 across the picture), circled on the picture for a while.
  const calibrationFoundRef = useRef<{ points: Point[]; until: number } | null>(null);
  // A picture of the marker writing that the whiteboard asked for, and when the last one ended.
  const pictureJobRef = useRef<PictureJob | null>(null);
  const pictureEndedRef = useRef(-Infinity);
  // When the video loop last ran: the camera can take pictures only while it runs.
  const lastTickRef = useRef(-Infinity);
  // The picture of the empty board that shadow is found against. It outlives camera restarts.
  const referenceRef = useRef<Reference | null>(null);
  // Blue that was on the empty board (blue writing, a blue swatch on the projected panel): never the pen's cap.
  // The empty board as the pen's cap is told from it by color (see capBoard in penTip.ts).
  const capBoardRef = useRef<BoardColors | null>(null);
  // A snapshot that is counting down before it is saved.
  const snapshotRef = useRef<{ label: "touching" | "hovering"; startAt: number } | null>(null);
  // A capture of the empty board that is counting down or collecting frames (its brightness, and its
  // blue share for telling the pen's cap from it). `auto` when the page started it by itself (no hand
  // in view), so it can be dropped if a hand comes in.
  const captureRef = useRef<{
    startAt: number;
    sum: Float32Array | null;
    blueSum?: Float32Array | null;
    count: number;
    auto?: boolean;
  } | null>(null);
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

  // The link to the whiteboard window. It says every second that it is there, and how big it is,
  // and asks for pictures of the marker writing. This page says every second whether it can take one.
  useEffect(() => {
    const channel = new BroadcastChannel(BOARD_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!isBoardMessage(message)) return;
      if (message.type === "alive") {
        boardRef.current = { width: message.width, height: message.height, seen: performance.now() };
      } else if (message.type === "finger-state") {
        boardPointerRef.current = { over: message.over, touching: message.touching, at: performance.now() };
      } else if (message.type === "finger-click") {
        lastClickRef.current = { label: message.label, at: performance.now() };
      } else if (message.type === "capture-request") {
        // The video loop takes it from here.
        pictureJobRef.current = {
          id: message.id,
          area: message.area,
          phase: "wait",
          started: performance.now(),
          handFreeSince: null,
          until: 0,
          sum: null,
          count: 0,
        };
      }
    };

    const announce = (ready: boolean) => {
      const message: BoardMessage = { type: "camera", ready };
      channel.postMessage(message);
    };
    const timer = window.setInterval(() => {
      announce(performance.now() - lastTickRef.current < 1500 && Boolean(calibrationRef.current));
    }, 1000);

    return () => {
      window.clearInterval(timer);
      announce(false);
      channelRef.current = null;
      channel.close();
    };
  }, []);

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
      pointerKind,
      penTouchBelow,
      blueGain,
      sendToBoard,
      smoothing,
      fingerDraws,
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
    pointerKind,
    penTouchBelow,
    blueGain,
    sendToBoard,
    smoothing,
    fingerDraws,
  ]);

  // Copy the numbers into state a few times a second (state per video frame would be wasteful).
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = performance.now();
      const pointer = boardPointerRef.current;
      const fresh = pointer !== null && now - pointer.at < 1500;
      const click = lastClickRef.current;
      setReadout({
        ...metricsRef.current,
        pointerOver: fresh ? pointer.over : null,
        pointerTouching: fresh && pointer.touching,
        lastClick: click ? `${click.label}, ${Math.round((now - click.at) / 1000)} s ago` : null,
      });
    }, 250);
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
    // The full-size picture, for pictures of the marker writing (small writing needs every pixel).
    const full = document.createElement("canvas");
    const fullCtx = full.getContext("2d", { willReadFrequently: true });
    // For the capped pen: a piece of the full-size picture around it, and what was found in it.
    const piece = document.createElement("canvas");
    const pieceCtx = piece.getContext("2d", { willReadFrequently: true });
    const paintPiece = document.createElement("canvas");
    const paintPieceCtx = paintPiece.getContext("2d");
    if (!overlayCtx || !maskCtx || !sampleCtx || !fullCtx || !pieceCtx || !paintPieceCtx) return;
    const capCanvases: CapCanvases = { piece, pieceCtx, paint: paintPiece, paintCtx: paintPieceCtx };

    const post = (message: BoardMessage) => channelRef.current?.postMessage(message);
    // For keeping the picture of the empty board up to date.
    let previousLuma: Float32Array | null = null;
    let stableFrames = 0;
    let noHandSince: number | null = null;
    let lastAutoReference = -Infinity;

    metricsRef.current = { ...EMPTY_READOUT };
    const samples: TipSample[] = [];
    const history: GapSample[] = [];
    const frameTimes: number[] = [];
    let touch: TouchState = { touching: false, streak: 0 };
    const pen = new Pen();
    let pointerKind = optionsRef.current.pointerKind;
    // The capped pen's tip in the last frame (full-size picture pixels), and for how many frames the cap has been missing.
    let previousTip: Point | null = null;
    let capMissing = 0;
    // The canvas the trace was last drawn on.
    let trace: HTMLCanvasElement | null = null;
    // A cap in view stops the picture of the empty board from being updated, unless it has been put down:
    // lying still with no hand in view for a while. Where and since when it has lain still.
    let capParkedAt: Point | null = null;
    let capParkedSince = 0;
    let capBlocksReference = false;
    // Where the cap may be in the shrunk picture, for the calibration it was worked out from.
    let capArea: { key: string; area: Uint8Array } | null = null;
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
      lastTickRef.current = now;
      const options = optionsRef.current;
      const metrics = metricsRef.current;
      const width = video.videoWidth;
      const height = video.videoHeight;

      if (overlay.width !== width || overlay.height !== height) {
        overlay.width = width;
        overlay.height = height;
      }
      overlayCtx.clearRect(0, 0, width, height);

      // The markers the last calibration found, circled for a while, to show what went wrong if it failed.
      const foundMarkers = calibrationFoundRef.current;
      if (foundMarkers && now < foundMarkers.until) {
        overlayCtx.lineWidth = Math.max(3, width / 300);
        overlayCtx.strokeStyle = "#22c55e";
        for (const point of foundMarkers.points) {
          overlayCtx.beginPath();
          overlayCtx.arc(point.x * width, point.y * height, Math.max(12, width / 50), 0, Math.PI * 2);
          overlayCtx.stroke();
        }
      }

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
      // Flicker bands (dark bands across the picture that roll up or down: see flicker.ts) are taken out
      // row by row against the empty board, so they are not taken for shadow or for movement.
      const known = referenceRef.current;
      const gains =
        known && known.width === SAMPLE_WIDTH && known.height === sampleHeight ? rowGains(luma, known) : null;
      const even = gains ? evenRows(luma, gains, SAMPLE_WIDTH) : luma;
      if (gains) {
        let low = Infinity;
        let high = 0;
        for (const value of gains) {
          low = Math.min(low, value);
          high = Math.max(high, value);
        }
        metrics.flicker = high > 0 ? (high - low) / high : null;
      } else {
        metrics.flicker = null;
      }

      // How much the picture changed since the last frame (for telling when it is still).
      let motion = Infinity;
      if (previousLuma && previousLuma.length === even.length) {
        let sum = 0;
        let count = 0;
        for (let i = 0; i < even.length; i += 16) {
          sum += Math.abs(even[i] - previousLuma[i]);
          count++;
        }
        motion = sum / count;
      }
      previousLuma = even;

      // Taking the picture of the empty board: count down, then average a few frames.
      const capture = captureRef.current;
      if (capture) {
        if (now < capture.startAt) {
          metrics.reference = { kind: "countdown", seconds: Math.ceil((capture.startAt - now) / 1000) };
        } else {
          if (!capture.sum || capture.sum.length !== luma.length || !capture.blueSum) {
            capture.sum = new Float32Array(luma.length);
            capture.blueSum = new Float32Array(luma.length);
            capture.count = 0;
          }
          addFrame(capture.sum, luma);
          addFrame(capture.blueSum, blueShareOf(picture));
          capture.count++;
          metrics.reference = { kind: "capturing" };
          if (capture.count >= REFERENCE_FRAMES) {
            const captured: Reference = {
              luma: averageOf(capture.sum, capture.count),
              width: SAMPLE_WIDTH,
              height: sampleHeight,
            };
            referenceRef.current = captured;
            capBoardRef.current = capBoard(captured, averageOf(capture.blueSum, capture.count));
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

      // Calibration: find where the whiteboard is in the picture. Take a picture without the
      // whiteboard's markers, have it show them, take another, and compare.
      const job = calibrationJobRef.current;
      const sendScreen = (screen: CalibrationScreen) => {
        const message: BoardMessage = { type: "markers", screen };
        channelRef.current?.postMessage(message);
      };
      if (job) {
        if (job.phase === "hide" || job.phase === "show") {
          if (now >= job.until) {
            job.phase = job.phase === "hide" ? "before" : "after";
            job.sum = null;
            job.count = 0;
          }
        } else {
          if (!job.sum || job.sum.length !== luma.length) {
            job.sum = new Float32Array(luma.length);
            job.count = 0;
          }
          addFrame(job.sum, luma);
          job.count++;
          if (job.count >= CALIBRATION_FRAMES) {
            const average = averageOf(job.sum, job.count);
            job.sum = null;
            job.count = 0;
            if (job.phase === "before") {
              job.before = average;
              job.phase = "show";
              job.until = now + CALIBRATION_SHOW_MS;
              sendScreen("markers");
            } else {
              sendScreen("off");
              calibrationJobRef.current = null;
              const result = job.before
                ? calibrationFrom(job.before, average, SAMPLE_WIDTH, sampleHeight)
                : null;
              if (result) calibrationFoundRef.current = { points: result.found, until: now + CALIBRATION_SHOW_FOUND_MS };
              if (result?.ok) {
                const saved: SavedCalibration = { ...result.calibration, savedAt: new Date().toISOString() };
                calibrationRef.current = saved;
                calibrationFailureRef.current = null;
                saveCalibration(saved);
              } else {
                calibrationFailureRef.current = result ? result.reason : "The calibration did not start properly. Try again.";
              }
            }
          }
        }
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

      // A picture of the marker writing, asked for by the whiteboard (Solve, Graph, Check): wait for
      // the hand to leave, have the whiteboard clear its drawing area, collect a few full-size frames,
      // then straighten and clean them and send the result.
      const pictureJob = pictureJobRef.current;
      if (pictureJob) {
        const finish = (message: BoardMessage) => {
          post(message);
          pictureJobRef.current = null;
          pictureEndedRef.current = now;
        };
        if (pictureJob.phase === "wait") {
          if (found.length === 0) {
            pictureJob.handFreeSince ??= now;
            if (now - pictureJob.handFreeSince >= HAND_FREE_MS) {
              post({ type: "blank", id: pictureJob.id, on: true });
              pictureJob.phase = "blank";
              pictureJob.until = now + BLANK_SETTLE_MS;
            }
          } else {
            pictureJob.handFreeSince = null;
          }
          if (pictureJob.phase === "wait" && now - pictureJob.started > PICTURE_TIMEOUT_MS) {
            finish({
              type: "capture-failed",
              id: pictureJob.id,
              reason: "Your hand is still in front of the camera. Take it away from the board and press the button again.",
            });
          }
        } else if (pictureJob.phase === "blank") {
          if (now >= pictureJob.until) {
            pictureJob.phase = "grab";
            pictureJob.sum = null;
            pictureJob.count = 0;
          }
        } else {
          if (full.width !== width || full.height !== height) {
            full.width = width;
            full.height = height;
          }
          fullCtx.drawImage(video, 0, 0, width, height);
          const fullLuma = lumaOf(fullCtx.getImageData(0, 0, width, height));
          if (!pictureJob.sum || pictureJob.sum.length !== fullLuma.length) {
            pictureJob.sum = new Float32Array(fullLuma.length);
            pictureJob.count = 0;
          }
          addFrame(pictureJob.sum, fullLuma);
          pictureJob.count++;

          if (pictureJob.count >= PICTURE_FRAMES) {
            post({ type: "blank", id: pictureJob.id, on: false });
            const calibrationNow = calibrationRef.current;
            const windowToCamera = calibrationNow ? invertMatrix(calibrationNow.matrix) : null;
            const boardNow = boardRef.current;
            if (!windowToCamera || !boardNow) {
              finish({
                type: "capture-failed",
                id: pictureJob.id,
                reason: "The camera page is not calibrated. Press Calibrate on it first.",
              });
            } else {
              const { area } = pictureJob;
              const size = pictureSize(area.width * boardNow.width, area.height * boardNow.height);
              const straight = straighten(
                averageOf(pictureJob.sum, pictureJob.count),
                width,
                height,
                windowToCamera,
                area,
                size.width,
                size.height,
              );
              const writing = findWriting(straight, size.width, size.height);
              finish({ type: "capture", id: pictureJob.id, image: grayToDataUrl(writing), scale: size.scale });
            }
          }
        }
      }

      // Keep the picture of the empty board up to date: whenever no hand has been in view for a while
      // and the picture is still, take a new one. New marker writing and changes on the projected
      // board (a new answer card, a button that changed color) then do not look like shadow.
      // A pen held in view counts as a hand (the hand model can miss a hand holding a pen).
      const handInView = found.length > 0 || capBlocksReference;
      noHandSince = handInView ? null : (noHandSince ?? now);
      stableFrames = motion < MOTION_LIMIT ? stableFrames + 1 : 0;
      if (captureRef.current?.auto && handInView) captureRef.current = null; // a hand came in: start again later
      if (
        !captureRef.current &&
        !pictureJobRef.current &&
        !calibrationJobRef.current &&
        now - pictureEndedRef.current > 1500 &&
        noHandSince !== null &&
        now - noHandSince >= NO_HAND_MS &&
        stableFrames >= STABLE_FRAMES &&
        now - lastAutoReference >= AUTO_REFERENCE_EVERY_MS
      ) {
        captureRef.current = { startAt: now, sum: null, count: 0, auto: true };
        lastAutoReference = now;
      }

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

      // Switching between the pen and the finger starts afresh, and lets go of anything held on the whiteboard.
      if (options.pointerKind !== pointerKind) {
        pointerKind = options.pointerKind;
        touch = { touching: false, streak: 0 };
        history.length = 0;
        previousTip = null;
        capMissing = 0;
        const lost = pen.lost();
        if (lost) post(lost);
      }
      const usableReference =
        reference && reference.width === SAMPLE_WIDTH && reference.height === sampleHeight ? reference : null;

      // Touch. With a finger: does the shadow reach past the fingertip, or stop at it against the hand?
      // With the capped pen: does the tip of the cap meet its shadow?
      let reading: ShadowReading | null = null;
      let cap: PenReading | null = null;
      if (pointerKind === "finger") {
        if (usableReference && primary && primaryTip && primaryDirection && primaryShape) {
          reading = readShadow({
            luma: even,
            colors: picture,
            reference: usableReference,
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
        metrics.gain = reading ? reading.gain : null;
      } else {
        // The cap is only looked for on the whiteboard window and a little around it, so blue clothes at the
        // side of the picture are not taken for it.
        if (calibrationRef.current === undefined) calibrationRef.current = loadCalibration();
        const known = calibrationRef.current;
        const areaKey = known ? `${known.savedAt} ${SAMPLE_WIDTH}x${sampleHeight}` : "";
        if (known && capArea?.key !== areaKey) {
          capArea = {
            key: areaKey,
            area: windowArea(SAMPLE_WIDTH, sampleHeight, (p) => applyHomography(known.matrix, p), CAP_WINDOW_MARGIN),
          };
        }
        const measured = measureCap({
          video,
          width,
          height,
          picture,
          luma,
          gains: usableReference ? gains : null,
          reference: usableReference,
          capBoard: usableReference ? capBoardRef.current : null,
          area: known && capArea ? capArea.area : null,
          hands: found,
          previousTip,
          blueGain: options.blueGain,
          shadowRatio: options.shadowRatio,
          skinTolerance: options.skinTolerance,
          canvases: capCanvases,
          overlay: options.showShadow ? overlayCtx : null,
        });
        cap = measured.reading;
        // A frame without the cap keeps the touch as it was, until the cap has been missing for a few frames.
        if (cap) touch = stepTouch(touch, cap.gap, options.penTouchBelow);
        metrics.gain = measured.gain;
      }
      if (cap && found.length === 0) {
        if (!capParkedAt || Math.hypot(cap.tip.x - capParkedAt.x, cap.tip.y - capParkedAt.y) > CAP_PARKED_MOVE) {
          capParkedAt = cap.tip;
          capParkedSince = now;
        }
      } else {
        capParkedAt = null;
      }
      capBlocksReference = cap !== null && !(capParkedAt && now - capParkedSince >= CAP_PARKED_MS);
      metrics.gap = reading ? reading.gap : null;
      metrics.touching = touch.touching;
      metrics.shadowPixels = reading ? reading.shadowPixels : null;
      metrics.skinPixels = reading ? reading.skinPixels : null;
      metrics.penFound = cap !== null;
      metrics.penTip = cap ? cap.tip : null;
      metrics.penWidth = cap ? cap.width : null;
      metrics.penGap = cap ? cap.gap : null;
      metrics.penShadowHidden = cap ? cap.shadowHidden : false;
      metrics.penShadowPixels = cap ? cap.shadowPixels : null;

      // The pointer: where the fingertip or the tip of the cap is on the whiteboard, and whether it is
      // writing. This goes to the whiteboard window, which presses its buttons with it (and draws, if allowed).
      const board = boardRef.current;
      const linked = board !== null && now - board.seen < BOARD_ALIVE_MS;
      if (calibrationRef.current === undefined) calibrationRef.current = loadCalibration();
      const calibration = calibrationRef.current;
      // The point in the picture (0 to 1 across it), and whether the pose allows writing (always, for the pen).
      let pointer: { tip: Point; pointing: boolean } | null = null;
      if (pointerKind === "finger") {
        if (primary) {
          pointer = { tip: { x: primary.hand[INDEX_TIP].x, y: primary.hand[INDEX_TIP].y }, pointing: primary.pointing };
        }
      } else if (cap) {
        capMissing = 0;
        previousTip = cap.tip;
        pointer = { tip: { x: cap.tip.x / width, y: cap.tip.y / height }, pointing: true };
      } else {
        capMissing++;
      }
      if (pointer) {
        const result = pen.update({
          time: now / 1000,
          tip: pointer.tip,
          pointing: pointer.pointing,
          touching: touch.touching,
          target:
            options.sendToBoard && linked && board && calibration && !calibrationJobRef.current
              ? { calibration, width: board.width, height: board.height }
              : null,
          smoothing: options.smoothing,
          draw: options.fingerDraws,
        });
        metrics.writing = result.writing;
        if (result.message) post(result.message);
      } else if (pointerKind === "finger" || capMissing >= CAP_LOST_FRAMES) {
        metrics.writing = false;
        if (pointerKind === "pen") {
          touch = { touching: false, streak: 0 };
          previousTip = null;
        }
        const lost = pen.lost();
        if (lost) post(lost);
      }
      metrics.linked = linked;
      metrics.calibration = calibrationJobRef.current
        ? {
            kind: "running",
            step:
              calibrationJobRef.current.phase === "hide"
                ? "Taking the markers down…"
                : calibrationJobRef.current.phase === "before"
                  ? "Taking a picture without markers…"
                  : calibrationJobRef.current.phase === "show"
                    ? "Putting the markers up…"
                    : "Taking a picture with the markers…",
          }
        : calibrationFailureRef.current
          ? { kind: "failed", reason: calibrationFailureRef.current }
          : calibration
            ? { kind: "ready", error: calibration.error, markers: calibration.markers, savedAt: calibration.savedAt }
            : { kind: "none" };

      if (paintLayer && maskImage) {
        maskCtx.putImageData(maskImage, 0, 0);
        maskDrawn = true;
      } else if (maskDrawn) {
        maskCtx.clearRect(0, 0, mask.width, mask.height);
        maskDrawn = false;
      }
      if (options.showShadow && cap) drawPenDebug(overlayCtx, cap, touch.touching);
      if (options.showShadow && pointerKind === "finger" && primaryShape && primaryTip && primaryDirection) {
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

      // The trace of the gap over the last few seconds (the pen's or the finger's).
      if (trackerRef.current || pointerKind === "pen") {
        history.push({ t: now, gap: pointerKind === "pen" ? metrics.penGap : metrics.gap, touching: touch.touching });
        while (history.length > 0 && now - history[0].t > TRACE_MS) history.shift();
      }
      // Looked up every frame: the pen and the finger each show the trace in their own section.
      trace = traceRef.current;
      if (trace) {
        drawTrace(trace, history, now, pointerKind === "pen" ? options.penTouchBelow : options.touchBelow);
      }
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      maskCtx.clearRect(0, 0, mask.width, mask.height);
      trace?.getContext("2d")?.clearRect(0, 0, trace.width, trace.height);
      // Tell the whiteboard the hand is gone, so it does not keep a stroke or a button pressed.
      const lost = pen.lost();
      if (lost) channelRef.current?.postMessage(lost);
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

  /** Find where the whiteboard is in the camera picture: the whiteboard shows its markers and the camera looks for them. */
  const startCalibration = () => {
    calibrationFailureRef.current = null;
    calibrationJobRef.current = {
      phase: "hide",
      until: performance.now() + CALIBRATION_HIDE_MS,
      sum: null,
      count: 0,
      before: null,
    };
    const message: BoardMessage = { type: "markers", screen: "plain" };
    channelRef.current?.postMessage(message);
  };

  const handleSendToBoard = (send: boolean) => {
    setSendToBoard(send);
    // Turning it off must not leave a stroke or a button held down on the whiteboard.
    if (!send) {
      const message: BoardMessage = { type: "pointer-lost" };
      channelRef.current?.postMessage(message);
    }
  };

  const handlePointerKind = (kind: PointerKind) => {
    setPointerKind(kind);
    // The video loop starts afresh with the new pointer, and lets go of anything held on the whiteboard.
    const message: BoardMessage = { type: "pointer-lost" };
    channelRef.current?.postMessage(message);
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
  const writing = readout.writing;
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

  const penText = !referenceReady
    ? "Capture the empty board first: the cap is found by being bluer than it"
    : !readout.penFound
      ? "No blue cap in view"
      : readout.penGap === null
        ? "Cap found, but no shadow near its tip: the pen is far from the board"
        : readout.touching
          ? "✍️ The pen touches the board"
          : "The pen is above the board";
  const penClass = !readout.penFound || !referenceReady
    ? "bg-neutral-200 text-neutral-700"
    : readout.touching
      ? "bg-emerald-600 text-white"
      : "bg-sky-100 text-sky-800";

  // The trace of the gap, shown in the pen's or the finger's section.
  const traceCanvas = (
    <canvas
      ref={traceRef}
      width={640}
      height={160}
      role="img"
      aria-label={
        pointerKind === "pen"
          ? "The gap between the tip of the cap and its shadow over the last 6 seconds"
          : "The gap between the fingertip and its shadow over the last 6 seconds"
      }
      className="w-full rounded-lg border border-neutral-200 bg-white"
    />
  );
  const captureButton = (
    <button
      type="button"
      onClick={captureReference}
      disabled={!live}
      className={`${buttonClass} border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-700`}
    >
      Capture empty board (3 s)
    </button>
  );

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

        <Section title="Whiteboard">
          <dl className="flex flex-col gap-1.5">
            <Row
              label="Whiteboard window"
              value={readout.linked ? "open" : "not found"}
            />
            <Row
              label="Where it is in the picture"
              value={
                readout.calibration.kind === "ready"
                  ? `calibrated (error ${(readout.calibration.error * 100).toFixed(2)}%)`
                  : readout.calibration.kind === "running"
                    ? "calibrating…"
                    : "not calibrated"
              }
            />
            <Row
              label="Pointer on the whiteboard"
              value={
                readout.pointerOver
                  ? `${readout.pointerOver}${readout.pointerTouching ? ", touching" : ""}`
                  : "–"
              }
            />
            <Row label="Last click" value={readout.lastClick ?? "–"} />
          </dl>
          <button
            type="button"
            onClick={startCalibration}
            disabled={!live || !readout.linked || readout.calibration.kind === "running"}
            className={`${buttonClass} border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-700`}
          >
            Calibrate
          </button>
          {readout.calibration.kind === "running" && (
            <p className="text-sm text-neutral-500">{readout.calibration.step} Keep your hand away.</p>
          )}
          {readout.calibration.kind === "failed" && (
            <p className="text-sm text-red-700">{readout.calibration.reason}</p>
          )}
          {readout.calibration.kind === "ready" && (
            <p className="text-sm text-neutral-500">
              Calibrated with {readout.calibration.markers} markers on{" "}
              {new Date(readout.calibration.savedAt).toLocaleString()}. It is remembered, but make
              it again whenever the camera, the projector or the board is moved.
            </p>
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor={pointerKindId} className="text-sm font-medium">
              Press the buttons with
            </label>
            <select
              id={pointerKindId}
              value={pointerKind}
              onChange={(e) => handlePointerKind(e.target.value as PointerKind)}
              className={selectClass}
            >
              <option value="pen">A marker with its blue cap on</option>
              <option value="finger">A finger (👆, only the index finger out)</option>
            </select>
          </div>
          <Toggle label="Send the pointer to the whiteboard" checked={sendToBoard} onChange={handleSendToBoard} />
          <Toggle
            label="The pointer also draws on the board"
            checked={fingerDraws}
            onChange={setFingerDraws}
          />
          <div className="flex items-center justify-between text-sm">
            <label htmlFor={smoothingId} className="font-medium">
              Pen smoothing
            </label>
            <span className="tabular-nums text-neutral-500">{smoothing.toFixed(1)} Hz</span>
          </div>
          <input
            id={smoothingId}
            type="range"
            min={0.3}
            max={6}
            step={0.1}
            value={smoothing}
            onChange={(e) => setSmoothing(Number(e.target.value))}
            className="h-8 w-full cursor-pointer accent-neutral-900"
          />
          <p className="text-sm text-neutral-500">
            Open the whiteboard (<code>/</code>) in a window on the projector, put this page on
            your screen, and keep both visible (a window that is covered or minimized stops
            working). Take your hand away, press Calibrate, and wait: the whiteboard shows nine
            black squares and this page finds them.
          </p>
          <p className="text-sm text-neutral-500">
            Write on the board with a marker. When you press Solve, Graph or Check on the
            whiteboard, it asks this page for a picture: take your hand away from the board, the
            drawing area goes plain for half a second, and the camera reads the marker writing.
            Writing with the mouse still counts too.
          </p>
          <p className="text-sm text-neutral-500">
            Press a button with the pointer (the tip of the capped marker, or one finger with only
            the index finger out): touch the button and lift. Sliders follow the pointer while it
            touches them. A wide ring on the whiteboard shows where the pointer is seen (amber
            while it touches). The picture of the empty board that touch is judged against updates
            by itself whenever no hand has been in view for a moment. Drawing with the pointer is
            off by default; turn it on above. A lower smoothing number holds the pointer steadier
            but makes it lag.
          </p>
        </Section>

        {pointerKind === "pen" && (
          <Section title="Capped pen">
            <p className={`rounded-lg px-3 py-2 text-base font-semibold ${penClass}`}>{penText}</p>
            {captureButton}
            <p className="text-sm text-neutral-500">{describeReference(readout.reference)}</p>
            <Toggle
              label="Show the cap and the shadow it found"
              checked={showShadow}
              onChange={setShowShadow}
            />
            <dl className="flex flex-col gap-1.5">
              <Row
                label="Tip of the cap (camera pixels)"
                value={readout.penTip ? `${Math.round(readout.penTip.x)}, ${Math.round(readout.penTip.y)}` : "–"}
              />
              <Row label="Cap width (camera pixels)" value={show(readout.penWidth, 1)} />
              <Row label="Gap from the tip to its shadow (cap widths)" value={show(readout.penGap, 2)} />
              <Row
                label="Tip of the shadow"
                value={readout.penGap === null ? "–" : readout.penShadowHidden ? "under the cap" : "in view"}
              />
              <Row label="Shadow pixels near the tip" value={show(readout.penShadowPixels)} />
              <Row
                label="Exposure change since the empty board"
                value={readout.gain === null ? "–" : `×${readout.gain.toFixed(2)}`}
              />
              <Row label="Flicker bands (taken out)" value={showPercent(readout.flicker)} />
            </dl>
            {traceCanvas}
            <p className="text-xs text-neutral-500">
              The line is the gap between the tip of the cap and its shadow, over the last 6
              seconds (0 at the bottom, 1.5 cap widths at the top). A touch starts below the green
              dashed line and ends above the amber one. Green bands are the times it counted as
              touching.
            </p>

            <div className="flex items-center justify-between text-sm">
              <label htmlFor={penTouchBelowId} className="font-medium">
                Touching when the gap is less than
              </label>
              <span className="tabular-nums text-neutral-500">{penTouchBelow.toFixed(2)}</span>
            </div>
            <input
              id={penTouchBelowId}
              type="range"
              min={0.02}
              max={1}
              step={0.01}
              value={penTouchBelow}
              onChange={(e) => setPenTouchBelow(Number(e.target.value))}
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
              <label htmlFor={blueGainId} className="font-medium">
                Cap: bluer than the board by at least
              </label>
              <span className="tabular-nums text-neutral-500">{blueGain.toFixed(2)}</span>
            </div>
            <input
              id={blueGainId}
              type="range"
              min={0.03}
              max={0.3}
              step={0.01}
              value={blueGain}
              onChange={(e) => setBlueGain(Number(e.target.value))}
              className="h-8 w-full cursor-pointer accent-neutral-900"
            />

            <p className="text-sm text-neutral-500">
              Hold a whiteboard marker with its blue cap on like a pen, and touch the board with
              the tip of the cap. Take your hand away and press Capture first. The cap is found by
              its color (painted blue on the picture) and the shadow next to it (cyan), which is
              darker than the empty board. The white line runs along the cap to its tip (ring), the
              cyan line along its shadow, and the amber line goes from the tip of the cap to the tip
              of the shadow: that is the gap. When the tip touches the board, the two lines meet at
              the tip like a V and the gap drops to about 0; it grows as the tip lifts. Hold the pen
              so that its shadow is not hidden right behind it. The cap is what is clearly bluer
              than the empty board at the same spot (through the camera the gray board can look
              lavender, and the panel has blue buttons), so it is only found once the empty board
              has been captured. If parts of the cap are not painted blue, lower the last slider;
              if parts of the board are, raise it. Keep other blue things (a sleeve, blue writing
              that is not on the empty board yet) away from your hand.
            </p>
          </Section>
        )}

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

        {pointerKind === "finger" && (
          <>
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

              {captureButton}
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
                <Row label="Flicker bands (taken out)" value={showPercent(readout.flicker)} />
              </dl>

              {traceCanvas}
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
          </>
        )}

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
