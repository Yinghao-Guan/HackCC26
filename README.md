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

- **Pen**: draw with the mouse (or a finger or stylus on a touch screen). It draws in white, for the projected gray board, at a fixed size; the panel has no color or size choice. The board is fixed at 35% brightness (`boardBrightness` in `settings.ts`), which cut the projector's glare enough in testing. Everything projected on the board is black, white or gray (the AI buttons, the cards, the graphs, the Check ring), so that the camera can find the blue cap of the marker that presses the buttons. To write on the real board with a marker, see *Writing with a marker, pressing buttons with a capped marker*.
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
- **Shadow touch**: whether the fingertip touches the board, from its shadow. The projector lights the board, so the hand casts a shadow; the higher the finger, the farther the shadow is from the fingertip, and at contact they meet. Press **Capture empty board** with your hand away to take a reference picture, then `src/components/camera/shadowTouch.ts` marks every pixel clearly darker than the reference (and outside the hand's outline) as shadow. It then measures how far the shadow reaches past the fingertip along the finger, inside a box laid along the finger, in hand sizes so it means the same near and far. When the finger is above the board, the shadow's tip shows up ahead of the fingertip. When the finger touches, it hides its own shadow, so the shadow stops at the fingertip or behind it and the reading is 0. (Measuring the distance to the shadow's far tip, or to the nearest shadow, does not work: when the finger touches, what is left is a bump of the hand's shadow at the knuckle, far behind the fingertip, which looks like a tip; and the shadow of the arm lies close to the fingertip even when the finger is high.) This assumes the light comes from behind the hand, so that the shadow falls ahead of the fingertip when it is above the board. The hand is hidden from the shadow search finger by finger (a thin line along each finger, the palm and the forearm), because one shape around the whole hand also covers the lit board between the fingers. The edge of the skin is then found by color: the skin color is read from the index finger on every frame, and dark pixels of that color are set aside as the hand (orange on the page) instead of being taken for shadow, because a shadow is more gray than skin. A shadow only counts as touching if it lies against the hand: with no shadow near the hand, or shadow somewhere else, as with a hand far above the board, the reading is empty and it is not a touch. The page paints the shadow it found cyan, draws the box, a line across the finger at the fingertip and a line to the far end of the shadow, and plots the reading over the last 6 seconds next to the touch thresholds. **Save touching snapshot** and **Save hovering snapshot** save the camera picture, the empty board and the hand's landmarks as a JSON file in the Downloads folder, so the detection can be tuned on real frames. A touch needs the gap below a threshold for two frames in a row, with a higher threshold for letting go. **Writing** is shown only when the hand is in the 👆 pose *and* touching. The thresholds have not been tuned on a real camera yet. Projected ink is as dark as a shadow, so it would count as shadow if it appeared after the reference was taken.
- **Brightness probe**: hover over the picture to read the brightness under the pointer, click to pin a spot, and read the difference between the board and the finger's shadow. Dark areas can be painted red above a brightness you choose.

## Writing with a marker, pressing buttons with a capped marker

Write on the board with an ordinary whiteboard marker, and press the whiteboard's buttons with a marker that has its blue cap on (or with a finger). The camera page and the whiteboard are two pages of the same browser, and talk over a `BroadcastChannel` (`src/lib/boardLink.ts`; no server).

**Setup**

1. Open the whiteboard (`/`) in a window on the projector, and the camera page (`/camera-test`) on your screen, in the same browser. Keep both visible: a window that is covered or minimized stops working.
2. On the camera page, start the camera, take your hand away, and press **Calibrate**. The whiteboard turns all white for a moment, then shows nine black squares on the white; the camera page compares the two pictures to find the squares in the camera picture (white everywhere gives every square the same strong contrast, which the dim gray board did not) (`src/components/camera/calibrate.ts`), and a homography fitted to them (`homography.ts`) turns a point in the camera picture into a position in the whiteboard window. The result is remembered; make it again whenever the camera, the projector or the board is moved. This is the manual-calibration fallback of the design docs; automatic calibration with ArUco markers can replace it later by producing the same matrix.

**Reading the marker writing.** Reading happens only when someone asks, never on its own: pressing **Solve**, **Graph** or **Check** (with a finger or the mouse) is the signal that the writing is ready, as the design docs ask for (docs/02-technical-design.md, section 6). The whiteboard then asks the camera page for a picture of its drawing area. The camera page waits for the hand to leave the camera's view, the whiteboard clears its drawing area to plain board color for about half a second (so the dot grid, cards and digital ink are not in the picture), and the camera page averages a few full-size frames, straightens them into the whiteboard's layout with the inverse of the calibration, and cleans them up (`src/components/camera/boardPicture.ts`): the board's own brightness is measured square by square (so uneven lighting and a glare spot are not taken for writing), pixels clearly darker than it are writing, and specks and marks that reach the edge (the board's frame) are dropped. Back on the whiteboard, anything drawn with the mouse is painted on top (`exportBoardPicture` in `exportInk.ts`), and the result goes to the AI as before: the answer card is placed next to the marker writing, and Check circles the wrong line of marker writing on the board. Without the camera page (closed, not calibrated, or hidden), the buttons read the digital ink as before.

