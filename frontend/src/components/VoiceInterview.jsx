import { useRealtimeVoice } from "../hooks/useRealtimeVoice";

const PHASE_LABELS = {
  idle: "Ready",
  listening: "Listening… speak naturally",
  processing: "Thinking…",
  speaking: "Speaking…",
};

function VoiceInterview() {
  const {
    active,
    phase,
    messages,
    error,
    liveLevel,
    interimText,
    fastMode,
    startConversation,
    endConversation,
    clearChat,
  } = useRealtimeVoice();

  const orbScale = 1 + Math.min(liveLevel * 8, 0.45);
  const isLive = phase === "listening" || phase === "processing" || phase === "speaking";

  return (
    <section id="voice-assistant" className="card voice-card">
      <h2>Live Voice Assistant</h2>
      <p className="voice-hint">
        {fastMode
          ? "Fast mode: your browser transcribes speech locally, then the AI replies in ~2–4 seconds."
          : "Live mode: pause briefly after you speak — the AI streams a reply word by word."}
      </p>

      <div className={`voice-live-panel ${isLive ? "is-live" : ""}`}>
        <div
          className={`voice-orb phase-${phase}`}
          style={{ transform: `scale(${active ? orbScale : 1})` }}
          aria-hidden
        />
        <p className="voice-phase-label">{PHASE_LABELS[phase]}</p>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="chat-window">
        {messages.length === 0 && !active && (
          <p className="chat-placeholder">
            Click &quot;Start live conversation&quot;, then ask something like
            &quot;How do I answer why I left my last job?&quot;
          </p>
        )}
        {interimText && phase === "listening" && (
          <div className="chat-bubble user interim">
            <strong>You</strong>
            <p>{interimText}…</p>
          </div>
        )}
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`chat-bubble ${msg.role === "user" ? "user" : "assistant"}`}
          >
            <strong>{msg.role === "user" ? "You" : "AI"}</strong>
            <p>{msg.text}</p>
          </div>
        ))}
        {phase === "processing" && (
          <div className="chat-bubble assistant typing-indicator">
            <strong>AI</strong>
            <p>…</p>
          </div>
        )}
      </div>

      <div className="voice-controls">
        {!active ? (
          <button
            type="button"
            className="btn-primary"
            onClick={startConversation}
          >
            Start live conversation
          </button>
        ) : (
          <button type="button" className="btn-danger" onClick={endConversation}>
            End conversation
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          onClick={clearChat}
          disabled={!messages.length}
        >
          Clear chat
        </button>
      </div>
    </section>
  );
}

export default VoiceInterview;
