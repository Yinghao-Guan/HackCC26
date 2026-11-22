// Hand tracking with MediaPipe, running in the browser: no server and no API key.
// Camera frames never leave this computer. Only the library's WebAssembly files and
// the hand model are downloaded, once per page load.

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

// Keep this in step with the version in package.json: the WebAssembly files are
// loaded from the CDN at exactly this version.
const TASKS_VISION_VERSION = "1.2.2";
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
// Google's own copy of the hand model (about 8 MB).
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** The 21 points of one hand. Coordinates are 0 to 1 across the picture. Index 4 is the thumb tip and 8 the index fingertip. */
export type Hand = NormalizedLandmark[];

/** Two landmarks that are joined by a line when the hand is drawn (a bone). */
export interface Bone {
  start: number;
  end: number;
}

export interface HandTracker {
  /** Which hardware runs the model. The GPU is much faster; the CPU is the fallback. */
  delegate: "GPU" | "CPU";
  /** The bones of a hand, for drawing it. */
  bones: Bone[];
  /**
   * Find the hands in the current video frame. `timeMs` must go up with every
   * call, so pass `performance.now()`.
   */
  detect(video: HTMLVideoElement, timeMs: number): Hand[];
  close(): void;
}

/** Load the model. Takes a few seconds, and needs the internet the first time. */
export async function createHandTracker(): Promise<HandTracker> {
  // Loaded on demand: the library needs the browser, so it must not load while
  // the page is rendered on the server.
  const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
  const runtime = await FilesetResolver.forVisionTasks(WASM_URL);

  const create = (delegate: "GPU" | "CPU") =>
    HandLandmarker.createFromOptions(runtime, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: 2,
    });

  let delegate: "GPU" | "CPU" = "GPU";
  let landmarker: Awaited<ReturnType<typeof create>>;
  try {
    landmarker = await create("GPU");
  } catch {
    delegate = "CPU";
    landmarker = await create("CPU");
  }

  return {
    delegate,
    bones: HandLandmarker.HAND_CONNECTIONS,
    detect: (video, timeMs) => landmarker.detectForVideo(video, timeMs).landmarks,
    close: () => landmarker.close(),
  };
}