**Pressing buttons with a capped marker** (the default; **Press the buttons with** on the camera page switches to a finger). Hold a whiteboard marker with its blue cap on like a pen and touch the board with the tip of the cap. A fingertip is a poor pointer for the camera: the hand model places it only to a few pixels, and a finger is wide enough to hide its own shadow. The pen is straight, thin and has one tip, and it needs no hand model. `src/components/camera/penTip.ts` finds the cap by its color: pixels clearly bluer than the empty board at the same spot. Not blue by a fixed amount: through the real camera the 35% gray board looked lavender (blue share 0.41 to 0.43), as blue as a fixed threshold, and the whole board was taken for a cap. The empty board's color is captured with its brightness, and the cap has to beat the bluest board within a couple of pixels, because the edges of the blue Graph button and of its white label otherwise looked a little bluer than the board and were taken for a cap. Over something already blue, such as the Graph button, the cap is lit blue too, so there it counts when it is as blue but clearly darker. The cap is only looked for on the whiteboard window and a little around it (from the calibration), so blue jeans at the side of the picture are ignored, and near a hand when the hand model sees one. It is found roughly in the shrunk picture, then measured in a piece of the full-size picture around it: the blue is grown into the cap's darker shaded side, the cap's line, width and two ends come from how its pixels spread, and the tip is the end away from the hand (or where the tip was a frame ago). Its shadow is the patch of pixels near the tip that are clearly darker than the empty board and are not the cap or skin. Cap and shadow make a "V" that closes at the tip when the pen touches the board, so touch is read from the gap between the tip of the cap and the tip of its shadow, in cap widths: about 0 when touching, larger as the tip lifts. The shadow's tip is found along the shadow's own middle line. Near the cap only the outer side of the shadow may show, so the line is fitted through slices across the shadow, each taking its middle from both edges, or from the outer edge and the shadow's width where the cap hides the inner edge. When the shadow's end is against the cap (its tip is hidden under the cap, as in a narrow V), the gap is how far the shadow's line passes from the tip instead; lifting the pen moves its shadow out from under the cap, so a hidden tip is at the point of the V or close to it. The distance from the cap to the nearest shadow pixel does not work: both are a cap width wide, and their edges stay close long after their tips have come apart. In a synthetic test (a drawn cap and shadow, with rolling flicker bands) the gap rose steadily as the tips came apart, for V angles of 20° to 98°: 0 to 0.22 cap widths when touching, and within about 0.1 of the true distance once the tips were more than half a cap width apart. A touch starts below 0.3 cap widths by default. The camera page paints the cap blue and its shadow cyan, draws the two lines of the V and the gap, and plots the gap over the last 6 seconds next to the touch thresholds. A cap that is missing for a frame or two keeps its touch, so one bad frame does not drop a press. It has not been tuned on the real board yet.

**Flicker bands.** A camera filming a projector often shows dark bands across the picture that roll up or down: the projector's light flickers faster than the eye can see, and the camera reads its rows one after another. Next to the empty board a band looks like a long, moving shadow. A band darkens a whole row while a shadow covers only a small part of one, so `src/components/camera/flicker.ts` corrects each row by the middle value, along the row, of how bright it is next to the empty board, before shadow is looked for (for the pen and the finger) and before movement is measured. The camera page shows how strong the bands are (**Flicker bands**). Setting the camera's exposure to a whole number of the projector's flicker periods (for example 1/60 s or 1/30 s, or an anti-flicker setting of 60 Hz) makes them fainter at the source.

**Pressing buttons with a finger.** With the hand in the 👆 pose, touch a button and lift to press it, or slide off it to cancel; touch a slider and slide along it (`src/components/whiteboard/fingerUi.ts`, the same for the pen). A touch must last a moment to count, and a button that was just clicked cannot be pressed again until the pointer has left it, so one touch cannot click twice. A touch that starts somewhere inert (the board, the panel's background) can still become a press when the pointer reaches a button, and sliding onto another button while touching presses that one instead, because the camera often sees the pointer touching just before it lands. A wide ring on the whiteboard shows where the camera sees the pointer, thin and faint while it hovers and thick and solid white while it touches; it is hollow and wide so that no light from it falls on the tip of a pen cap. The camera page shows what the pointer is over (**Pointer on the whiteboard**) and the button it clicked last (**Last click**), to tell a calibration problem from a touch problem. Buttons do not change while the pointer is on them (a button that turned darker under it would look like a shadow); a clicked button flashes green once the pointer is gone. The picture of the empty board that touch is judged against updates by itself whenever no hand (and no pen held in view) has been seen for a moment, so new marker writing and changes on the projected board are not taken for shadow.

**Drawing with a finger** is off by default (turn it on on the camera page): a real test of writing "3+4" with a finger came out broken and misplaced, because touch from the shadow is not steady enough for writing. When it is on, the fingertip is smoothed with a One Euro filter (`oneEuro.ts`) and draws, erases or moves the board like the mouse, with a pose held for two frames to start and lost for three to stop (`pen.ts`). The default pen is **white** on the gray board, because black ink is as dark as a shadow; the image sent to the AI is always drawn in dark ink, so white writing is still read.

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
src/components/camera/      Camera test page, hand tracking, writing pose, shadow touch, the capped pen, flicker bands, calibration and the pointer
src/lib/boardLink.ts        The messages between the camera page and the whiteboard
src/lib/                    Code shared by the server and the browser
docs/                       Project documentation
```
