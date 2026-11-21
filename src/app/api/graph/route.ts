import { askAboutBoard, fail, readBoardImage } from "@/lib/claude";
import { parseGraphResult } from "@/lib/graph";

const SYSTEM_PROMPT = `You read handwritten math from a whiteboard and turn it into a graph.

The image shows only what the user wrote, as ink or text on a white background. The handwriting may be rough, so use context to read it.

Find every equation or function of x and/or y on the board, up to 6, and list each one as a curve to plot. If the board shows a system of equations, include every equation. Do not graph inequalities, tables of values, or anything that is not an equation; use status "no_graph" if there is nothing to graph.

Fill in each curve like this:
- label: the equation as written, in LaTeX that KaTeX can render, with no $ or \\( \\) delimiters, for example y = x^2 - 3x + 2.
- kind: "explicit" when y can be written as a function of x. That includes lines like 2x + 3y = 6 (solve for y) and f(x) = sin(x). Use "implicit" only when y cannot be isolated as a single function of x, such as circles, ellipses and hyperbolas.
- expression: plain text that a plotter can evaluate. Use only the variables x and y, the operators + - * / ^ and brackets, and these functions: sin, cos, tan, asin, acos, atan, sinh, cosh, tanh, exp, ln (natural log), log (base 10), sqrt, cbrt, abs, floor, ceil, sign. The constants are pi and e. Always write multiplication with * (write 3*x, never 3x). Put brackets around every function argument, like sin(x).
  - explicit: only the right-hand side, giving y in terms of x. For y = x^2 - 3x + 2 write x^2 - 3*x + 2.
  - implicit: the left side minus the right side, so the curve is where it equals zero. For x^2 + y^2 = 25 write x^2 + y^2 - 25.

window: the part of the plane to show, as xMin, xMax, yMin and yMax. Choose it as a good textbook graph would: show the interesting parts (intercepts, the vertex or turning points, asymptotes, where curves meet) and include the origin when that makes sense. Use the same span for x and y when the shape matters (circles, ellipses, lines) so nothing looks stretched. Keep each span between 4 and 200.

status: "graphed" when you listed at least one curve. "no_graph" when nothing on the board can be graphed. "unreadable" when you cannot make out the writing.
message: when status is not "graphed", one short plain sentence telling the user what to do next. Otherwise an empty string. When status is not "graphed", use an empty curves list and the window -10, 10, -10, 10.`;

const number = { type: "number" };

const GRAPH_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["graphed", "no_graph", "unreadable"] },
    curves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          kind: { type: "string", enum: ["explicit", "implicit"] },
          expression: { type: "string" },
        },
        required: ["label", "kind", "expression"],
        additionalProperties: false,
      },
    },
    window: {
      type: "object",
      properties: { xMin: number, xMax: number, yMin: number, yMax: number },
      required: ["xMin", "xMax", "yMin", "yMax"],
      additionalProperties: false,
    },
    message: { type: "string" },
  },
  required: ["status", "curves", "window", "message"],
  additionalProperties: false,
};

export async function POST(request: Request) {
  const input = await readBoardImage(request);
  if (!input.ok) return input.response;

  const reply = await askAboutBoard({
    system: SYSTEM_PROMPT,
    schema: GRAPH_SCHEMA,
    image: input.value,
    instruction: "Read the equations in this image and list them as curves to graph.",
  });
  if (!reply.ok) return reply.response;

  const result = parseGraphResult(reply.value);
  if (!result) return fail("The AI's answer was in an unexpected format. Try again.", 502);
  return Response.json(result);
}
