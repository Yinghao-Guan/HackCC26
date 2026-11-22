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

## Whiteboard

The whole screen is the board, with one **+** button in the bottom-right corner that opens the AI actions: **Solve**, **Graph**, **Check** and **Speak**.

- **Pen**: draw with the mouse, a finger or stylus, or a finger the camera sees on the real board (see *Camera service* below).
- **Eraser**: a double tap in the air (thumb and index finger) switches to an eraser that removes whole strokes, and back. While it is on, **Eraser on · tap for pen** shows at the top right; tap it to go back to the pen.
- **Moving around**: the board is endless. Scroll with the mouse wheel or trackpad, drag with the middle mouse button, or make a fist in front of the camera and move it. Both hands held open for 2 seconds put the view back to the start.
- **Undo**: Ctrl/Cmd+Z, or say "undo that".

The AI actions read only what is on screen.

## AI: Solve

Write a math problem on the board and press **Solve** (in the **+** menu). The board's ink is sent to the Claude API (through the route in `src/app/api/solve/`), which reads the handwriting and solves it. The reading, the steps and the answer are written on the board next to the problem. This needs `ANTHROPIC_API_KEY` in `.env.local` (git-ignored); restart `npm run dev` after changing it.

## AI: Graph

Write an equation (or a few, like a system) and press **Graph**. Claude reads them through `src/app/api/graph/` and says how to plot each one: a formula and a sensible window. The board then draws the curves itself, as a crisp SVG with axes and a color key, next to your writing. Explicit functions (`y = x^2 - 3x + 2`, lines, `sin`, `1/x`) and implicit ones (circles, hyperbolas) both work. It takes a few seconds. The formula evaluator is in `src/lib/expression.ts` and the drawing math is in `src/lib/plot.ts`; neither needs a library.

### 3D graphs

