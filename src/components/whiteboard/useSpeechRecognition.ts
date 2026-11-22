"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The commands are in English, so listen for English whatever language the browser is set to.
const LANGUAGE = "en-US";

// Listening ends once the words have stopped changing for this long. The browser on its own
// ends at the first short pause, which cut sentences in half ("what does quadratic equation").
const END_AFTER_QUIET_MS = 1500;
// Give up if no words have come in after this long, and stop in any case after this long.
const NO_WORDS_MS = 8000;
const MAX_LISTEN_MS = 15_000;
const CHECK_EVERY_MS = 200;
// If the browser hasn't finished this long after being asked to stop, end it anyway.
const STOP_TIMEOUT_MS = 2500;
// A tap this soon after listening ended is taken as the tap that was meant to stop it.
const RESTART_GRACE_MS = 600;
// Ask for a few guesses at what was said, so a misheard command ("soul this") can be recovered.
const GUESSES = 3;
// A hiccup from the online speech service is retried this many times, if nothing was heard yet.
const NETWORK_RETRIES = 1;

// Words the recognizer should lean towards. Only on-device recognition supports this.
const BOARD_PHRASES = [
  "solve this",
  "graph this",
  "check my work",
  "undo that",
  "chain rule",
  "product rule",
  "quotient rule",
  "derivative",
  "differentiate",
  "integral",
  "integrate",
  "quadratic",
  "polynomial",
  "equation",
  "system of equations",
  "coordinate system",
  "square root",
  "squared",
  "cubed",
  "logarithm",
  "sine",
  "cosine",
  "tangent",
  "limit",
  "slope",
  "intercept",
];
const PHRASE_BOOST = 3;

// The browser's speech recognizer goes by two names, and TypeScript's built-in types
// don't include it, so this declares just the parts used here.
interface Guess {
  transcript: string;
}
interface ResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: Guess;
}
interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  phrases?: unknown[];
  onaudiostart: (() => void) | null;
  onsoundstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onresult: ((event: { results: ArrayLike<ResultLike> }) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface LocalOptions {
  langs: string[];
  processLocally: boolean;
}
interface RecognizerClass {
  new (): Recognizer;
  /** Whether on-device recognition can be used: "available", "downloadable", "downloading" or "unavailable". */
  available?: (options: LocalOptions) => Promise<string>;
}

function recognizerClass(): RecognizerClass | null {
  const global = window as unknown as {
    SpeechRecognition?: RecognizerClass;
    webkitSpeechRecognition?: RecognizerClass;
  };
  return global.SpeechRecognition ?? global.webkitSpeechRecognition ?? null;
}

function phraseClass(): (new (phrase: string, boost: number) => unknown) | null {
  const global = window as unknown as {
    SpeechRecognitionPhrase?: new (phrase: string, boost: number) => unknown;
  };
  return global.SpeechRecognitionPhrase ?? null;
}

type Tone = "info" | "error";

// Each step of listening is written to the browser console, to help find out why
// nothing was heard on a particular computer.
const note = (what: string, detail = "") => console.info("[speech]", what, detail);

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();
// The words alone, so a change of capitals or punctuation doesn't count as new speech.
const wordsOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** What to tell the user about an error from the recognizer, or null if it needs no message. */
function problemWith(code: string): { message: string; tone: Tone } | null {
  switch (code) {
    case "aborted":
      return null; // we stopped it ourselves
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
        message: "Speech recognition needs the internet, and couldn't reach its service. Try again.",
        tone: "error",
      };
    default:
      return { message: "Speech recognition failed. Try again.", tone: "error" };
  }
}

interface SpeechOptions {
  /**
   * What was said, once the person has finished speaking, and the recognizer's other
   * guesses at the whole thing (most likely first), in case the first one was misheard.
   */
  onSpeech: (heard: string, otherGuesses: string[]) => void;
  /** Listening could not start, or nothing was made out: a message for the user. */
  onProblem: (message: string, tone: Tone) => void;
}

/**
 * Listen with the browser's own speech recognition (no server, no key). `start` begins
 * listening; it ends by itself once the person has paused for a moment, or when `stop`
 * is called. The words go to `onSpeech`, and `hearing` shows them as they come in.
 *
 * Where the browser can recognise speech on the device, that is used, with a list of
 * math words to favour; otherwise it uses the browser's online service.
 */
