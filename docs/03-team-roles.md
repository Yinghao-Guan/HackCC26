# 03 · Team Roles and Plan

_Last updated: 2026-10-27. Four people, one project. Assign names in the table below._

| Role | Area | Owner |
|------|------|-------|
| A | Interaction | _____ |
| B | CV | _____ |
| C | UI | _____ |
| D | AI | _____ |

## 1. Responsibilities

### A · Interaction

Own: hand tracking, shadow-based touch detection, pen strokes.

- Detect whether the finger touches the board and where (in projector pixels).
- Pen drawing with stroke smoothing (One Euro filter is a good default).
- Standalone goal: draw and write on the board with a finger, reliably, **by itself**.
- **Proposed:** A runs the single hand-tracking stream and publishes landmarks for B.

### B · CV

Own: calibration, gestures, reading physical content.

- Recognise the double tap gesture (thumb and index finger, in the air).
- Read printed sheets and marker writing on the board, and know **where** they are (bounding boxes in projector pixels).
- Control the flash: ask for pure white or black at the right moment, and capture.
- **Proposed:** B also owns ArUco calibration, the homography, verification, the drift monitor and automatic re-calibration (it already controls when the projector goes white or black).
- Until B's calibration is ready, A works with a manual four-corner homography.

### C · UI

Own: everything the projector shows.

- Buttons, the whiteboard canvas, panels.
- Math display: 2D function plots and 3D plots with the three view controls.
- AI text output, step-by-step solutions in KaTeX.
- **Layout engine:** every output is placed so it covers neither digital content nor physical writing and paper (uses B's content regions).
- Pre-warp the UI with the calibration so it looks right on a tilted board.

### D · AI

Own: all model and voice integration.

- Text in and out; ElevenLabs speech to text and text to speech (ElevenLabs is a HackCC sponsor).
- Multimodal handwriting recognition (strokes image or camera crop to LaTeX).
- Solve and explain; find the wrong step (returns step number, explanation, corrected continuation, bounding box).
- **Proposed extra duties** (D has the lightest early load):
  - build the WebSocket event bus
  - verify AI answers with `sympy`
  - help C with the 3D view, or build step 5 (error finding) end to end

## 2. Who needs what from whom

| From | To | What |
|------|----|------|
| A | B | Hand landmarks (one stream) |
| B | A | Homography (until then: manual four-corner) |
| A | C | Pointer events `{x, y, touching}` |
| B | C | Gesture events, content regions, calibration status |
| C | B | Requests: flash white/black, re-calibrate |
| C | D | Strokes image, voice trigger, selected region |
| D | C | AI results (LaTeX, steps, error check) with anchor boxes |
| B | D | Rectified camera crop of physical content |

## 3. First hour: agree on the contract

- All coordinates in **projector pixels**.
- Event formats from [technical design, section 9](02-technical-design.md#9-event-bus-draft-v0-agree-on-this-in-the-first-hour).
- Write the **fake event emitter** now. C and D build against it; A and B replace it later.
- Decide the transport (WebSocket) and who starts the server.

## 4. Priorities and cut lines

| Priority | Content |
|----------|---------|
| Must have | Demo steps 1, 2, 4 (draw/erase, function graph, voice solve) |
| Second | Step 5, find the wrong step (mostly D plus C; strongest educational value) |
| Last | Step 3 in full: physical reading plus 3D with gestures |
| Stretch | Re-calibration finale (nearly free if calibration is automatic) |

Cut order if time runs short: two-finger gestures → physical reading → circling the wrong step (keep the text explanation).

## 5. Timeline (assuming about 20 hours of real development)

| Time | Goal |
|------|------|
| Before the event | Prototype the pure-CV shadow touch version. Validate: shadow visibility, calibration automation, camera to laptop link. Decide the fallback (section 6) |
| Hour 0–3 | Skeleton, contract, fake emitter. A gets draw-a-line working. Everyone else works on mock input |
| Hour 3–8 | Steps 1, 2, 4 connected end to end |
| Hour 8–14 | Step 5. Step 3 basic: 3D plot from an on-screen equation plus voice |
| Hour 14–18 | Integration, stability, full demo run-throughs |
| Final 2 hours | No new features. Record a backup video, rehearse, write the Devpost text |

If HackCC gives fewer hours, cut from the bottom of the priority table, not from the middle.

## 6. Risks specific to roles

- **A is a single point of failure.** If shadow touch is not reliable before the event, decide a stop-loss early: dwell-to-touch, a white spot near the fingertip, or button-first UI. See [technical design, section 4](02-technical-design.md#4-touch-detection-with-the-shadow).
- **C depends on B** for "do not cover physical writing". Physical regions only update on trigger; do not assume real-time.
- **D must return structured JSON** with positions so that C can render without guessing.

## 7. Demo video and pitch

- **Backup demo video:** whoever finishes their part first records it (one per demo step, plus a full take). It is the fallback if a gesture is unstable on stage.
- **Pitch:** improvised from the storyline in the [overview](01-project-overview.md#6-pitch-storyline); no script needed. Rehearse in the time between the Devpost deadline and the start of judging.
