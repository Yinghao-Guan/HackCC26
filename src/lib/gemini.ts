// The Gemini call for the routes that show the board to the AI. Only import this from route
// handlers: it needs GEMINI_API_KEY, which must stay on the server.

import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import { DATA_URL_PREFIX, fail, type AskOptions, type Outcome } from "./claude";

// "gemini-flash-latest" follows Google's newest Flash model. Set GEMINI_MODEL in .env.local to
// pin one (for example gemini-3.5-flash).
const DEFAULT_MODEL = "gemini-flash-latest";
// Past this, Gemini is given up on and the board is asked of Claude instead.
const TIMEOUT_MS = 45_000;

export const geminiModel = () => process.env.GEMINI_MODEL || DEFAULT_MODEL;

/**
 * Show Gemini the board (if there is an image) and get its reply as JSON in the shape of
 * `schema`. The JSON is not checked here; the caller should validate it. On failure, this
 * gives an error response that is fine to send to the browser.
 */
export async function askGemini({ system, schema, image, instruction }: AskOptions): Promise<Outcome<unknown>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, response: fail("GEMINI_API_KEY is not set in .env.local.", 500) };
  }
  try {
    // Made per request so a key added while the server is running is picked up. v1beta, because
    // the "-latest" model names and JSON-schema replies are only there.
    const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
    const response = await ai.models.generateContent({
      model: geminiModel(),
      contents: [
        {
          role: "user",
          parts: [
            ...(image
              ? [{ inlineData: { mimeType: "image/png", data: image.slice(DATA_URL_PREFIX.length) } }]
              : []),
            { text: instruction },
          ],
        },
      ],
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        maxOutputTokens: 16000,
        httpOptions: { timeout: TIMEOUT_MS },
      },
    });

    const finish = response.candidates?.[0]?.finishReason;
    if (finish === FinishReason.MAX_TOKENS) {
      return {
        ok: false,
        response: fail("The AI ran out of room before finishing. Try something simpler.", 502),
      };
    }
    const text = response.text;
    if (!text) {
      const blocked = response.promptFeedback?.blockReason ?? finish;
      return { ok: false, response: fail(`The AI declined to read this image (${blocked ?? "no reply"}).`, 422) };
    }

    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // The caller treats null as "unexpected format".
    }
    return { ok: true, value: json };
  } catch (error) {
    if (error instanceof ApiError) {
      console.error("Gemini API error:", error.status, error.message);
      if (error.status === 401 || error.status === 403) {
        return { ok: false, response: fail("The Gemini API key is missing or invalid. Check GEMINI_API_KEY in .env.local.", 500) };
      }
      if (error.status === 429) return { ok: false, response: fail("The AI is busy right now. Try again in a moment.", 429) };
      return { ok: false, response: fail(`The AI request failed (${error.status}): ${error.message}`, 502) };
    }
    console.error("Unexpected error while asking Gemini:", error);
    return { ok: false, response: fail("Couldn't get an answer from Gemini.", 502) };
  }
}