If an equation uses `z`, **Graph** shows a 3D view instead: surfaces such as `z = x^2 + y^2`, planes, and systems of planes (three planes that meet in one point get that point marked, e.g. `(1, 2, 3)`). Drag to turn it, scroll or pinch to zoom, right-drag or use two fingers to move it, and use the **−**, **+** and **Reset** buttons if you prefer. Claude reads the equations and splits curved shapes into surfaces that are a function of the other two variables (a sphere becomes a top and a bottom half). The 3D view uses [three.js](https://threejs.org), loaded only when a 3D graph is shown; the mesh math is in `src/lib/surface.ts`.

## AI: Check (find the mistake)

Write a problem and your worked steps, one step per line, and press **Check**. The board's ink is split into lines on your machine and sent to Claude (through `src/app/api/check/`) with a red number beside each line. Claude finds the **first** step that does not follow, says why, shows how that line should read, carries on to the right answer, and the wrong line is circled on the board with a **Step N** tag. If all the steps are right, it says so instead. Because the line numbers come from our own line-splitting, the circle always lands on the line Claude meant. Leave a little space between lines so they can be told apart.

## Voice: talk to the board

Tap **Speak** (in the **+** menu) and say what you want: "solve this", "graph this" (or "draw a 3D coordinate system for these equations"), "check my work" or "find the mistake", or "undo that". The words show up above the menu as you say them. Short pauses mid-sentence are fine: it waits until the words have stopped for about 1.5 seconds, then runs the matching button on what is on screen. Tap the button again to stop early.

You can also **ask a question**, such as "give me an example question on the chain rule" or "explain how to differentiate this". Anything you say that isn't one of the commands above (and is at least three words) goes to Claude through `src/app/api/ask/`. If something is written on screen, an image of it goes along, so "explain this step" works; with an empty board only the question is sent. The answer is written on the board as a card with the question, short explanations and formulas shown with KaTeX. Sentences that start with *how, why, explain, describe, define, tell me, give me* or *teach me* are always treated as questions, even if they contain a word like "solve" ("how do I solve a quadratic" explains; "solve this" solves).

This uses the browser's own speech recognition (the Web Speech API), so it needs no API key, no server route and no account. It works in Chrome, Edge and Safari, not Firefox. The page must be on `localhost` or `https`, the browser asks for microphone permission the first time, and it listens for English. The app never records or stores audio itself.

To make it steadier:

- **On-device recognition when the browser has it.** If the browser has an English speech model on the computer, that is used, with a list of math words to favour ("chain rule", "derivative", "integral" and so on). It needs no internet and is usually quicker. Otherwise the browser's online service is used (Google's in Chrome, Apple's in Safari), which needs an internet connection. The browser console shows which one with a line like `[speech] on-device recognition available`. If on-device recognition fails, it switches to online for the rest of the session.
- **A network hiccup is retried once** before an error is shown.
- **Misheard commands are recovered.** The browser gives three guesses; if the first is neither a command nor a question ("soul this") but another guess is a command ("solve this"), that one is used.
- **The microphone is the computer's default input.** The Web Speech API can't choose a microphone, so pick it in the system sound settings (on a Mac: System Settings → Sound → Input). A microphone close to the speaker works far better than one across a noisy room.

Every step is logged in the browser console, starting with `[speech]`, which helps when it doesn't hear you.

Which command was meant is worked out on your machine by matching the words (`src/lib/voice.ts`), so commands need no AI call and no extra waiting (only questions go to Claude, and take a few seconds). If several commands are mentioned, the first one wins. The listening code is `src/components/whiteboard/useSpeechRecognition.ts`.

## Camera service: finger, gestures and calibration

The board page connects by itself to the camera service in [`cv/`](cv/README.md), a Python process that watches the real board with a camera and sends what it sees over a WebSocket (`ws://127.0.0.1:8765/ws`). Start it in another terminal:

```bash
cd cv
uv sync                              # once
uv run python -m hackcc_cv.models    # once: the hand model
uv run python -m hackcc_cv           # add --fake to try it without a camera
```

Then open the board at <http://localhost:3000> (use `localhost`: the service only accepts pages from `localhost:3000` unless `CV_ALLOWED_ORIGINS` says otherwise), fullscreen on the projector, and keep only one board page open: the last one to connect sets the board size for everyone. Calibrate from <http://127.0.0.1:8765/calibrate>.

What the board does with what the camera sees (`src/components/whiteboard/useBusInput.ts`):

| The camera sees | The board |
|---|---|
| A finger touching the board | Draws (or erases, with the eraser on) |
| A finger touching a button | Taps it, like a click: the **+** menu, Solve, Graph and the rest |
| A finger touching a 3D graph | Turns the graph |
| Thumb and index double tap in the air | Switches between pen and eraser |
| A fist, moving | Moves the board with it |
| Thumb and index pinched and held, moving | Turns the 3D graph nearest the hand |
| Both hands pinching, moving apart or together | Zooms the 3D graph nearest the hands in or out (the board itself has no zoom yet) |
| Both hands open, still for 2 seconds | Shows a countdown ring, then puts the view back: board position and 3D angles. The writing is never touched |

A blue ring follows the finger while it hovers and fills in while it touches, so the presenter can see what the camera sees, and a short note at the top says which gesture is running. During calibration the board shows what the service asks for: a white screen with ArUco markers (and tells the service once they are painted), numbered crosses for the manual four-corner calibration, and a red cross for each check. The menu steps aside meanwhile.

The top-left corner says when something is not ready (service not running, camera off or failing, not calibrated, hand tracking off); a small green dot means all is well. If you are not using the camera, set `NEXT_PUBLIC_CV_BUS_URL=off` in `.env.local` to turn the connection off. You can also point one page elsewhere with `?bus=ws://127.0.0.1:<port>/ws` (or `?bus=off`); only addresses on this computer are accepted.

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
src/app/api/ask/            Server route: answers a spoken question (with the board image, if there is writing)
src/components/whiteboard/  Drawing canvas, stroke model, action menu, voice input, camera bus, answer, graph (2D and 3D) and check cards
src/lib/                    Code shared by the server and the browser
cv/                         Camera service (Python): calibration, hand tracking, gestures, the event bus
docs/                       Project documentation
```
