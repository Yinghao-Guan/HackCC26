import Anthropic from "@anthropic-ai/sdk";
import { parseSolveResult } from "@/lib/solve";

// To trade accuracy for speed or cost, change the model here (and drop `fallbacks` below
// if the new model doesn't support it).
const MODEL = "claude-opus-5-5";

const DATA_URL_PREFIX = "data:image/png;base64,";
const MAX_IMAGE_CHARS = 6_000_000; // the API accepts images up to 5 MB

const SYSTEM_PROMPT = `You read handwritten math from a whiteboard and solve it.

The image shows only what the user wrote, as ink on a white background. The handwriting may be rough, so use context to read it.

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

function fail(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("The request body must be JSON.", 400);
  }

  const image =
    typeof body === "object" && body !== null && "image" in body ? body.image : null;
  if (
    typeof image !== "string" ||
    !image.startsWith(DATA_URL_PREFIX) ||
    image.length > MAX_IMAGE_CHARS
  ) {
    return fail("Send the board as a PNG image data URL (under 5 MB).", 400);
  }

  try {
    // Reads ANTHROPIC_API_KEY from the environment (put it in .env.local). Made per
    // request so a key added while the server is running is picked up.
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // If the model declines a request, retry it on a fallback model automatically.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: SOLVE_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: image.slice(DATA_URL_PREFIX.length),
              },
            },
            { type: "text", text: "Read the handwriting in this image and solve the problem." },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return fail("The AI declined to read this image.", 422);
    }
    if (response.stop_reason === "max_tokens") {
      return fail("The AI ran out of room before finishing. Try a simpler problem.", 502);
    }

    const textBlock = response.content.find(
      (block): block is Anthropic.Beta.BetaTextBlock => block.type === "text",
    );

    let parsed: unknown = null;
    if (textBlock) {
      try {
        parsed = JSON.parse(textBlock.text);
      } catch {
        // Falls through to the "unexpected format" error below.
      }
    }

    const result = parseSolveResult(parsed);
    if (!result) return fail("The AI's answer was in an unexpected format. Try again.", 502);
    return Response.json(result);
  } catch (error) {
    if (
      error instanceof Anthropic.AuthenticationError ||
      (error instanceof Error && /authentication method/i.test(error.message))
    ) {
      return fail(
        "The Claude API key is missing or invalid. Add ANTHROPIC_API_KEY to .env.local, then restart the dev server.",
        500,
      );
    }
    if (error instanceof Anthropic.RateLimitError) {
      return fail("The AI is busy right now. Try again in a moment.", 429);
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return fail("Couldn't reach the Claude API. Check your internet connection.", 502);
    }
    if (error instanceof Anthropic.APIError) {
      console.error("Claude API error:", error.status, error.message);
      return fail(`The AI request failed (${error.status}): ${error.message}`, 502);
    }
    console.error("Unexpected error while solving:", error);
    return fail("Something went wrong while solving.", 500);
  }
}
