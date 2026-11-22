# CV service (role B)

The camera side of the projected whiteboard. One Python process owns the camera and
publishes everything it sees as JSON events on a WebSocket that the web app listens to.
See [`docs/02-technical-design.md`](../docs/02-technical-design.md) for the design.

Status: **Phase 1**. Camera, event bus, fake finger, preview, debug page and the manual
four-corner calibration work. ArUco auto-calibration, hand tracking, gestures, reading the
board and drift detection come next.

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
| | `CV_DATA_DIR` | `cv/data` | Where calibrations are saved (git-ignored) |

## Routes

| Route | What |
|-------|------|
| `ws://127.0.0.1:8765/ws` | The event bus |
| `/health` | Status as JSON: camera, clients, display size |
| `/preview.mjpg` | Live camera view with the frame rate |
| `/debug` | Test board page: connection, camera and calibration status, fake ink, targets |
| `/calibrate` | Operator page for the manual four-corner calibration |

## Manual calibration (four corners)

Maps camera pixels to board pixels so a finger on the board lands in the right place.
Do it after the projector, board and camera are fixed in place.

1. Open the board page fullscreen on the projector (for now `/debug`; later the web app).
2. Open <http://127.0.0.1:8765/calibrate> on the laptop. If the laptop screen *is* the
   projector (mirrored), tick "This screen is the projector".
3. Press **Show targets**. Four numbered crosses appear on the board, 10% in from the edges.
4. In the camera image, click the centre of each cross in order **1 → 4**
   (top-left, top-right, bottom-right, bottom-left).
5. The status turns **ok**. Tick **Check mode** and click anywhere on the board in the
   camera image: a red cross should appear on that spot on the board.

The result is saved to `cv/data/calibration.json` (with a timestamped copy in
`cv/data/history/`) and loaded again when the service starts. It is marked **stale** when
the board page or camera image changes size: then calibrate again.

## Gestures (agreed with the team)

Built in a later phase; listed here so every part plans for them. Details in
[`docs/02-technical-design.md`, section 5](../docs/02-technical-design.md#5-gestures).

| Gesture | Action |
|---------|--------|
| Index finger touching the board | Draw or erase (the `pointer` event: index fingertip, landmark 8) |
| Thumb + index double tap in the air | Pen ↔ eraser; with no tool selected, the eraser |
| Open hand → fist, move | Move the board; open the hand to stop |
| Thumb + index pinch and hold, move | Rotate a 3D model |
| Pinch with both hands, apart / together | Zoom in / out |
| Both hands open, palms to the camera, still for 2 s | Reset the view (board position, zoom, 3D angle). View only: never touches the writing; Undo brings back erased ink |

## Events

All positions are **board pixels**: CSS pixels of the fullscreen board page in the
browser. The browser says how big that is when it connects, so screen scaling and the
projector's resolution do not matter.

Browser to server:

```json
{ "type": "hello", "width": 1707, "height": 1067, "dpr": 1.5, "role": "board" }
{ "type": "ping" }
{ "type": "calibrate_manual_start" }
{ "type": "calibrate_manual", "camera_points": [[300,120],[1100,180],[1040,640],[260,600]], "camera_size": [1280,720] }
{ "type": "calibrate_cancel" }
{ "type": "map_point", "camera_point": [640, 360] }
```

`role` is `board` (the page on the projector; it sets the board size) or `operator`
(the calibrate page on the laptop; it does not). It defaults to `board`.

Server to browser:

```json
{ "type": "camera", "status": "ok", "message": "", "width": 1280, "height": 720, "fps": 30.0 }
{ "type": "hello_ack", "display": { "width": 1707, "height": 1067, "dpr": 1.5 } }
{ "type": "pointer", "id": 0, "x": 812.4, "y": 440.1, "touching": true, "t": 1767000000.123 }
{ "type": "pong", "t": 1767000000.5 }
{ "type": "error", "message": "Unknown message type 'teleport'." }
{ "type": "calibration", "status": "ok", "message": "", "method": "manual", "reproj_error_px": 0.0, "points": 4,
  "camera_size": [1280, 720], "board_size": [1707, 1067], "created_at": 1767000000.0 }
{ "type": "calibration_targets", "targets": [{ "id": 1, "x": 170.7, "y": 106.7 }] }
{ "type": "calibration_probe", "x": 812.4, "y": 440.1, "camera_x": 640, "camera_y": 360 }
```

`calibration.status` is `none`, `ok`, `stale` (board or camera size changed) or `error`
(the last attempt failed; `message` says why). A board page should draw
`calibration_targets` as numbered crosses (an empty list hides them) and briefly draw a
cross at each `calibration_probe`.

`camera.status` is `ok`, `error` (with a message), `off` or `starting`. The page should
say so when it is not `ok`, rather than silently doing nothing.

The most recent `hello` with role `board` sets the board size for everyone, so keep only
one board page open at a time (the `/debug` page is a board page).

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
