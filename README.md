# HackCC26

A projected, interactive, AI-assisted whiteboard, built for HackCC 2026 (Education). Any whiteboard, a projector and a phone camera become a smart board you can write on with a finger and talk to.

Project docs (overview, technical design, team roles, hardware, checklist) are in [`docs/`](docs/).

## Stack

- [Next.js](https://nextjs.org) (App Router) with TypeScript
- Tailwind CSS v4
- ESLint
- npm
- Claude API (`@anthropic-ai/sdk`) for reading handwriting and solving math, KaTeX for showing math

## Getting started

```bash
npm install
cp .env.example .env.local   # then put your Claude API key in .env.local
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Whiteboard tools

- **Pen**: draw with the mouse (or a finger or stylus).
- **Eraser**: *Pixel* rubs out part of a stroke; *Stroke* removes a whole stroke or text box with one touch.
- **Text**: click the board and type. Enter adds a line; Esc or clicking away finishes. Click text to edit it. Typed text is part of the board, so it can be erased, undone, and read by the AI.
- **Move**: drag the board to move around. The mouse wheel or trackpad scrolls it too, and so does dragging with the middle mouse button. The board is endless; **Reset view** goes back to the start. **Solve** reads only what is on screen.

## AI: Solve

Write a math problem on the board and press **Solve** in the side panel. The board's ink is sent to the Claude API (through the route in `src/app/api/solve/`), which reads the handwriting and solves it. The reading, the steps and the answer are written on the board next to the problem. This needs `ANTHROPIC_API_KEY` in `.env.local` (git-ignored); restart `npm run dev` after changing it.

## AI: Graph

Write an equation (or a few, like a system) and press **Graph**. Claude reads them through `src/app/api/graph/` and says how to plot each one: a formula and a sensible window. The board then draws the curves itself, as a crisp SVG with axes and a color key, next to your writing. Explicit functions (`y = x^2 - 3x + 2`, lines, `sin`, `1/x`) and implicit ones (circles, hyperbolas) both work. If what is on screen is only **typed** equations (Text tool) that follow the usual forms, the graph is drawn right away on your machine: no AI call, no waiting (about 14 ms in testing), and it works offline. Handwriting, sentences, LaTeX and anything unclear still go to Claude (a few seconds). The formula evaluator is in `src/lib/expression.ts` and the drawing math is in `src/lib/plot.ts`; neither needs a library.

### 3D graphs

If an equation uses `z`, **Graph** shows a 3D view instead: surfaces such as `z = x^2 + y^2`, planes, and systems of planes (three planes that meet in one point get that point marked, e.g. `(1, 2, 3)`). Drag to turn it, scroll or pinch to zoom, right-drag or use two fingers to move it, and use the **−**, **+** and **Reset** buttons if you prefer. Typed equations of these forms are drawn instantly on your machine. Anything else (handwriting, a sphere such as `x^2 + y^2 + z^2 = 9`) goes to Claude, which splits curved shapes into surfaces that are a function of the other two variables (a sphere becomes a top and a bottom half). The 3D view uses [three.js](https://threejs.org), loaded only when a 3D graph is shown; the mesh math is in `src/lib/surface.ts`.

## AI: Check (find the mistake)

Write a problem and your worked steps, one step per line, and press **Check**. The board's ink is split into lines on your machine and sent to Claude (through `src/app/api/check/`) with a red number beside each line. Claude finds the **first** step that does not follow, says why, shows how that line should read, carries on to the right answer, and the wrong line is circled on the board with a **Step N** tag. If all the steps are right, it says so instead. Because the line numbers come from our own line-splitting, the circle always lands on the line Claude meant. Leave a little space between lines so they can be told apart.

## Camera test (groundwork for shadow touch)

Open [http://localhost:3000/camera-test](http://localhost:3000/camera-test) on the laptop while the whiteboard (`/`) is on the projector. It is for trying a camera setup before the shadow touch detection is built on it:

- **Camera**: pick any camera the browser can see, including a phone camera app that shows up as a webcam (such as Camo Studio). Choose the resolution, and mirror the picture if needed. The page remembers the last camera you used.
- **Hand tracking**: [MediaPipe](https://ai.google.dev/edge/mediapipe) finds the hand and draws it on the picture, in the browser, so camera frames never leave the computer. It shows the index fingertip, frames per second, model time per frame, the share of frames with no hand, and fingertip jitter, so camera angles can be compared with numbers. The hand model (about 8 MB) and the library's WebAssembly files are downloaded from Google's model storage and the jsDelivr CDN each time the page loads, so it needs the internet.
- **Writing pose**: writing is only to be allowed when only the index finger is out (👆), so the pinch gesture and other hand shapes can never draw. `src/components/camera/pose.ts` measures how far each fingertip is from its knuckle in the picture, in hand sizes, and says the hand is in the pose when the index finger reaches far and the middle, ring and little fingers reach much less. It uses the picture, not the model's 3D guess, because writing is done with the back of the hand to the camera, where the curled fingers are hidden and the 3D guess for them is unreliable. The fingertip ring turns green in the pose and red out of it, and a slider sets how short the other fingers must be. The threshold has not been tuned on a real camera yet.
- **Shadow touch**: whether the fingertip touches the board, from its shadow. The projector lights the board, so the hand casts a shadow; the higher the finger, the farther the shadow is from the fingertip, and at contact they meet. Press **Capture empty board** with your hand away to take a reference picture, then `src/components/camera/shadowTouch.ts` marks every pixel clearly darker than the reference (and outside the hand's outline) as shadow. It then finds the tip of the fingertip's own shadow, the shadow that reaches farthest ahead along the finger inside a box laid along it, and measures the gap from the fingertip to that shadow tip, in hand sizes so it means the same near and far. (The nearest shadow of any kind does not work: the shadow of the arm and the rest of the hand lies close to the fingertip even when the finger is high.) The page paints the shadow it found cyan, draws the box and a line to the shadow tip, and plots the gap over the last 6 seconds next to the touch thresholds. **Save touching snapshot** and **Save hovering snapshot** save the camera picture, the empty board and the hand's landmarks as a JSON file in the Downloads folder, so the detection can be tuned on real frames. A touch needs the gap below a threshold for two frames in a row, with a higher threshold for letting go. **Writing** is shown only when the hand is in the 👆 pose *and* touching. The thresholds have not been tuned on a real camera yet. Projected ink is as dark as a shadow, so it would count as shadow if it appeared after the reference was taken.
- **Brightness probe**: hover over the picture to read the brightness under the pointer, click to pin a spot, and read the difference between the board and the finger's shadow. Dark areas can be painted red above a brightness you choose.

The pose check and the shadow touch are not connected to the whiteboard yet: the whiteboard still takes mouse input only.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Start the dev server |
| `npm run build` | Type-check and build for production |
| `npm run start` | Serve the production build |
| `npm run lint` | Run ESLint |

## Project layout

```
src/app/                    App Router: layout, pages, global styles
src/app/api/solve/          Server route: reads the board image and solves it
src/app/api/graph/          Server route: reads the board image and lists the curves or surfaces to graph
src/app/api/check/          Server route: reads numbered lines of work and finds the first mistake
src/app/camera-test/        Page for trying a camera setup
src/components/whiteboard/  Drawing canvas, stroke model, settings panel, answer, graph (2D and 3D) and check cards
src/components/camera/      Camera test page, hand tracking, writing pose, brightness and stability measurements
src/lib/                    Code shared by the server and the browser
docs/                       Project documentation
```
