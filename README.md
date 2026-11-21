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
src/app/api/graph/          Server route: reads the board image and lists the curves to graph
src/components/whiteboard/  Drawing canvas, stroke model, settings panel, answer cards
src/lib/                    Code shared by the server and the browser
docs/                       Project documentation
```