export function useSpeechRecognition({ onSpeech, onProblem }: SpeechOptions) {
  const [listening, setListening] = useState(false);
  const [hearing, setHearing] = useState("");

  // What is listening right now, if anything. `cancel` drops whatever it heard.
  const session = useRef<{ stop: () => void; cancel: () => void } | null>(null);
  // When listening last ended, to tell a deliberate tap from one that came just too late.
  const endedAt = useRef(0);
  // Whether on-device recognition is ready, and whether it has failed here before.
  const onDevice = useRef<"unknown" | "available" | "unavailable">("unknown");
  const onDeviceFailed = useRef(false);

  // The callbacks may change between renders; listening should call the latest ones.
  const latest = useRef({ onSpeech, onProblem });
  useEffect(() => {
    latest.current = { onSpeech, onProblem };
  });

  /** Find out (again) whether on-device recognition is ready. It can become ready later. */
  const checkOnDevice = useCallback(() => {
    const Recognizer = recognizerClass();
    if (!Recognizer?.available) {
      onDevice.current = "unavailable";
      return;
    }
    Recognizer.available({ langs: [LANGUAGE], processLocally: true })
      .then((answer) => {
        onDevice.current = answer === "available" ? "available" : "unavailable";
        note("on-device recognition", answer);
      })
      .catch(() => {
        onDevice.current = "unavailable";
      });
  }, []);
  useEffect(checkOnDevice, [checkOnDevice]);

  /** Start listening. Gives false if it didn't start (already listening, or it could not). */
  const start = useCallback((): boolean => {
    if (session.current) return false;
    // The browser stops listening by itself, so a tap meant to stop it can land just after
    // it already has. That tap must not start another round.
    if (Date.now() - endedAt.current < RESTART_GRACE_MS) return false;

    const Recognizer = recognizerClass();
    if (!Recognizer) {
      latest.current.onProblem("This browser can't recognise speech. Try Chrome, Edge or Safari.", "error");
      return false;
    }

    // One round of listening. It can use more than one recognizer: a retry after a network
    // hiccup, or going online when on-device recognition doesn't work.
    const began = Date.now();
    let recognizer: Recognizer | null = null;
    let heard = ""; // everything so far, sure or not
    let otherGuesses: string[] = [];
    let lastChange = began;
    let gotAudio = false; // the microphone opened
    let gotSound = false; // something louder than silence came in
    let stopping = false; // we asked the recognizer to stop
    let cancelled = false;
    let done = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;

    const nothingHeard = () => {
      if (!gotAudio) {
        return "I couldn't get any audio from the microphone. Check that the browser and your computer allow it, and that the right microphone is selected.";
      }
      if (!gotSound) {
        return "The microphone is on, but I couldn't hear any sound. Check its input volume and that the right microphone is selected.";
      }
      return "I heard sound but couldn't make out any words. Speak English, close to the microphone.";
    };

    const finish = () => {
      done = true;
      clearInterval(watcher);
      clearTimeout(stopTimer);
      session.current = null;
      endedAt.current = Date.now();
      setListening(false);
      setHearing("");
      checkOnDevice();
    };

    const stopListening = (why: string) => {
      if (stopping || done || !recognizer) return;
      stopping = true;
      note("stopping", why);
      recognizer.stop();
      // If the browser never says it has finished, finish anyway with what was heard.
      const current = recognizer;
      stopTimer = setTimeout(() => current.abort(), STOP_TIMEOUT_MS);
    };

    const attempt = (local: boolean, retriesLeft: number) => {
      const r = new Recognizer();
      recognizer = r;
      r.lang = LANGUAGE;
      r.continuous = true; // we decide when the sentence is over, not the browser
      r.interimResults = true; // so the words show as they are said
      r.maxAlternatives = GUESSES;
      if (local) r.processLocally = true;
      const Phrase = local ? phraseClass() : null;
      let usingPhrases = false;
      if (Phrase) {
        try {
          r.phrases = BOARD_PHRASES.map((phrase) => new Phrase(phrase, PHRASE_BOOST));
          usingPhrases = true;
        } catch {
          // Listening still works without the word list.
        }
      }

      let error: string | null = null;

      r.onaudiostart = () => {
        gotAudio = true;
        note("audio started");
      };
      r.onsoundstart = () => {
        gotSound = true;
        note("sound heard");
      };
      r.onspeechstart = () => note("speech heard");
      r.onresult = (event) => {
        const results = Array.from(event.results);
        const guess = (k: number) =>
          tidy(results.map((result) => (result.length > k ? result[k] : result[0])?.transcript ?? "").join(" "));

        const next = guess(0);
        if (wordsOf(next) !== wordsOf(heard)) lastChange = Date.now();
        heard = next;
        otherGuesses = [];
        for (let k = 1; k < GUESSES; k++) {
          const other = guess(k);
          if (other && wordsOf(other) !== wordsOf(heard) && !otherGuesses.includes(other)) otherGuesses.push(other);
        }
        const final = results.every((result) => result.isFinal);
        note("words", `${JSON.stringify(heard)} (${final ? "final" : "so far"})`);
        setHearing(heard);
      };
      r.onerror = (event) => {
        note("error", `${event.error} ${event.message ?? ""}`);
        error = event.error;
      };
      r.onend = () => {
        if (recognizer !== r || done) return; // an older recognizer, already replaced
        note("ended", `audio=${gotAudio} sound=${gotSound} words=${JSON.stringify(heard)}`);

        if (cancelled) {
          finish();
          return;
        }
        // Nothing heard yet and it failed: try again a different way, if there is one.
        if (error && !heard && !stopping) {
          const unrecoverable = ["no-speech", "aborted", "not-allowed", "service-not-allowed", "audio-capture"];
          if (local && !unrecoverable.includes(error)) {
            onDeviceFailed.current = true;
            note("on-device recognition failed, going online", error);
            if (tryAttempt(false, retriesLeft)) return;
          } else if (error === "network" && retriesLeft > 0) {
            note("retrying after a network error");
            if (tryAttempt(local, retriesLeft - 1)) return;
          }
        }

        finish();
        if (heard) {
          latest.current.onSpeech(heard, otherGuesses);
          return;
        }
        const problem =
          error && error !== "no-speech" ? problemWith(error) : { message: nothingHeard(), tone: "info" as Tone };
        if (problem) latest.current.onProblem(problem.message, problem.tone);
      };

      r.start();
      note("started", `${local ? "on device" : "online"}, ${LANGUAGE}${usingPhrases ? `, ${BOARD_PHRASES.length} phrases` : ""}`);
    };
    /** Start a recognizer, and say whether it started. */
    const tryAttempt = (local: boolean, retriesLeft: number) => {
      try {
        attempt(local, retriesLeft);
        return true;
      } catch (error) {
        note("couldn't start", error instanceof Error ? error.message : "");
        return false;
      }
    };

    // End the round once the words have settled, or if nothing comes, or after the time limit.
    const watcher = setInterval(() => {
      const now = Date.now();
      if (heard && now - lastChange >= END_AFTER_QUIET_MS) stopListening("pause after speaking");
      else if (!heard && now - began >= NO_WORDS_MS) stopListening("no words");
      else if (now - began >= MAX_LISTEN_MS) stopListening("time limit");
    }, CHECK_EVERY_MS);

    const local = onDevice.current === "available" && !onDeviceFailed.current;
    let started = tryAttempt(local, NETWORK_RETRIES);
    if (!started && local) {
      onDeviceFailed.current = true;
      started = tryAttempt(false, NETWORK_RETRIES);
    }
    if (!started) {
      clearInterval(watcher);
      latest.current.onProblem("Couldn't start listening. Try again.", "error");
      return false;
    }

    session.current = {
      stop: () => stopListening("tap"),
      cancel: () => {
        cancelled = true;
        recognizer?.abort();
      },
    };
    setListening(true);
    return true;
  }, [checkOnDevice]);

  const stop = useCallback(() => session.current?.stop(), []);

  // Leaving the page stops listening and drops what was heard.
  useEffect(() => () => session.current?.cancel(), []);

  return { listening, hearing, start, stop };
}
