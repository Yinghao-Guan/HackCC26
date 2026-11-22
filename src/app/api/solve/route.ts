import { askAboutBoard, fail, readBoardRequest } from "@/lib/claude";
import { parseSolveResult } from "@/lib/solve";

const SYSTEM_PROMPT = `You read handwritten math from a whiteboard and solve it.

The image shows only what the user wrote, as ink or text on a white background. The handwriting may be rough, so use context to read it.

If the board contains a math problem (an equation, a system of equations, an inequality, or an expression to simplify, evaluate, factor, differentiate or integrate), solve it. If there are several separate problems, solve only the first one: the top-most, then the left-most.

Write all math as LaTeX that KaTeX can render, with no $ or \\( \\) delimiters around it.

Fill in the fields like this:
- status: "solved" when you solved a problem. "no_math" when nothing on the board is mathematical (a drawing, plain words). "unreadable" when you cannot make out the problem.
- read: the problem exactly as written, in LaTeX. Empty if status is not "solved".
- steps: the working as short LaTeX lines, one formula per line, no prose. Usually 2 to 6 lines. Empty if status is not "solved".
- answer: the final result in LaTeX, for example x = 3 or x = 2 \\text{ or } x = -5. Empty if status is not "solved".
- message: when status is not "solved", one short plain sentence telling the user what to do next. Otherwise an empty string.

If a symbol is ambiguous, choose the most plausible reading given the rest of the problem.`;

const SOLVE_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["solved", "no_math", "unreadable"] },
    read: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    answer: { type: "string" },
    message: { type: "string" },
  },
  required: ["status", "read", "steps", "answer", "message"],
  additionalProperties: false,
};

export async function POST(request: Request) {
  const input = await readBoardRequest(request);
  if (!input.ok) return input.response;

  const reply = await askAboutBoard({
    system: SYSTEM_PROMPT,
    schema: SOLVE_SCHEMA,
    image: input.value.image,
    instruction: "Read the handwriting in this image and solve the problem.",
  });
  if (!reply.ok) return reply.response;

  const result = parseSolveResult(reply.value);
  if (!result) return fail("The AI's answer was in an unexpected format. Try again.", 502);
  return Response.json(result);
}
