const SpeechRecognition =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

const SPEECH_RATE = 1.14;
const SPEECH_PITCH = 1;
const MIN_SEGMENT_WORDS = 5;
const FALLBACK_SEGMENT_WORDS = 9;
const PREFERRED_VOICE_HINTS = [
  "neerja",
  "aria",
  "jenny",
  "sonia",
  "natural",
  "online",
  "google us english",
  "google uk english female",
];

export function isBrowserSttSupported() {
  return Boolean(SpeechRecognition);
}

export function isBrowserTtsSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function createSpeechRecognizer({
  onStart,
  onFinal,
  onInterim,
  onError,
  onEnd,
}) {
  if (!SpeechRecognition) return null;

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = "en-IN";
  recognition.maxAlternatives = 1;

  let finalTranscript = "";

  recognition.onstart = () => {
    onStart?.();
  };

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript || "";
      if (result.isFinal) {
        finalTranscript += text;
      } else {
        interim += text;
      }
    }
    if (interim && onInterim) onInterim(interim);
    if (finalTranscript.trim() && onFinal) {
      onFinal(finalTranscript.trim());
      finalTranscript = "";
    }
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    onError?.(event.error || "Speech recognition failed");
  };

  recognition.onend = () => {
    if (finalTranscript.trim() && onFinal) {
      onFinal(finalTranscript.trim());
      finalTranscript = "";
    }
    onEnd?.();
  };

  return recognition;
}

function extractSpeakableSegment(text) {
  const t = (text || "").trim();
  if (!t) return null;

  const words = t.split(/\s+/);
  const sentence = t.match(/^[^.!?]+[.!?]/);
  if (sentence && sentence[0].split(/\s+/).length >= MIN_SEGMENT_WORDS) {
    return sentence[0].trim();
  }
  if (words.length >= FALLBACK_SEGMENT_WORDS) {
    return words.slice(0, FALLBACK_SEGMENT_WORDS).join(" ");
  }
  return null;
}

function scoreVoice(voice) {
  const name = `${voice.name || ""} ${voice.voiceURI || ""}`.toLowerCase();
  const lang = (voice.lang || "").toLowerCase();
  let score = 0;

  if (lang.startsWith("en-in")) score += 30;
  else if (lang.startsWith("en-us")) score += 24;
  else if (lang.startsWith("en-gb")) score += 22;
  else if (lang.startsWith("en")) score += 16;

  PREFERRED_VOICE_HINTS.forEach((hint, index) => {
    if (name.includes(hint)) score += 28 - index;
  });

  if (name.includes("natural")) score += 18;
  if (name.includes("online")) score += 12;
  if (name.includes("microsoft")) score += 10;
  if (name.includes("google")) score += 8;
  if (name.includes("female")) score += 4;
  if (voice.default) score += 2;

  return score;
}

function getPreferredVoice() {
  if (!isBrowserTtsSupported()) return null;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  return [...voices].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] || null;
}

function createUtterance(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = SPEECH_RATE;
  utterance.pitch = SPEECH_PITCH;
  utterance.volume = 1;
  utterance.lang = "en-IN";

  const preferred = getPreferredVoice();
  if (preferred) {
    utterance.voice = preferred;
    utterance.lang = preferred.lang || utterance.lang;
  }

  return utterance;
}

export function createSpeechSpeaker({ onIdle } = {}) {
  let buffer = "";
  let spokenChars = 0;
  let speaking = false;
  let cancelled = false;
  let flushRequested = false;
  let idleNotified = false;

  const notifyIdle = () => {
    const remaining = buffer.slice(spokenChars).trim();
    if (!flushRequested || speaking || remaining || idleNotified) return;
    idleNotified = true;
    window.setTimeout(() => onIdle?.(), 0);
  };

  const speakSegment = (segment, endIndex) => {
    speaking = true;
    idleNotified = false;
    const utterance = createUtterance(segment);

    utterance.onend = () => {
      speaking = false;
      spokenChars = endIndex;
      trySpeak();
      notifyIdle();
    };
    utterance.onerror = () => {
      speaking = false;
      spokenChars = endIndex;
      trySpeak();
      notifyIdle();
    };

    speechSynthesis.speak(utterance);
  };

  function trySpeak() {
    if (cancelled || speaking || !isBrowserTtsSupported()) return;

    const remaining = buffer.slice(spokenChars).trimStart();
    const segment = extractSpeakableSegment(remaining);
    if (!segment) {
      if (flushRequested && remaining) {
        speakSegment(remaining, buffer.length);
      } else {
        notifyIdle();
      }
      return;
    }

    const startIdx = buffer.indexOf(segment, spokenChars);
    if (startIdx === -1) return;

    speakSegment(segment, startIdx + segment.length);
  }

  return {
    append(delta) {
      if (!delta || cancelled) return;
      buffer += delta;
      idleNotified = false;
      trySpeak();
    },
    flush() {
      if (cancelled || !isBrowserTtsSupported()) return;
      flushRequested = true;
      idleNotified = false;
      trySpeak();
      notifyIdle();
    },
    stop() {
      cancelled = true;
      if (isBrowserTtsSupported()) {
        speechSynthesis.cancel();
      }
      buffer = "";
      spokenChars = 0;
      speaking = false;
      flushRequested = false;
      idleNotified = false;
      cancelled = false;
    },
    isActive() {
      const hasPendingText = Boolean(buffer.slice(spokenChars).trim());
      const browserSpeaking =
        isBrowserTtsSupported() && speechSynthesis.speaking;
      return speaking || browserSpeaking || (flushRequested && hasPendingText);
    },
  };
}
