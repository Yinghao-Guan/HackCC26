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

The board fills the whole screen. Two round buttons float on it: the **tool menu** (a pen icon, bottom right at first; see [Tool menu](#tool-menu-the-round-button) below) and the **AI menu** (sparkles, bottom middle; see [AI menu](#ai-menu-the-sparkle-button)).

- **Pen**: draw with the mouse (or a finger or stylus).
- **Eraser**: *Pixel* rubs out part of a stroke; *Stroke* removes a whole stroke or text box with one touch.
- **Text**: click the board and type. Enter adds a line; Esc or clicking away finishes. Click text to edit it. Typed text is part of the board, so it can be erased, undone, and read by the AI.
- **Move**: drag the board to move around. The mouse wheel or trackpad scrolls it too, and so does dragging with the middle mouse button. The board is endless; **Reset view** goes back to the start. **Solve** reads only what is on screen.
- **Undo**: in the tool menu, or Ctrl+Z (Cmd+Z on a Mac). **Clear** empties the board, and can be undone too.

### Tool menu (the round button)

The round button floats on the board (bottom right at first), close to where you write. Tap it and eight buttons fan out around it: **Pen**, **Eraser**, **Text**, **Move**, **Undo**, **Board**, **Size** and **Color**. Tap a tool to use it and the menu closes.

- **Size** opens a curved slider around the outside of the menu: drag along it (or tap anywhere on it) to set the size of the current pen, eraser or text, from smallest at the bottom to biggest at the top. The size shows in the middle as you drag.
- **Color** opens an outer ring of five colors plus a rainbow swatch for any color. Picking a color switches to the pen (or keeps the text tool).
- **Eraser**: tap once to pick it. Tap it again while it is picked to choose *Pixel* or *Stroke*.
- **Undo** keeps the menu open, so you can tap it several times in a row.
- **Board** opens **Clear** and **Reset view**.
- Tap anywhere else on the board (or the × in the middle, or press Esc) to close the menu without drawing.
- Drag the button to put it anywhere on the board. Near an edge, the open menu slides in just far enough to fit.
- Keyboard: Enter opens it, the arrow keys move around a ring, Esc goes back. On the size slider the arrow keys change the size by 1 px, Page Up/Down by more, Home/End jump to the ends, and Enter closes the menu. The name of the button you point at shows in the middle.

Each button is always in the same direction, so with use you can reach for it without looking (the idea behind marking menus, which work best with up to eight choices per ring). The menu follows the system's *reduce motion* setting. The code is in `src/components/whiteboard/RadialMenu.tsx`, with the geometry in `radialGeometry.ts`.

### AI menu (the sparkle button)

The second round button works the same way as the tool menu (tap to open, drag to move, the same animation and keyboard keys). Four buttons fan out around it: **Solve** at the top, **Graph** on the right, **Check** at the bottom and **Speak** on the left, each in its own color. Tap one and the menu closes while it works.

- While a request runs, a ring spins around the button in that action's color, and the other actions wait (only one request at a time).
- While it is listening, the button turns red with a microphone; tap it to stop.
- A small bubble beside the button says what is happening, what was heard, and any message (for example "Write a math problem on the board first."). Messages fade after a few seconds, or tap × to close them.
- Only one of the two menus is open at a time: while one is open, a tap anywhere else (including on the other button) closes it first.

The code is in `src/components/whiteboard/AiMenu.tsx`. What both menus share (the motion, the round buttons, the disc, the draggable button) is in `radialKit.tsx`.

## AI: Solve

Write a math problem on the board and tap **Solve** in the AI menu. The board's ink is sent to the Claude API (through the route in `src/app/api/solve/`), which reads the handwriting and solves it. The reading, the steps and the answer are written on the board next to the problem. This needs `ANTHROPIC_API_KEY` in `.env.local` (git-ignored); restart `npm run dev` after changing it.

## AI: Graph

Write an equation (or a few, like a system) and tap **Graph** in the AI menu. Claude reads them through `src/app/api/graph/` and says how to plot each one: a formula and a sensible window. The board then draws the curves itself, as a crisp SVG with axes and a color key, next to your writing. Explicit functions (`y = x^2 - 3x + 2`, lines, `sin`, `1/x`) and implicit ones (circles, hyperbolas) both work. If what is on screen is only **typed** equations (Text tool) that follow the usual forms, the graph is drawn right away on your machine: no AI call, no waiting (about 14 ms in testing), and it works offline. Handwriting, sentences, LaTeX and anything unclear still go to Claude (a few seconds). The formula evaluator is in `src/lib/expression.ts` and the drawing math is in `src/lib/plot.ts`; neither needs a library.

### 3D graphs

If an equation uses `z`, **Graph** shows a 3D view instead: surfaces such as `z = x^2 + y^2`, planes, and systems of planes (three planes that meet in one point get that point marked, e.g. `(1, 2, 3)`). Drag to turn it, scroll or pinch to zoom, right-drag or use two fingers to move it, and use the **−**, **+** and **Reset** buttons if you prefer. Typed equations of these forms are drawn instantly on your machine. Anything else (handwriting, a sphere such as `x^2 + y^2 + z^2 = 9`) goes to Claude, which splits curved shapes into surfaces that are a function of the other two variables (a sphere becomes a top and a bottom half). The 3D view uses [three.js](https://threejs.org), loaded only when a 3D graph is shown; the mesh math is in `src/lib/surface.ts`.

## AI: Check (find the mistake)

Write a problem and your worked steps, one step per line, and tap **Check** in the AI menu. The board's ink is split into lines on your machine and sent to Claude (through `src/app/api/check/`) with a red number beside each line. Claude finds the **first** step that does not follow, says why, shows how that line should read, carries on to the right answer, and the wrong line is circled on the board with a **Step N** tag. If all the steps are right, it says so instead. Because the line numbers come from our own line-splitting, the circle always lands on the line Claude meant. Leave a little space between lines so they can be told apart.

## Voice: talk to the board

Tap **Speak** in the AI menu and say what you want: "solve this", "graph this" (or "draw a 3D coordinate system for these equations"), "check my work" or "find the mistake", or "undo that". The words show up in a bubble beside the AI button as you say them. Short pauses mid-sentence are fine: it waits until the words have stopped for about 1.5 seconds, then runs the matching button on what is on screen. Tap the red button to stop early.

You can also **ask a question**, such as "give me an example question on the chain rule" or "explain how to differentiate this". Anything you say that isn't one of the commands above (and is at least three words) goes to Claude through `src/app/api/ask/`. If something is written on screen, an image of it goes along, so "explain this step" works; with an empty board only the question is sent. The answer is written on the board as a card with the question, short explanations and formulas shown with KaTeX. Sentences that start with *how, why, explain, describe, define, tell me, give me* or *teach me* are always treated as questions, even if they contain a word like "solve" ("how do I solve a quadratic" explains; "solve this" solves).

This uses the browser's own speech recognition (the Web Speech API), so it needs no API key, no server route and no account. It works in Chrome, Edge and Safari, not Firefox. The page must be on `localhost` or `https`, the browser asks for microphone permission the first time, and it listens for English. The app never records or stores audio itself.

To make it steadier:

- **On-device recognition when the browser has it.** If the browser has an English speech model on the computer, that is used, with a list of math words to favour ("chain rule", "derivative", "integral" and so on). It needs no internet and is usually quicker. Otherwise the browser's online service is used (Google's in Chrome, Apple's in Safari), which needs an internet connection. The browser console shows which one with a line like `[speech] on-device recognition available`. If on-device recognition fails, it switches to online for the rest of the session.
- **A network hiccup is retried once** before an error is shown.
- **Misheard commands are recovered.** The browser gives three guesses; if the first is neither a command nor a question ("soul this") but another guess is a command ("solve this"), that one is used.
- **The microphone is the computer's default input.** The Web Speech API can't choose a microphone, so pick it in the system sound settings (on a Mac: System Settings → Sound → Input). A microphone close to the speaker works far better than one across a noisy room.

Every step is logged in the browser console, starting with `[speech]`, which helps when it doesn't hear you.

Which command was meant is worked out on your machine by matching the words (`src/lib/voice.ts`), so commands need no AI call and no extra waiting (only questions go to Claude, and take a few seconds). If several commands are mentioned, the first one wins. The listening code is `src/components/whiteboard/useSpeechRecognition.ts`.

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
src/components/whiteboard/  Drawing canvas, stroke model, round tool and AI menus, voice input, answer, graph (2D and 3D) and check cards
src/lib/                    Code shared by the server and the browser
docs/                       Project documentation
```
