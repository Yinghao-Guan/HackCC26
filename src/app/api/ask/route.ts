import { askAboutBoard } from "@/lib/ai";
import { fail, readQuestionRequest } from "@/lib/claude";
import { parseAskResult } from "@/lib/ask";

const SYSTEM_PROMPT = `You are the AI teaching assistant on a classroom whiteboard. Someone just asked you a question out loud, and your answer is written on the board for everyone in the room to read.

The question was transcribed from speech, so it may have small mistakes: use context to fix them ("chain rule" may come out as "change rule"). You may also get an image of what is written on the board right now, as ink or text on a white background. Use it only when the question is about it ("explain this", "why is that step wrong", "what's the derivative of this"), and ignore it otherwise. If the question points at the board but nothing useful is written there, say so in one short sentence.

Answer for a room that is looking at a screen: short and clear, about 120 words at most, plus formulas. No greeting, no filler, no markdown, no bullet characters. If asked for an example problem, give just the problem, and add a one-line hint instead of the full solution unless the solution was asked for. You cannot draw graphs or check handwritten work yourself in an answer; if asked to, tell them to say "graph this" or "check my work".

Write the answer as blocks that are shown in order:
- kind "text": plain sentences. Put a short formula inside a sentence between $ signs, like $x^2$.
- kind "math": one formula as LaTeX that KaTeX can render, with no $ or \\( \\) delimiters. It is shown on its own line. Use these for the formulas that matter: a problem to solve, a rule, a key step.
Use between 1 and 8 blocks.`;

const ASK_SCHEMA = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["text", "math"] },
          content: { type: "string" },
        },
        required: ["kind", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["blocks"],
  additionalProperties: false,
};

export async function POST(request: Request) {
  const input = await readQuestionRequest(request);
  if (!input.ok) return input.response;
  const { question, image } = input.value;

  const reply = await askAboutBoard({
    system: SYSTEM_PROMPT,
    schema: ASK_SCHEMA,
    image,
    instruction: `${
      image ? "The board is shown in the image." : "Nothing is written on the board right now."
    }\n\nQuestion (transcribed from speech): ${question}`,
    accept: (value) => parseAskResult(value) !== null,
  });
  if (!reply.ok) return reply.response;

  const result = parseAskResult(reply.value);
  if (!result) return fail("The AI's answer was in an unexpected format. Try again.", 502);
  return Response.json(result);
}
