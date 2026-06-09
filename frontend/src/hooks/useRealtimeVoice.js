import { useCallback, useEffect, useRef, useState } from "react";
import API, { getApiBaseUrl } from "../services/api";
import {
  createSpeechRecognizer,
  createSpeechSpeaker,
} from "../utils/browserSpeech";

const SILENCE_MS = 250;
const MIN_SPEECH_MS = 400;
const MIN_RECORD_MS = 700;
const VOLUME_THRESHOLD = 0.015;
const INTERRUPTION_VOLUME_THRESHOLD = 0.08; // Adjust higher (e.g., 0.12) if your speakers bleed into the mic
const MIN_BLOB_BYTES = 1000;
const POST_SPEAK_COOLDOWN_MS = 80;
const RETRY_COOLDOWN_MS = 1200;
const RECOGNITION_RESTART_MS = 50;
const RECOGNITION_RETRY_MS = 100;
const LISTEN_RESUME_GRACE_MS = 40;

const USE_FAST_PATH = true;

function getRmsVolume(analyser) {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const sample = (data[i] - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / data.length);
}

function playBase64Audio(base64Audio, audioRef, urlRef) {
  return new Promise((resolve, reject) => {
    if (!base64Audio) {
      resolve();
      return;
    }

    try {
      const blob = new Blob(
        [Uint8Array.from(atob(base64Audio), (c) => c.charCodeAt(0))],
        { type: "audio/wav" }
      );
      const url = URL.createObjectURL(blob);
      const audio = audioRef.current || new Audio();
      audioRef.current = audio;

      const done = () => {
        audio.onended = null;
        audio.onerror = null;
        resolve();
      };

      audio.onended = done;
      audio.onerror = () => {
        audio.onended = null;
        audio.onerror = null;
        reject(new Error("Playback failed"));
      };

      if (urlRef.current && urlRef.current !== url) {
        URL.revokeObjectURL(urlRef.current);
      }
      urlRef.current = url;

      audio.src = url;
      audio.currentTime = 0;
      audio.play()
        .catch(err => console.error("Audio play failed:", err));
    } catch (err) {
      reject(err);
    }
  });
}

async function readNdjsonStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      await onEvent(event);
    }
  }

  if (buffer.trim()) {
    const event = JSON.parse(buffer);
    await onEvent(event);
  }
}

