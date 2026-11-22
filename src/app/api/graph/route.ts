import { askAboutBoard } from "@/lib/ai";
import { fail, readBoardRequest } from "@/lib/claude";
import { parseGraphResult } from "@/lib/graph";

const SYSTEM_PROMPT = `You read handwritten math from a whiteboard and turn it into a graph.

The image shows only what the user wrote, as ink or text on a white background. The handwriting may be rough, so use context to read it.

Find every equation or function on the board and list each one to plot. If the board shows a system of equations, include every equation. Do not graph inequalities, tables of values, or anything that is not an equation; use status "no_graph" if there is nothing to graph.

First choose the dimension. If the equations use all three variables x, y and z, it is "3d". Otherwise it is "2d", a flat graph in x and y. Fill in only the part for that dimension; leave the other lists empty and give the other window the values -10, 10, -10, 10 (2D) or -5, 5, -5, 5, -5, 5 (3D).

Expressions are plain text that a plotter can evaluate. Use only the variables x, y and z, the operators + - * / ^ and brackets, and these functions: sin, cos, tan, asin, acos, atan, sinh, cosh, tanh, exp, ln (natural log), log (base 10), sqrt, cbrt, abs, floor, ceil, sign. The constants are pi and e. Always write multiplication with * (write 3*x, never 3x). Put brackets around every function argument, like sin(x). Labels are the equation as written, in LaTeX that KaTeX can render, with no $ or \\( \\) delimiters, for example y = x^2 - 3x + 2.

2D: list up to 6 curves. For each:
- kind: "explicit" when y can be written as a function of x. That includes lines like 2x + 3y = 6 (solve for y) and f(x) = sin(x). Use "implicit" only when y cannot be isolated as a single function of x, such as circles, ellipses and hyperbolas.
- expression, explicit: only the right-hand side, giving y in terms of x. For y = x^2 - 3x + 2 write x^2 - 3*x + 2.
- expression, implicit: the left side minus the right side, so the curve is where it equals zero. For x^2 + y^2 = 25 write x^2 + y^2 - 25.
- window: the part of the plane to show, as xMin, xMax, yMin and yMax. Choose it as a good textbook graph would: show the interesting parts (intercepts, the vertex or turning points, asymptotes, where curves meet) and include the origin when that makes sense. Use the same span for x and y when the shape matters (circles, ellipses, lines) so nothing looks stretched. Keep each span between 4 and 200.

3D: list up to 4 surfaces. For each:
- solveFor: the variable to solve the equation for. Use "z" whenever you can. Use "y" or "x" only when z cannot be isolated, for example x + y = 4 has no z, so solve it for y; and x = 2 is solved for x.
- expression: that variable in terms of the other two only. For z = x^2 + y^2 write x^2 + y^2. For x + y + z = 6 write 6 - x - y.
- If an equation cannot be solved for one variable as a single formula, split it into pieces that can. A sphere x^2 + y^2 + z^2 = 9 becomes two surfaces, both solved for z: sqrt(9 - x^2 - y^2) for the top half and -sqrt(9 - x^2 - y^2) for the bottom half.
- points: notable points to mark, such as the one point where the surfaces of a system meet (work out the solution yourself). The label is the point written like (1, 2, 3). Use an empty list when there are none.
- window3d: the box to show, as xMin, xMax, yMin, yMax, zMin and zMax. Show the interesting part and include the origin when that makes sense. Use the same span on all three axes when the shape matters, like spheres. Keep each span between 4 and 200.

status: "graphed" when you listed at least one curve or surface. "no_graph" when nothing on the board can be graphed. "unreadable" when you cannot make out the writing.
message: when status is not "graphed", one short plain sentence telling the user what to do next. Otherwise an empty string. When status is not "graphed", use empty lists and dimension "2d".`;

const number = { type: "number" };
const text = { type: "string" };

const GRAPH_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["graphed", "no_graph", "unreadable"] },
    dimension: { type: "string", enum: ["2d", "3d"] },
    curves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: text,
          kind: { type: "string", enum: ["explicit", "implicit"] },
          expression: text,
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
    surfaces: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: text,
          solveFor: { type: "string", enum: ["x", "y", "z"] },
          expression: text,
        },
        required: ["label", "solveFor", "expression"],
        additionalProperties: false,
      },
    },
    points: {
      type: "array",
      items: {
        type: "object",
        properties: { label: text, x: number, y: number, z: number },
        required: ["label", "x", "y", "z"],
        additionalProperties: false,
      },
    },
    window3d: {
      type: "object",
      properties: {
        xMin: number,
        xMax: number,
        yMin: number,
        yMax: number,
        zMin: number,
        zMax: number,
      },
      required: ["xMin", "xMax", "yMin", "yMax", "zMin", "zMax"],
      additionalProperties: false,
    },
    message: text,
  },
  required: ["status", "dimension", "curves", "window", "surfaces", "points", "window3d", "message"],
  additionalProperties: false,
};

export async function POST(request: Request) {
  const input = await readBoardRequest(request);
  if (!input.ok) return input.response;

  const reply = await askAboutBoard({
    system: SYSTEM_PROMPT,
    schema: GRAPH_SCHEMA,
    image: input.value.image,
    instruction: "Read the equations in this image and list them to graph.",
    accept: (value) => parseGraphResult(value) !== null,
  });
  if (!reply.ok) return reply.response;

  const result = parseGraphResult(reply.value);
  if (!result) return fail("The AI's answer was in an unexpected format. Try again.", 502);
  return Response.json(result);
}
