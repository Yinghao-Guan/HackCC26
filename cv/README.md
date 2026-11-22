# CV service (role B)

The camera side of the projected whiteboard. One Python process owns the camera and
publishes everything it sees as JSON events on a WebSocket that the web app listens to.
See [`docs/02-technical-design.md`](../docs/02-technical-design.md) for the design.

Status: **Phase 0** (scaffold). Camera, event bus, fake finger, preview and debug page work.
Calibration, hand tracking, gestures, reading the board and drift detection come next.

## Setup

Needs [uv](https://docs.astral.sh/uv/). uv installs Python 3.13 and the packages by itself.

```bash
cd cv
uv sync                                   # create .venv and install
uv run python -m hackcc_cv.models         # download the hand model (7.8 MB, once)
uv run python -m hackcc_cv.probe          # list cameras; close Teams/Zoom first
uv run python -m hackcc_cv --fake         # start the service with a fake finger
```

Then open <http://127.0.0.1:8765/debug>. Use `127.0.0.1`, not `localhost`: the server
listens on IPv4 only, and `localhost` can resolve to IPv6.

## Options

Flags win over environment variables, which win over the defaults.

| Flag | Environment | Default | Meaning |
|------|-------------|---------|---------|
| `--camera N` | `CV_CAMERA_INDEX` | `0` | Which camera (see `probe`) |
| `--backend` | `CV_CAMERA_BACKEND` | `dshow` | `dshow`, `msmf` or `any`. On Windows `msmf` can start with black frames |
| `--width` / `--height` | `CV_WIDTH` / `CV_HEIGHT` | `1280` / `720` | Requested camera size |
| `--fake` | `CV_FAKE_POINTER=1` | off | Publish a fake finger drawing a figure eight |
| `--no-camera` | `CV_CAMERA=0` | camera on | Run without opening a camera |
| `--port` | `CV_PORT` | `8765` | Server port (binds to 127.0.0.1) |
| | `CV_ALLOWED_ORIGINS` | localhost:3000 and :8765 | Comma-separated web pages allowed to connect |

## Routes

| Route | What |
|-------|------|
| `ws://127.0.0.1:8765/ws` | The event bus |
| `/health` | Status as JSON: camera, clients, display size |
| `/preview.mjpg` | Live camera view with the frame rate |
| `/debug` | Test page: connection, camera status, fake ink, preview |

## Events

All positions are **board pixels**: CSS pixels of the fullscreen board page in the
browser. The browser says how big that is when it connects, so screen scaling and the
projector's resolution do not matter.

Browser to server:

```json
{ "type": "hello", "width": 1707, "height": 1067, "dpr": 1.5 }
{ "type": "ping" }
```

Server to browser:

```json
{ "type": "camera", "status": "ok", "message": "", "width": 1280, "height": 720, "fps": 30.0 }
{ "type": "hello_ack", "display": { "width": 1707, "height": 1067, "dpr": 1.5 } }
{ "type": "pointer", "id": 0, "x": 812.4, "y": 440.1, "touching": true, "t": 1767000000.123 }
{ "type": "pong", "t": 1767000000.5 }
{ "type": "error", "message": "Unknown message type 'teleport'." }
```

`camera.status` is `ok`, `error` (with a message), `off` or `starting`. The page should
say so when it is not `ok`, rather than silently doing nothing.

The most recent `hello` sets the board size for everyone, so keep only one board page
open at a time (the `/debug` page sends a `hello` too).

## Security

The service binds to `127.0.0.1`, answers only requests addressed to `127.0.0.1` or
`localhost` (blocks DNS-rebinding pages from reading the camera), and refuses WebSocket
connections from pages not listed in `CV_ALLOWED_ORIGINS`.

## Using it from the web app

```ts
const socket = new WebSocket("ws://127.0.0.1:8765/ws");
socket.onopen = () =>
  socket.send(JSON.stringify({
    type: "hello", width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
  }));
socket.onmessage = (m) => {
  const event = JSON.parse(m.data);
  if (event.type === "pointer") { /* draw when event.touching */ }
};
```

Run the service with `--fake` to build against it before the camera parts are ready.

## Tests

```bash
uv run pytest --cov=hackcc_cv --cov-report=term-missing
```

Tests use fake cameras and synthetic images, so they run without hardware.

## Library notes (checked November 2026)

- **OpenCV 5.1** removed `cv2.aruco.detectMarkers()`. Use
  `cv2.aruco.ArucoDetector(dictionary, parameters).detectMarkers(image)`.
- **MediaPipe 1.2** removed `mp.solutions.hands`. Use the Tasks API
  (`mediapipe.tasks.python.vision.HandLandmarker`, `RunningMode.VIDEO`) with
  `models/hand_landmarker.task`.
- Only one program can open a webcam on Windows. Stop the service before running `probe`.
