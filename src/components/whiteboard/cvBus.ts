"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * The camera service's event bus (cv/README.md). The service watches the board with a
 * camera and sends what it sees (a finger touching the board, hand gestures, calibration
 * steps) as JSON messages; this page is the "board page" it draws on.
 */
const DEFAULT_BUS_URL = "ws://127.0.0.1:8765/ws";
// Wait this long before each attempt to reconnect, then keep using the last value.
const RETRY_MS = [1000, 2000, 3000, 5000];

export interface Marker {
  id: number;
  x: number;
  y: number;
  size: number;
  /** The marker image, as a PNG data URL. */
  png: string;
}

export interface Target {
  id: number;
  x: number;
  y: number;
}

export type Phase = "start" | "move" | "end";

/** The messages from the service this page acts on. Positions are CSS pixels of this page. */
export type BusEvent =
  | { type: "pointer"; id: number; x: number; y: number; touching: boolean }
  | { type: "camera" | "calibration" | "tracking"; status: string; message: string }
  | { type: "calibration_targets"; targets: Target[] }
  | { type: "calibration_probe"; x: number; y: number }
  | { type: "calibration_pattern"; run: number; markers: Marker[] }
  | { type: "gesture"; name: string }
  | { type: "pan" | "rotate"; phase: Phase; x: number | null; y: number | null; dx: number; dy: number }
  | { type: "zoom"; phase: Phase; scale: number; cx: number | null; cy: number | null }
  | { type: "reset_progress"; progress: number };

/** How the connection to the service is doing, and what it last said about itself. */
export interface BusStatus {
  /** "connecting" until the first try works or fails; "closed" while retrying after that. */
  connection: "connecting" | "open" | "closed";
  camera: { status: string; message: string } | null;
  calibration: { status: string; message: string } | null;
  tracking: { status: string; message: string } | null;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const numberOrNull = (value: unknown) => (isNumber(value) ? value : null);
const textOf = (value: unknown) => (typeof value === "string" ? value : "");
const isPhase = (value: unknown): value is Phase => value === "start" || value === "move" || value === "end";

function isTarget(value: unknown): value is Target {
  const v = value as Partial<Target> | null;
  return typeof v === "object" && v !== null && isNumber(v.id) && isNumber(v.x) && isNumber(v.y);
}

function isMarker(value: unknown): value is Marker {
  const v = value as Partial<Marker> | null;
  return (
    isTarget(value) &&
    isNumber(v?.size) &&
    typeof v?.png === "string" &&
    v.png.startsWith("data:image/png;base64,")
  );
}

/** Check a message from the service and return it as a BusEvent, or null to ignore it. */
export function parseBusEvent(raw: unknown): BusEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;

  switch (e.type) {
    case "pointer":
      if (!isNumber(e.x) || !isNumber(e.y)) return null;
      return { type: e.type, id: isNumber(e.id) ? e.id : 0, x: e.x, y: e.y, touching: e.touching === true };
    case "camera":
    case "calibration":
    case "tracking":
      return typeof e.status === "string" ? { type: e.type, status: e.status, message: textOf(e.message) } : null;
    case "calibration_targets":
      return Array.isArray(e.targets) ? { type: e.type, targets: e.targets.filter(isTarget) } : null;
    case "calibration_probe":
      return isNumber(e.x) && isNumber(e.y) ? { type: e.type, x: e.x, y: e.y } : null;
    case "calibration_pattern":
      return isNumber(e.run) && Array.isArray(e.markers)
        ? { type: e.type, run: e.run, markers: e.markers.filter(isMarker) }
        : null;
    case "gesture":
      return typeof e.name === "string" ? { type: e.type, name: e.name } : null;
    case "pan":
    case "rotate":
      if (!isPhase(e.phase)) return null;
      return {
        type: e.type,
        phase: e.phase,
        x: numberOrNull(e.x),
        y: numberOrNull(e.y),
        dx: isNumber(e.dx) ? e.dx : 0,
        dy: isNumber(e.dy) ? e.dy : 0,
      };
    case "zoom":
      if (!isPhase(e.phase) || !isNumber(e.scale) || e.scale <= 0) return null;
      return { type: e.type, phase: e.phase, scale: e.scale, cx: numberOrNull(e.cx), cy: numberOrNull(e.cy) };
    case "reset_progress":
      return isNumber(e.progress) ? { type: e.type, progress: e.progress } : null;
    case "error":
      console.warn("[cv bus] the service said:", textOf(e.message));
      return null;
    default:
      return null; // hello_ack, pong, hands, and anything newer: not used here
  }
}

/**
 * Where to find the bus: `?bus=` in the page address, else NEXT_PUBLIC_CV_BUS_URL, else the
 * service's default. "off" turns it off. Only ws:// or wss:// addresses on this computer are
 * accepted, since the service only listens there and the page trusts what it sends.
 */
function busUrl(): string | null {
  const fromPage = new URLSearchParams(window.location.search).get("bus");
  const wanted = fromPage ?? process.env.NEXT_PUBLIC_CV_BUS_URL ?? DEFAULT_BUS_URL;
  if (wanted === "off") return null;
  try {
    const url = new URL(wanted);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if ((url.protocol === "ws:" || url.protocol === "wss:") && local) return url.toString();
  } catch {
    // not an address
  }
  console.warn(`[cv bus] ignoring bus address ${JSON.stringify(wanted)}: use ws://127.0.0.1:<port>/ws or "off".`);
  return null;
}

const noSubscription = () => () => {};

/**
 * Connect this page to the camera service as its board page. Messages go to `onEvent`
 * (pointer events many times a second, so it should not set React state for those).
 * Gives the connection status, whether the bus is on at all, and a way to send messages.
 */
export function useCvBus(onEvent: (event: BusEvent) => void) {
  // The address depends on the page's own address, which the server rendering doesn't know.
  const url = useSyncExternalStore(noSubscription, busUrl, () => null);
  const [status, setStatus] = useState<BusStatus>({
    connection: "connecting",
    camera: null,
    calibration: null,
    tracking: null,
  });
  const socketRef = useRef<WebSocket | null>(null);

  const latest = useRef(onEvent);
  useEffect(() => {
    latest.current = onEvent;
  });

  const send = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    if (!url) return;
    const address = url;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let stopped = false;

    // Tell the service how big the board page is: its positions are in these CSS pixels.
    const hello = () =>
      send({
        type: "hello",
        role: "board",
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      });

    const retry = () => {
      if (stopped) return;
      setStatus({ connection: "closed", camera: null, calibration: null, tracking: null });
      retryTimer = setTimeout(connect, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
    };

    function connect() {
      try {
        socket = new WebSocket(address);
      } catch {
        retry();
        return;
      }
      socketRef.current = socket;
      socket.onopen = () => {
        failures = 0;
        setStatus((current) => ({ ...current, connection: "open" }));
        hello();
      };
      socket.onmessage = (message) => {
        let data: unknown;
        try {
          data = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const event = parseBusEvent(data);
        if (!event) return;
        if (event.type === "camera" || event.type === "calibration" || event.type === "tracking") {
          const { type, status: state, message: text } = event;
          setStatus((current) => ({ ...current, [type]: { status: state, message: text } }));
        }
        latest.current(event);
      };
      socket.onclose = retry;
    }

    connect();
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(hello, 200);
    };
    window.addEventListener("resize", onResize);

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      socket?.close();
      socketRef.current = null;
    };
  }, [url, send]);

  return { enabled: url !== null, status, send };
}
