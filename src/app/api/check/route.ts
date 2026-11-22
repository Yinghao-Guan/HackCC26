import { askAboutBoard, fail, readBoardRequest } from "@/lib/claude";
import { parseCheckResult } from "@/lib/check";

const MAX_LINES = 60;

const SYSTEM_PROMPT = `You check a student's math work on a whiteboard and find the first mistake in it.

The image shows the work as ink or text on a white background. Each line of writing is marked with a red numbered circle in the left margin. The red circles are not part of the work: use them only to say which line you mean. The handwriting may be rough, so use context to read it.

Usually the top line is the problem and the lines below it are the steps of the solution. Read every line. Find the FIRST line that is wrong: one that does not follow correctly from the line before it (or from the problem), or that has an arithmetic or algebra error. Lines after it that correctly follow from the mistake are not new mistakes; only the first one matters.

Fill in the fields like this:
- status: "mistake" when you found a wrong step. "correct" when every step is right. "no_work" when there is only a problem or nothing worked out, so there are no steps to check. "unreadable" when you cannot make out the writing.
- wrongLine: the number in the red circle of the first wrong line. 0 when status is not "mistake".
- explanation: one to three short plain sentences to the student, saying what went wrong and why, in ordinary characters with no LaTeX. For "correct", a short note that the work is right. Empty for "no_work" and "unreadable".
- correctedLine: what the wrong line should have said, in LaTeX that KaTeX can render, with no $ or \\( \\) delimiters. Empty unless status is "mistake".
- steps: the work carried on correctly from the corrected line to the final answer, as short LaTeX lines, one formula per line, no prose. Empty unless status is "mistake".
- answer: the correct final answer in LaTeX, for example x = 4. For "correct", the final answer the student reached. Empty for "no_work" and "unreadable".
- message: when status is "no_work" or "unreadable", one short plain sentence telling the user what to do next. Otherwise an empty string.

If a symbol is ambiguous, choose the most plausible reading given the rest of the work.`;

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["mistake", "correct", "no_work", "unreadable"] },
    wrongLine: { type: "integer" },
    explanation: { type: "string" },
    correctedLine: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    answer: { type: "string" },
    message: { type: "string" },
  },
  required: ["status", "wrongLine", "explanation", "correctedLine", "steps", "answer", "message"],
  additionalProperties: false,
};

export async function POST(request: Request) {
  const input = await readBoardRequest(request);
  if (!input.ok) return input.response;

  const lineCount = input.value.body.lineCount;
  if (typeof lineCount !== "number" || !Number.isInteger(lineCount) || lineCount < 1 || lineCount > MAX_LINES) {
    return fail(`Send lineCount: how many numbered lines the image shows (1 to ${MAX_LINES}).`, 400);
  }

  const reply = await askAboutBoard({
    system: SYSTEM_PROMPT,
    schema: CHECK_SCHEMA,
    image: input.value.image,
    instruction: `The writing has ${lineCount} numbered ${lineCount === 1 ? "line" : "lines"}. Check the work and find the first mistake.`,
  });
  if (!reply.ok) return reply.response;

  const result = parseCheckResult(reply.value, lineCount);
  if (!result) return fail("The AI's answer was in an unexpected format. Try again.", 502);
  return Response.json(result);
}