export function useRealtimeVoice() {
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState("");
  const [liveLevel, setLiveLevel] = useState(0);
  const [interimText, setInterimText] = useState("");

  // Control and interruption Refs
  const streamAbortRef = useRef(null);
  const interruptTimerRef = useRef(null);
  const interruptionRef = useRef(false);
  const partialAssistantTextRef = useRef(""); // Tracks precise context for backend matching

  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const rafRef = useRef(null);
  const vadLoopRef = useRef(null);
  const phaseRef = useRef("idle");
  const speechStartedAtRef = useRef(null);
  const silenceStartedAtRef = useRef(null);
  const isCapturingRef = useRef(false);
  const isSendingRef = useRef(false);
  const playbackAudioRef = useRef(null);
  const playbackUrlRef = useRef(null);
  const activeRef = useRef(false);
  const listenAfterRef = useRef(0);
  const retryAfterRef = useRef(0);
  const captureMimeRef = useRef("audio/webm");
  const audioQueueRef = useRef([]);
  const audioPlayingRef = useRef(false);
  const abortRef = useRef(null);
  const recognitionRef = useRef(null);
  const recognitionActiveRef = useRef(false);
  const sendTextUtteranceRef = useRef(null);
  const startRecognitionRef = useRef(null);
  const pendingTextRef = useRef("");
  const interimTextRef = useRef("");
  const speakerRef = useRef(null);

  const setPhaseSafe = (phase) => {
    phaseRef.current = phase;
    setPhase(phase);
  };

  const stopPlayback = useCallback(() => {
    audioQueueRef.current = [];
    audioPlayingRef.current = false;
    speakerRef.current?.stop();
    const audio = playbackAudioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
    }
  }, []);

  const revokePlaybackUrl = () => {
    const playbackUrl = playbackUrlRef.current;
    if (playbackUrl) {
      URL.revokeObjectURL(playbackUrl);
      playbackUrlRef.current = null;
    }
  };

  const startRecognition = useCallback(() => {
    if (!USE_FAST_PATH || !activeRef.current || isSendingRef.current) return;
    if (Date.now() < listenAfterRef.current) return;
    if (Date.now() < retryAfterRef.current) return;
    if (recognitionActiveRef.current) return;

    if (!recognitionRef.current && !setupBrowserRecognition()) return;
    const rec = recognitionRef.current;
    if (!rec) return;

    try {
      speechStartedAtRef.current = null;
      silenceStartedAtRef.current = null;
      rec.start();
    } catch {
      recognitionRef.current = null;
      recognitionActiveRef.current = false;
      window.setTimeout(
        () => startRecognitionRef.current?.(),
        RECOGNITION_RETRY_MS
      );
    }
  }, []);

  const interruptAssistant = useCallback((triggeringText = "") => {
    if (interruptionRef.current) return;
    interruptionRef.current = true;

    console.log("Interrupting assistant. Logic trigger source:", triggeringText);

    speakerRef.current?.stop();
    stopPlayback();

    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }

    isSendingRef.current = false;
    setPhaseSafe("listening");

    if (!pendingTextRef.current && triggeringText && triggeringText !== "User interrupted speech") {
      pendingTextRef.current = triggeringText;
    }

    window.setTimeout(() => {
      startRecognitionRef.current?.();
    }, 50);
  }, [stopPlayback]);

  const setupBrowserRecognition = useCallback(() => {
    const recognition = createSpeechRecognizer({
      onInterim(text) {
        if (phaseRef.current !== "speaking") return;

        const clean = text.trim();
        if (clean.length < 3) return;

        clearTimeout(interruptTimerRef.current);
        interruptTimerRef.current = setTimeout(() => {
          interruptAssistant(clean);
          pendingTextRef.current = clean;

          sendTextUtteranceRef.current?.(clean);
        });
      },
      onStart: () => {
        recognitionActiveRef.current = true;
        if (phaseRef.current !== "speaking") {
          setPhaseSafe("listening");
        }
      },
      onFinal: (text) => {
        interimTextRef.current = "";
        setInterimText("");
        pendingTextRef.current = `${pendingTextRef.current} ${text}`.trim();
      },
      onError: (code) => {
        recognitionActiveRef.current = false;
        if (code === "not-allowed") {
          setError("Microphone access denied for speech recognition.");
        }
      },
      onEnd: () => {
        recognitionActiveRef.current = false;
        const text = pendingTextRef.current.trim();
        pendingTextRef.current = "";

        if (text && activeRef.current && !isSendingRef.current) {
          sendTextUtteranceRef.current?.(text);
          return;
        }

        if (
          activeRef.current &&
          !isSendingRef.current &&
          phaseRef.current === "listening"
        ) {
          window.setTimeout(
            () => startRecognitionRef.current?.(),
            RECOGNITION_RESTART_MS
          );
        }
      },
    });

    recognitionRef.current = recognition;
    return Boolean(recognition);
  }, [interruptAssistant]);

  useEffect(() => {
    startRecognitionRef.current = startRecognition;
  }, [startRecognition]);

  const streamVoiceChat = useCallback(async (formData, handlers) => {
    const controller = new AbortController();
    streamAbortRef.current = controller;
    const response = await fetch(`${getApiBaseUrl()}/voice-chat-stream`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      let message = "Voice request failed";
      try {
        const data = await response.json();
        message = data.error || message;
      } catch { /* ignore */ }
      const err = new Error(message);
      err.status = response.status;
      err.recoverable = response.status === 400;
      throw err;
    }
    await readNdjsonStream(response, handlers.onEvent);
  }, []);

  const streamVoiceChatText = useCallback(async (text, context, handlers) => {
    const controller = new AbortController();
    streamAbortRef.current = controller;
    const response = await fetch(`${getApiBaseUrl()}/voice-text-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        text, 
        interrupted_context: context 
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let message = "Voice request failed";
      try {
        const data = await response.json();
        message = data.error || message;
      } catch { /* ignore */ }
      const err = new Error(message);
      err.status = response.status;
      err.recoverable = response.status === 400;
      throw err;
    }
    await readNdjsonStream(response, handlers.onEvent);
  }, []);

  const playNextInQueue = useCallback(async () => {
    if (audioPlayingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) return;

    audioPlayingRef.current = true;
    setPhaseSafe("speaking");

    try {
      await playBase64Audio(next, playbackAudioRef, playbackUrlRef);
    } catch (e) {
      console.warn("Audio playback error:", e);
    } finally {
      audioPlayingRef.current = false;
      if (audioQueueRef.current.length > 0) {
        await playNextInQueue();
      }
    }
  }, []);

  const enqueueAudio = useCallback(
    (base64) => {
      if (!base64) return;
      audioQueueRef.current.push(base64);
      playNextInQueue();
    },
    [playNextInQueue]
  );

  const stopRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch { /* ignore */ }
  }, []);

  const cleanupStream = useCallback(() => {
    if (interruptTimerRef.current) {
      clearTimeout(interruptTimerRef.current);
      interruptTimerRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    stopRecognition();
    recognitionRef.current = null;
    recognitionActiveRef.current = false;
    if (mediaRecorderRef.current?.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch { /* ignore */ }
    }
    mediaRecorderRef.current = null;
    isCapturingRef.current = false;
    isSendingRef.current = false;
    pendingTextRef.current = "";
    interimTextRef.current = "";
    setInterimText("");

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  }, [stopRecognition]);

  const waitForSpeechThenListen = useCallback(() => {
    const check = () => {
      const speaking =
        speakerRef.current?.isActive() ||
        (typeof speechSynthesis !== "undefined" && speechSynthesis.speaking) ||
        audioPlayingRef.current ||
        audioQueueRef.current.length > 0;

      if (speaking) {
        window.setTimeout(check, 80);
        return;
      }

      listenAfterRef.current = Date.now() + POST_SPEAK_COOLDOWN_MS;
      if (USE_FAST_PATH) {
        setPhaseSafe("listening");
        window.setTimeout(
          () => startRecognitionRef.current?.(),
          POST_SPEAK_COOLDOWN_MS + LISTEN_RESUME_GRACE_MS
        );
      } else if (activeRef.current) {
        setPhaseSafe("listening");
      }
    };
    check();
  }, []);

  const handleStreamEvents = useCallback(
    async (event, state) => {
      const { assistantTextRef, assistantMessageStartedRef } = state;
      if (event.event === "transcript") {
        const userText = event.user_text || "";
        setMessages((prev) => [...prev, { role: "user", text: userText }]);
      }
      if (streamAbortRef.current?.signal?.aborted) {
        return;
      }
      if (event.event === "delta") {
        const delta = event.delta || "";
        assistantTextRef.current += delta;
        
        partialAssistantTextRef.current = assistantTextRef.current;

        if (USE_FAST_PATH && speakerRef.current) {
          speakerRef.current.append(delta);
          setPhaseSafe("speaking");
        }

        if (!assistantMessageStartedRef.current) {
          assistantMessageStartedRef.current = true;
          setMessages((prev) => [
            ...prev,
            { role: "assistant", text: assistantTextRef.current },
          ]);
        } else {
          const snapshot = assistantTextRef.current;
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              updated[updated.length - 1] = { ...last, text: snapshot };
            }
            return updated;
          });
        }
      }

      if (event.event === "audio" && event.audio && !USE_FAST_PATH) {
        enqueueAudio(event.audio);
      }

      if (event.event === "done") {
        const finalText =
          event.ai_text || event.ai_response || assistantTextRef.current;
        assistantTextRef.current = finalText;
        partialAssistantTextRef.current = ""; 
        if (USE_FAST_PATH) {
          speakerRef.current?.flush();
        }
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") {
            updated[updated.length - 1] = { ...last, text: finalText };
          } else if (finalText) {
            updated.push({ role: "assistant", text: finalText });
          }
          return updated;
        });
      }

      if (event.event === "error") {
        throw new Error(event.error || "Voice stream failed");
      }
    },
    [enqueueAudio]
  );

  const sendTextUtterance = useCallback(
    async (text) => {
      const trimmed = (text || "").trim();
      if (!trimmed || isSendingRef.current) return;
      if (Date.now() < retryAfterRef.current) {
        startRecognition();
        return;
      }

      isSendingRef.current = true;
      const historyContext = partialAssistantTextRef.current; 
      interruptionRef.current = false;
      stopRecognition();
      setInterimText("");
      setPhaseSafe("processing");
      setError("");

      speakerRef.current = createSpeechSpeaker({
        onIdle: waitForSpeechThenListen,
      });

      const assistantTextRef = { current: "" };
      const assistantMessageStartedRef = { current: false };

      try {
        await streamVoiceChatText(trimmed, historyContext, {
          onEvent: (event) =>
            handleStreamEvents(event, {
              assistantTextRef,
              assistantMessageStartedRef,
            }),
        });
      } catch (err) {
        speakerRef.current?.stop();
        retryAfterRef.current = Date.now() + RETRY_COOLDOWN_MS;
        if (!err.recoverable && err.status !== 400) {
          setError(err.message || "Voice request failed.");
        }
      } {
        isSendingRef.current = false;
        waitForSpeechThenListen();
      }
    },
    [handleStreamEvents, startRecognition, stopRecognition, waitForSpeechThenListen, streamVoiceChatText]
  );

  useEffect(() => {
    sendTextUtteranceRef.current = sendTextUtterance;
  }, [sendTextUtterance]);

  useEffect(() => {
    if (!active || !USE_FAST_PATH) return undefined;

    const keepListening = window.setInterval(() => {
      const readyToListen =
        activeRef.current &&
        phaseRef.current === "listening" &&
        !isSendingRef.current &&
        !recognitionActiveRef.current &&
        Date.now() >= listenAfterRef.current &&
        Date.now() >= retryAfterRef.current;

      if (readyToListen) {
        startRecognitionRef.current?.();
      }
    }, 500);

    return () => window.clearInterval(keepListening);
  }, [active]);

  const sendAudioUtterance = useCallback(async () => {
    if (isSendingRef.current) return;
    if (Date.now() < retryAfterRef.current) {
      setPhaseSafe("listening");
      return;
    }
    if (!chunksRef.current.length) {
      setPhaseSafe("listening");
      return;
    }

    const blob = new Blob(chunksRef.current, { type: captureMimeRef.current });
    chunksRef.current = [];

    if (blob.size < MIN_BLOB_BYTES) {
      setPhaseSafe("listening");
      return;
    }

    isSendingRef.current = true;
    interruptionRef.current = false;
    setPhaseSafe("processing");
    setError("");

    const formData = new FormData();
    formData.append("audio", blob, "utterance.webm");
    if (partialAssistantTextRef.current) {
      formData.append("interrupted_context", partialAssistantTextRef.current);
    }

    const assistantTextRef = { current: "" };
    const assistantMessageStartedRef = { current: false };

    try {
      await streamVoiceChat(formData, {
        onEvent: (event) =>
          handleStreamEvents(event, {
            assistantTextRef,
            assistantMessageStartedRef,
          }),
      });
    } catch (err) {
      retryAfterRef.current = Date.now() + RETRY_COOLDOWN_MS;
      if (!err.recoverable && err.status !== 400) {
        setError(err.message || "Voice request failed.");
      }
    } finally {
      isSendingRef.current = false;
      waitForSpeechThenListen();
    }
  }, [handleStreamEvents, waitForSpeechThenListen, streamVoiceChat]);

  const startCapture = useCallback(() => {
    if (!streamRef.current || isCapturingRef.current || isSendingRef.current) return;
    if (phaseRef.current !== "listening") return;
    if (Date.now() < listenAfterRef.current) return;
    if (Date.now() < retryAfterRef.current) return;

    chunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    captureMimeRef.current = mimeType;

    const recorder = new MediaRecorder(streamRef.current, { mimeType });
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      isCapturingRef.current = false;
      mediaRecorderRef.current = null;
      window.setTimeout(() => {
        if (activeRef.current && !isSendingRef.current) {
          sendAudioUtterance();
        }
      }, 60);
    };

    recorder.start(200);
    isCapturingRef.current = true;
    speechStartedAtRef.current = Date.now();
    silenceStartedAtRef.current = null;
  }, [sendAudioUtterance]);

  const stopCapture = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state !== "recording") return;

    const duration = speechStartedAtRef.current ? Date.now() - speechStartedAtRef.current : 0;
    if (duration < MIN_RECORD_MS) {
      try { recorder.stop(); } catch {}
      chunksRef.current = [];
      isCapturingRef.current = false;
      mediaRecorderRef.current = null;
      speechStartedAtRef.current = null;
      silenceStartedAtRef.current = null;
      return;
    }

    try {
      if (typeof recorder.requestData === "function") recorder.requestData();
      recorder.stop();
    } catch {}
  }, []);

  const scheduleVadLoop = useCallback(() => {
    rafRef.current = requestAnimationFrame(() => {
      vadLoopRef.current?.();
    });
  }, []);

  const runVadLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser || !activeRef.current) return;

    const volume = getRmsVolume(analyser);
    if (phaseRef.current === "listening") setLiveLevel(volume);

    const currentPhase = phaseRef.current;
    const loud = volume > VOLUME_THRESHOLD;
    const pastCooldown = Date.now() >= listenAfterRef.current;
    const pastRetry = Date.now() >= retryAfterRef.current;

    // Hard Volume Interruption Bypass Logic Block
    if (currentPhase === "speaking" && volume > INTERRUPTION_VOLUME_THRESHOLD) {
      console.log("Barge-in volume threshold breached! Level:", volume);
      interruptAssistant("User interrupted speech");
      scheduleVadLoop();
      return;
    }

    if (USE_FAST_PATH) {
      if (currentPhase === "listening" && pastCooldown && pastRetry && !isSendingRef.current) {
        if (loud) {
          if (!speechStartedAtRef.current) speechStartedAtRef.current = Date.now();
          silenceStartedAtRef.current = null;
        } else if (speechStartedAtRef.current) {
          const speechDuration = Date.now() - speechStartedAtRef.current;
          if (speechDuration >= MIN_SPEECH_MS) {
            if (!silenceStartedAtRef.current) {
              silenceStartedAtRef.current = Date.now();
            } else if (Date.now() - silenceStartedAtRef.current >= SILENCE_MS) {
              stopRecognition();
              silenceStartedAtRef.current = null;
              speechStartedAtRef.current = null;
            }
          }
        }
      }
      scheduleVadLoop();
      return;
    }

    if (currentPhase === "listening" && pastCooldown && pastRetry && !isSendingRef.current && !audioPlayingRef.current) {
      if (loud) {
        silenceStartedAtRef.current = null;
        if (!isCapturingRef.current) startCapture();
      } else if (isCapturingRef.current && speechStartedAtRef.current) {
        const speechDuration = Date.now() - speechStartedAtRef.current;
        if (speechDuration >= MIN_SPEECH_MS) {
          if (!silenceStartedAtRef.current) {
            silenceStartedAtRef.current = Date.now();
          } else if (Date.now() - silenceStartedAtRef.current >= SILENCE_MS) {
            stopCapture();
            silenceStartedAtRef.current = null;
            speechStartedAtRef.current = null;
          }
        }
      }
    }
    scheduleVadLoop();
  }, [scheduleVadLoop, startCapture, stopCapture, stopRecognition, interruptAssistant]);

  useEffect(() => {
    vadLoopRef.current = runVadLoop;
  }, [runVadLoop]);

  const startConversation = useCallback(async () => {
    setError("");
    retryAfterRef.current = 0;
    listenAfterRef.current = 0;

    if (typeof speechSynthesis !== "undefined") speechSynthesis.getVoices();
    fetch(`${window.location.protocol}//localhost:5000/health`, { method: "GET" }).catch(() => {});

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      streamRef.current = stream;
      activeRef.current = true;
      setActive(true);

      const audioContext = new AudioContext();
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.55;
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      if (USE_FAST_PATH && setupBrowserRecognition()) {
        setPhaseSafe("listening");
        startRecognition();
        runVadLoop();
        return;
      }

      setPhaseSafe("listening");
      runVadLoop();
    } catch (err) {
      setError("Microphone access denied or unavailable.");
      console.error(err);
    }
  }, [runVadLoop, setupBrowserRecognition, startRecognition]);

  const endConversation = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    stopPlayback();
    cleanupStream();
    setPhaseSafe("idle");
    setLiveLevel(0);
    setInterimText("");
  }, [cleanupStream, stopPlayback]);

  const clearChat = useCallback(async () => {
    setError("");
    try {
      await API.post("/clear-chat");
      setMessages([]);
    } catch (err) {
      setError(err.message || "Failed to clear chat.");
    }
  }, []);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      stopPlayback();
      cleanupStream();
      revokePlaybackUrl();
    };
  }, [cleanupStream, stopPlayback]);

  return {
    active,
    phase,
    messages,
    error,
    liveLevel,
    interimText,
    fastMode: USE_FAST_PATH,
    startConversation,
    endConversation,
    clearChat,
  };
}