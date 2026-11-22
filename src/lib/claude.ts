// Server-side helpers for the routes that show the board to Claude. Only import
// this from route handlers: it needs ANTHROPIC_API_KEY, which must stay on the server.

import Anthropic from "@anthropic-ai/sdk";

// To trade accuracy for speed or cost, change the model here (and drop `fallbacks` below
// if the new model doesn't support it).
const MODEL = "claude-opus-5-5";

const DATA_URL_PREFIX = "data:image/png;base64,";
const MAX_IMAGE_CHARS = 6_000_000; // the API accepts images up to 5 MB

/** True for a PNG data URL of a size the API accepts. */
const isBoardImage = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith(DATA_URL_PREFIX) && value.length <= MAX_IMAGE_CHARS;

export type Outcome<T> = { ok: true; value: T } | { ok: false; response: Response };

export function fail(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/**
 * Get the board's image (a PNG data URL) out of a request, along with the rest of
 * the JSON body, or an error response to send back.
 */
export async function readBoardRequest(
  request: Request,
): Promise<Outcome<{ image: string; body: Record<string, unknown> }>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: fail("The request body must be JSON.", 400) };
  }

  const image =
    typeof body === "object" && body !== null && "image" in body ? body.image : null;
  if (!isBoardImage(image)) {
    return {
      ok: false,
      response: fail("Send the board as a PNG image data URL (under 5 MB).", 400),
    };
  }
  return { ok: true, value: { image, body: body as Record<string, unknown> } };
}

const MAX_QUESTION_CHARS = 500;

/**
 * Get a spoken question (and, if there is something written on the board, its image) out of
 * a request, or an error response to send back.
 */
export async function readQuestionRequest(
  request: Request,
): Promise<Outcome<{ question: string; image: string | null }>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: fail("The request body must be JSON.", 400) };
  }

  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const question = typeof fields.question === "string" ? fields.question.trim() : "";
  if (question === "" || question.length > MAX_QUESTION_CHARS) {
    return {
      ok: false,
      response: fail(`Send the question as text, 1 to ${MAX_QUESTION_CHARS} characters.`, 400),
    };
  }

  const image = fields.image ?? null;
  if (image !== null && !isBoardImage(image)) {
    return {
      ok: false,
      response: fail("Send the board as a PNG image data URL (under 5 MB), or leave it out.", 400),
    };
  }
  return { ok: true, value: { question, image } };
}

interface AskOptions {
  /** Tells Claude what to do with the board. */
  system: string;
  /** The JSON shape Claude must reply in. */
  schema: Record<string, unknown>;
  /** The board as an image, or null when there is nothing to show. */
  image: string | null;
  /** The short request sent along with the image. */
  instruction: string;
}

/**
 * Show Claude the board (if there is an image) and get its reply as JSON in the shape of `schema`. The
 * JSON is not checked here; the caller should validate it. On failure, this
 * gives an error response that is fine to send to the browser.
 */
export async function askAboutBoard({
  system,
  schema,
  image,
  instruction,
}: AskOptions): Promise<Outcome<unknown>> {
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
      system,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema },
      },
      messages: [
        {
          role: "user",
          content: [
            ...(image
              ? [
                  {
                    type: "image" as const,
                    source: {
                      type: "base64" as const,
                      media_type: "image/png" as const,
                      data: image.slice(DATA_URL_PREFIX.length),
                    },
                  },
                ]
              : []),
            { type: "text" as const, text: instruction },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return { ok: false, response: fail("The AI declined to read this image.", 422) };
    }
    if (response.stop_reason === "max_tokens") {
      return {
        ok: false,
        response: fail("The AI ran out of room before finishing. Try something simpler.", 502),
      };
    }

    const textBlock = response.content.find(
      (block): block is Anthropic.Beta.BetaTextBlock => block.type === "text",
    );

    let json: unknown = null;
    if (textBlock) {
      try {
        json = JSON.parse(textBlock.text);
      } catch {
        // The caller treats null as "unexpected format".
      }
    }
    return { ok: true, value: json };
  } catch (error) {
    return { ok: false, response: errorResponse(error) };
  }
}

function errorResponse(error: unknown): Response {
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
  console.error("Unexpected error while asking Claude:", error);
  return fail("Something went wrong while reading the board.", 500);
}
