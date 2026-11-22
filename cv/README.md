# CV service (role B)

The camera side of the projected whiteboard. One Python process owns the camera and
publishes everything it sees as JSON events on a WebSocket that the web app listens to.
See [`docs/02-technical-design.md`](../docs/02-technical-design.md) for the design.

Status: **Phase 5** (all CV phases done). Camera, event bus, fake finger, preview, debug
page, manual and automatic (ArUco) calibration, hand tracking, the five agreed gestures,
reading physical writing, and noticing camera moves with automatic re-calibration work.

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
| `--no-gestures` | `CV_GESTURES=0` | on | No hand tracking or gestures |
| `--no-auto-recalibrate` | `CV_AUTO_RECALIBRATE=0` | on | Only warn when the camera moves |
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
| `/calibrate` | Operator page for calibration (automatic and manual) |
| `/gestures` | Gesture Lab: try the gestures and see what the hand tracker sees |
| `/markers` | Printable markers (ids 40-47) to stick around the board |

## Automatic calibration (ArUco markers)

The quickest way, and the one to use for the demo. Set up the projector, board and camera
first and keep them still.

1. Open the board page fullscreen on the projector (for now `/debug`), in front: browsers
   don't draw hidden tabs, and the service waits for the board page to confirm.
2. Open <http://127.0.0.1:8765/calibrate> and press **Auto calibrate**.
3. The board turns white with 12 markers (4 x 3) for a few seconds. The service grabs 15
   frames, takes the median of every corner, fits the mapping (ignoring stray corners),
   and checks it: at least 4 markers, spread across the board, average error under 3 px.
   It tries 3 times, then saves the result or says exactly what went wrong.
4. Check it with **Check mode**, as below.

If it fails: make sure the camera sees the whole board, the room is not too bright, the
projector's keystone correction is off, and nothing covers the board.

## Manual calibration (four corners)

The fallback when the markers can't be found (for example a very dim projector).

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

## Noticing camera moves (automatic re-calibration)

1. Open <http://127.0.0.1:8765/markers>, print at 100% scale, cut out 3 or 4 markers (keep
   the white border) and stick them around the board, **outside the projected picture**,
   on things that never move, where the camera can see them.
