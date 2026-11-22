"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The commands are in English, so listen for English whatever language the browser is set to.
const LANGUAGE = "en-US";

// The browser's speech recognizer goes by two names, and TypeScript's built-in types
// don't include it, so this declares just the parts used here.
interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onaudiostart: (() => void) | null;
  onsoundstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onresult: ((event: { results: SpeechRecognitionResultList }) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognizerClass(): (new () => Recognizer) | null {
  const global = window as unknown as {
    SpeechRecognition?: new () => Recognizer;
    webkitSpeechRecognition?: new () => Recognizer;
  };
  return global.SpeechRecognition ?? global.webkitSpeechRecognition ?? null;
}

type Tone = "info" | "error";

// A tap this soon after listening ended is taken as the tap that was meant to stop it.
const RESTART_GRACE_MS = 600;

// Each step of listening is written to the browser console, to help find out why
// nothing was heard on a particular computer.
const note = (what: string, detail = "") => console.info("[speech]", what, detail);

/** What to tell the user about an error from the recognizer, or null if it needs no message. */
function problemWith(code: string): { message: string; tone: Tone } | null {
  switch (code) {
    case "aborted":
      return null; // we stopped it ourselves
    case "no-speech":
      return { message: "I didn't hear anything. Tap the mic and try again.", tone: "info" };
    case "not-allowed":
    case "service-not-allowed":
      return {
        message: "The microphone is blocked. Allow it in the browser's address bar, then tap the mic again.",
        tone: "error",
      };
    case "audio-capture":
      return { message: "No microphone was found. Plug one in and try again.", tone: "error" };
    case "network":
      return {
        message: "Speech recognition needs the internet, and couldn't reach its service.",
        tone: "error",
      };
    default:
      return { message: "Speech recognition failed. Try again.", tone: "error" };
  }
}

interface SpeechOptions {
  /** What was said, once the person has finished speaking. */
  onSpeech: (heard: string) => void;
  /** Listening could not start, or nothing was made out: a message for the user. */
  onProblem: (message: string, tone: Tone) => void;
}

/**
 * Listen with the browser's own speech recognition (no server, no key). `start` begins
 * listening; it ends by itself when the person stops talking, or when `stop` is called.
 * The words go to `onSpeech`, and `hearing` shows them as they come in.
 */
export function useSpeechRecognition({ onSpeech, onProblem }: SpeechOptions) {
  const [listening, setListening] = useState(false);
  const [hearing, setHearing] = useState("");

  // What is listening right now, if anything. `cancel` drops whatever it heard.
  const session = useRef<{ stop: () => void; cancel: () => void } | null>(null);

  // The callbacks may change between renders; listening should call the latest ones.
  const latest = useRef({ onSpeech, onProblem });
  useEffect(() => {
    latest.current = { onSpeech, onProblem };
  });

  // When listening last ended, to tell a deliberate tap from one that came just too late.
  const endedAt = useRef(0);

  /** Start listening. Gives false if it didn't start (already listening, or it could not). */
  const start = useCallback((): boolean => {
    if (session.current) return false;
    // The browser stops listening by itself when you pause, so a tap meant to stop it often lands
    // just after it already has. That tap must not start another round.
    if (Date.now() - endedAt.current < RESTART_GRACE_MS) return false;

    const Recognizer = recognizerClass();
    if (!Recognizer) {
      latest.current.onProblem("This browser can't recognise speech. Try Chrome, Edge or Safari.", "error");
      return false;
    }

    const recognizer = new Recognizer();
    recognizer.lang = LANGUAGE;
    recognizer.continuous = false; // ends after the first sentence
    recognizer.interimResults = true; // so the words show as they are said
    recognizer.maxAlternatives = 1;

    let confirmed = ""; // the words the browser is sure of
    let latestWords = ""; // everything so far, sure or not
    let failed = false;
    let cancelled = false;

    // How far listening got, so that a silent result can say what went wrong.
    let gotAudio = false; // the microphone opened
    let gotSound = false; // something louder than silence came in
    const nothingHeard = () => {
      if (!gotAudio) {
        return "I couldn't get any audio from the microphone. Check that the browser and your computer allow it, and that the right microphone is selected.";
      }
      if (!gotSound) {
        return "The microphone is on, but I couldn't hear any sound. Check its input volume and that the right microphone is selected.";
      }
      return "I heard sound but couldn't make out any words. Speak English, close to the microphone. Chrome also needs the internet to recognise speech.";
    };

    recognizer.onaudiostart = () => {
      gotAudio = true;
      note("audio started");
    };
    recognizer.onsoundstart = () => {
      gotSound = true;
      note("sound heard");
    };
    recognizer.onspeechstart = () => note("speech heard");

    recognizer.onresult = (event) => {
      let sure = "";
      let unsure = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) sure += result[0].transcript;
        else unsure += result[0].transcript;
      }
      confirmed = sure.trim();
      latestWords = `${sure} ${unsure}`.trim();
      note("words", `${JSON.stringify(latestWords)} (${confirmed ? "final" : "so far"})`);
      setHearing(latestWords);
    };
    recognizer.onerror = (event) => {
      note("error", `${event.error} ${event.message ?? ""}`);
      const problem =
        event.error === "no-speech"
          ? { message: nothingHeard(), tone: "info" as Tone }
          : problemWith(event.error);
      if (!problem) return;
      failed = true;
      latest.current.onProblem(problem.message, problem.tone);
    };
    recognizer.onend = () => {
      note("ended", `audio=${gotAudio} sound=${gotSound} words=${JSON.stringify(confirmed || latestWords)}`);
      endedAt.current = Date.now();
      session.current = null;
      setListening(false);
      setHearing("");
      if (cancelled || failed) return;

      // Tapping stop can come before the browser has settled on the words, so fall back to what it had.
      const heard = confirmed || latestWords;
      if (heard) latest.current.onSpeech(heard);
      else latest.current.onProblem(nothingHeard(), "info");
    };

    try {
      recognizer.start();
      note("started", `lang=${recognizer.lang}`);
    } catch {
      latest.current.onProblem("Couldn't start listening. Try again.", "error");
      return false;
    }
    session.current = {
      stop: () => recognizer.stop(),
      cancel: () => {
        cancelled = true;
        recognizer.abort();
      },
    };
    setListening(true);
    return true;
  }, []);

  const stop = useCallback(() => session.current?.stop(), []);

  // Leaving the page stops listening and drops what was heard.
  useEffect(() => () => session.current?.cancel(), []);

  return { listening, hearing, start, stop };
}
