import { useCallback, useEffect, useRef, useState } from "react";
import API, { getApiBaseUrl } from "../services/api";

const SILENCE_MS = 800;
const MIN_SPEECH_MS = 500;
const MIN_RECORD_MS = 800;
const VOLUME_THRESHOLD = 0.02;
const MIN_BLOB_BYTES = 1000;
const POST_SPEAK_COOLDOWN_MS = 500;
const RETRY_COOLDOWN_MS = 1500;

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
      audio.play().catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

async function streamVoiceChat(formData, handlers) {
  const response = await fetch(`${getApiBaseUrl()}/voice-chat-stream`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    let message = "Voice request failed";
    try {
      const data = await response.json();
      message = data.error || message;
    } catch {
      /* ignore */
    }
    const err = new Error(message);
    err.status = response.status;
    err.recoverable = response.status === 400;
    throw err;
  }

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
      await handlers.onEvent(event);
    }
  }

  if (buffer.trim()) {
    const event = JSON.parse(buffer);
    await handlers.onEvent(event);
  }
}

export function useRealtimeVoice() {
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState("");
  const [liveLevel, setLiveLevel] = useState(0);

  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const rafRef = useRef(null);
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

  const setPhaseSafe = (next) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const stopPlayback = () => {
    audioQueueRef.current = [];
    audioPlayingRef.current = false;
    const audio = playbackAudioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
    }
  };

  const playNextInQueue = useCallback(async () => {
    if (audioPlayingRef.current) return;
    const next = audioQueueRef.current.shift();
    if (!next) return;

    audioPlayingRef.current = true;
    setPhaseSafe("speaking");

    try {
      await playBase64Audio(next, playbackAudioRef, playbackUrlRef);
    } catch (e) {
      console.warn("Audio playback:", e);
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

  const cleanupStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (mediaRecorderRef.current?.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        /* ignore */
      }
    }
    mediaRecorderRef.current = null;
    isCapturingRef.current = false;
    isSendingRef.current = false;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  const resumeListening = useCallback(() => {
    if (activeRef.current && !audioPlayingRef.current && !audioQueueRef.current.length) {
      setPhaseSafe("listening");
    }
  }, []);

  const sendUtterance = useCallback(async () => {
    if (isSendingRef.current) return;
    if (Date.now() < retryAfterRef.current) {
      resumeListening();
      return;
    }

    if (!chunksRef.current.length) {
      resumeListening();
      return;
    }

    const blob = new Blob(chunksRef.current, {
      type: captureMimeRef.current,
    });
    chunksRef.current = [];

    if (blob.size < MIN_BLOB_BYTES) {
      resumeListening();
      return;
    }

    isSendingRef.current = true;
    setPhaseSafe("processing");
    setError("");

    const formData = new FormData();
    formData.append("audio", blob, "utterance.webm");

    const controller = new AbortController();
    abortRef.current = controller;

    let userText = "";
    let assistantText = "";
    let assistantMessageStarted = false;

    try {
      await streamVoiceChat(formData, {
        onEvent: async (event) => {
          if (event.event === "transcript") {
            userText = event.user_text || "";
            setMessages((prev) => [...prev, { role: "user", text: userText }]);
          }

          if (event.event === "delta") {
            assistantText += event.delta || "";
            if (!assistantMessageStarted) {
              assistantMessageStarted = true;
              setMessages((prev) => [
                ...prev,
                { role: "assistant", text: assistantText },
              ]);
            } else {
              const snapshot = assistantText;
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                  updated[updated.length - 1] = {
                    ...last,
                    text: snapshot,
                  };
                }
                return updated;
              });
            }
          }

          if (event.event === "audio" && event.audio) {
            enqueueAudio(event.audio);
          }

          if (event.event === "done") {
            assistantText = event.ai_text || event.ai_response || assistantText;
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === "assistant") {
                updated[updated.length - 1] = {
                  ...last,
                  text: assistantText,
                };
              } else if (assistantText) {
                updated.push({ role: "assistant", text: assistantText });
              }
              return updated;
            });
          }

          if (event.event === "error") {
            throw new Error(event.error || "Voice stream failed");
          }
        },
      });

      listenAfterRef.current = Date.now() + POST_SPEAK_COOLDOWN_MS;
    } catch (err) {
      if (err.name === "AbortError") return;

      if (err.recoverable || err.status === 400) {
        retryAfterRef.current = Date.now() + RETRY_COOLDOWN_MS;
      } else {
        setError(err.message || "Voice request failed.");
        retryAfterRef.current = Date.now() + RETRY_COOLDOWN_MS;
      }
    } finally {
      abortRef.current = null;
      isSendingRef.current = false;

      const waitForAudio = () => {
        if (audioPlayingRef.current || audioQueueRef.current.length > 0) {
          window.setTimeout(waitForAudio, 200);
          return;
        }
        listenAfterRef.current = Date.now() + POST_SPEAK_COOLDOWN_MS;
        resumeListening();
      };
      waitForAudio();
    }
  }, [enqueueAudio, resumeListening]);

  const startCapture = useCallback(() => {
    if (!streamRef.current || isCapturingRef.current || isSendingRef.current) {
      return;
    }
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
          sendUtterance();
        }
      }, 80);
    };

    recorder.start(200);
    isCapturingRef.current = true;
    speechStartedAtRef.current = Date.now();
    silenceStartedAtRef.current = null;
  }, [sendUtterance]);

  const stopCapture = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state !== "recording") return;

    const duration = speechStartedAtRef.current
      ? Date.now() - speechStartedAtRef.current
      : 0;

    if (duration < MIN_RECORD_MS) {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
      chunksRef.current = [];
      isCapturingRef.current = false;
      mediaRecorderRef.current = null;
      speechStartedAtRef.current = null;
      silenceStartedAtRef.current = null;
      return;
    }

    try {
      if (typeof recorder.requestData === "function") {
        recorder.requestData();
      }
      recorder.stop();
    } catch {
      /* ignore */
    }
  }, []);

  const runVadLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser || !activeRef.current) return;

    const volume = getRmsVolume(analyser);

    if (phaseRef.current === "listening") {
      setLiveLevel(volume);
    }

    const currentPhase = phaseRef.current;
    const loud = volume > VOLUME_THRESHOLD;
    const pastCooldown = Date.now() >= listenAfterRef.current;
    const pastRetry = Date.now() >= retryAfterRef.current;

    if (
      currentPhase === "listening" &&
      pastCooldown &&
      pastRetry &&
      !isSendingRef.current &&
      !audioPlayingRef.current
    ) {
      if (loud) {
        silenceStartedAtRef.current = null;
        if (!isCapturingRef.current) {
          startCapture();
        }
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

    rafRef.current = requestAnimationFrame(runVadLoop);
  }, [startCapture, stopCapture]);

  const startConversation = useCallback(async () => {
    setError("");
    retryAfterRef.current = 0;
    listenAfterRef.current = 0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;
      const audioContext = new AudioContext();
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.55;
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      activeRef.current = true;
      setActive(true);
      setPhaseSafe("listening");
      runVadLoop();
    } catch (err) {
      setError("Microphone access denied or unavailable.");
      console.error(err);
    }
  }, [runVadLoop]);

  const endConversation = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    stopPlayback();
    cleanupStream();
    setPhaseSafe("idle");
    setLiveLevel(0);
  }, [cleanupStream]);

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
      if (playbackUrlRef.current) {
        URL.revokeObjectURL(playbackUrlRef.current);
      }
    };
  }, [cleanupStream]);

  return {
    active,
    phase,
    messages,
    error,
    liveLevel,
    startConversation,
    endConversation,
    clearChat,
  };
}