2. Calibrate. The service remembers where those printed markers are.
3. A few times a second it looks for them again. If most of them have moved (median shift
   over 4 px, seen 3 checks in a row, so a hand passing by doesn't count), the calibration
   turns **stale** with "The camera moved…". Once the camera has been still for a moment it
   recalibrates by itself (the demo finale: nudge the phone, the board works again).
4. If the camera is put back where it was, the old calibration is trusted again.

With `--no-auto-recalibrate` it only marks the calibration stale. Without printed markers
everything else works; camera moves just aren't noticed (`drift` status `off`).

```json
{ "type": "drift", "status": "moved", "shift_px": 13.9, "seen": 4, "message": "The camera moved; waiting for it to be still…" }
```

`drift.status`: `off` (no printed markers at calibration), `unknown` (fewer than 2 visible
now), `steady`, `checking`, `moved`, `recalibrate`.

## Reading the board (physical writing)

Finds marker writing and printed sheets that are physically on the board, and gives the AI
a straight-on picture of them. Needs a calibration (status `ok`).

1. A page sends `read_board` (optionally with `bbox`, an area in board px).
2. Board pages cover that area with plain white (hiding digital ink) and confirm with
   `flash_shown`; the service waits a moment, takes the median of 5 frames, then removes the white.
3. It straightens the area with the calibration, finds the writing (clearly darker than the
   board around it; strokes close together become one region; specks are ignored), and sends
   `content_regions` (where the writing is, so the UI keeps clear of it) and `content_capture`
   (the straightened picture as a PNG data URL, for the AI to read).

Try it on `/calibrate` → **Read the whole board**: it shows the picture with the writing
outlined. The board page outlines the writing in orange too.

```json
{ "type": "read_board", "bbox": [0, 0, 700, 800] }
{ "type": "flash", "run": 3, "color": "white", "bbox": [0, 0, 700, 800] }
{ "type": "flash_shown", "run": 3 }
{ "type": "flash", "run": null, "color": "white", "bbox": null }
{ "type": "content_regions", "regions": [{ "id": "r1", "kind": "physical", "bbox": [146.2, 136.4, 428.9, 78.9] }] }
{ "type": "content_capture", "image": "data:image/png;base64,...", "bbox": [0, 0, 700, 800], "regions": ["..."] }
{ "type": "board_read", "status": "ok", "message": "Found 3 pieces of writing." }
```

`board_read.status` is `reading` (with the step), `ok` or `error` (with the reason, such as
"Calibrate first"). Reading and calibrating take turns: both use the projector. Areas are
cut to the board, and the white reaches 20 px past the area so calibration slack never
pulls the board's frame into the picture. Board pages clear the white if they disconnect.

## Gestures (agreed with the team)

Hand tracking runs with the camera (MediaPipe, up to two hands, about 20 ms a frame) and
turns hand shapes into the events below. Details in
[`docs/02-technical-design.md`, section 5](../docs/02-technical-design.md#5-gestures).
**Try them on the Gesture Lab: <http://127.0.0.1:8765/gestures>.** It shows the camera with
each hand's skeleton and pose, the live measurements behind the pose next to their
thresholds (thumb–index gap, curled and straight fingers), a card per gesture that lights
up when it fires (with a counter and a visual: tool badge, sliding board, turning cube,
zoom box, reset ring), and a plain-language log of what happened. Tune thresholds in
`hand_pose.py` (pose shapes) and `gestures.py` (timings).

| Gesture | Action |
|---------|--------|
| Index finger touching the board | Draw or erase (the `pointer` event: index fingertip, landmark 8) |
| Thumb + index double tap in the air | Pen ↔ eraser; with no tool selected, the eraser |
| Open hand → fist, move | Move the board; open the hand to stop |
| Thumb + index pinch and hold, move | Rotate a 3D model |
| Pinch with both hands, apart / together | Zoom in / out |
| Both hands open, palms to the camera, still for 2 s | Reset the view (board position, zoom, 3D angle). View only: never touches the writing; Undo brings back erased ink |

### Gesture events

Positions are board px when calibrated. Before calibration they are camera px in a
**mirror view** (x flipped, like a selfie), because a camera facing you sees your right
as its left: this way moving your hand right moves things right. `hands.calibrated` says
which; `camera_points` are always raw camera px. `dx`/`dy` are the change since the
previous `move`.

```json
{ "type": "gesture", "name": "double_tap", "hand": "Right", "t": 1767000000.1 }
{ "type": "pan", "phase": "start", "x": 640.0, "y": 400.0, "hand": "Right", "t": 1767000000.2 }
{ "type": "pan", "phase": "move", "x": 642.0, "y": 410.0, "dx": 2.0, "dy": 10.0, "hand": "Right", "t": 1767000000.3 }
{ "type": "rotate", "phase": "move", "x": 520.0, "y": 300.0, "dx": 4.5, "dy": -1.0, "hand": "Left", "t": 1767000000.4 }
{ "type": "zoom", "phase": "move", "scale": 1.35, "cx": 640.0, "cy": 400.0, "t": 1767000000.5 }
{ "type": "reset_progress", "progress": 0.45, "t": 1767000000.6 }
{ "type": "gesture", "name": "reset", "t": 1767000001.0 }
{ "type": "hands", "calibrated": true, "hands": [{ "hand": "Right", "pose": "pinch",
  "palm": [600.0, 420.0], "index_tip": [560.0, 300.0], "pinch": [552.0, 304.0],
  "camera_points": [[612.0, 530.5], "... 21 points, camera px"], "gap": 0.12, "curled": 3, "extended": 1 }] }
{ "type": "tracking", "status": "ok", "message": "", "fps": 30.2 }
```

What the web app does with them:

- `double_tap`: pen → eraser, eraser → pen; with no tool selected, the eraser.
- `pan`: move the board by `dx`, `dy` on every `move`.
- `rotate`: turn the 3D model under `x`, `y` (from `start`) by `dx`, `dy`.
- `zoom`: `scale` is relative to the zoom when the gesture started, centred on `cx`, `cy`.
- `reset_progress`: draw a countdown ring (`0` hides it); `reset` puts the view back
  (board position, zoom, 3D angle) and never touches the writing.
- `zoom` `end` and `pan`/`rotate` `end` may have `null` positions; keep the last ones.

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
{ "type": "calibrate_auto" }
{ "type": "calibration_pattern_shown", "run": 1 }
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
{ "type": "calibration_pattern", "run": 1, "markers": [{ "id": 0, "x": 51.2, "y": 64.8, "size": 152.1, "png": "data:image/png;base64,..." }] }
```

`calibration.status` is `none`, `ok`, `stale` (board or camera size changed), `calibrating`
(an automatic calibration is running; `message` says which step) or `error` (the last
attempt failed; `message` says why). A board page should draw
`calibration_targets` as numbered crosses (an empty list hides them) and briefly draw a
cross at each `calibration_probe`.

On `calibration_pattern`, a board page covers itself in pure white and draws each marker
PNG at `x`, `y` with width and height `size` (CSS px, `image-rendering: pixelated`), then
sends `calibration_pattern_shown` with the same `run` number once every image has loaded and
been painted (a reply for an older `run` is ignored). An empty list
removes the white layer. Marker ids 0-11 are the projected grid; 40-47 are kept for printed
markers around the board.

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
