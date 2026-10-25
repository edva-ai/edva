// claude-session-executor.mjs — a Max-compliant Agent executor that drives the
// EXISTING persistent ClaudeSession (supervisor/claude-session.mjs).
//
// This is the bridge that lets the WP0 Agent own its context array + lifecycle
// while the actual model turn runs on the already-Max-authenticated `claude -p`
// session (ANTHROPIC_API_KEY already stripped by the session) — never a raw SDK
// call, never a new spawn. It is how the substrate integrates with a live
// supervisor without violating the Auth Model invariant.
//
// TRANSITIONAL by design: the ClaudeSession runs with `--resume`, so it retains
// its OWN context across turns. Therefore this executor sends only the NEW user
// turn (not the Agent's whole _messages array) and the Agent's _messages act as
// a SHADOW record (feeding the WP4 store, snipping, forks). Full
// context-ownership — the Agent feeding the entire array to a stateless executor
// — is a LATER step, taken only when the supervisor moves off `--resume`. Until
// then this keeps claude -p as the context/execution engine and layers the
// substrate's recording + lifecycle on top.
//
// Executor contract (see core/agent.mjs): ({ userParts, signal }) => { text, usage }.

// Build an executor bound to a live ClaudeSession-like emitter. The session must
// emit "event" per stream-json line (with ev.type) and "result" on turn end, and
// expose send(content) — exactly the ClaudeSession contract. `off`/`removeListener`
// is used to scope listeners per turn (no leak across a long-lived session).
export function makeClaudeSessionExecutor(session, { resultTimeoutMs = 0 } = {}) {
  if (!session || typeof session.send !== "function") {
    throw new Error("makeClaudeSessionExecutor: a ClaudeSession-like emitter with send() is required");
  }
  const off = (ev, fn) => {
    if (typeof session.off === "function") session.off(ev, fn);
    else if (typeof session.removeListener === "function") session.removeListener(ev, fn);
  };

  return function claudeSessionExecutor({ userParts, signal }) {
    return new Promise((resolve) => {
      let text = "";
      let done = false;
      let timer = null;

      const cleanup = () => {
        off("event", onEvent);
        off("result", onResult);
        if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
      };
      const finish = (usage) => {
        if (done) return;
        done = true;
        cleanup();
        resolve({ text: text.trim(), usage });
      };

      // Accumulate assistant text blocks as the turn streams.
      const onEvent = (ev) => {
        if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
          for (const b of ev.message.content) {
            if (b?.type === "text" && typeof b.text === "string") text += b.text;
          }
        }
      };
      const onResult = (ev) => finish(ev?.modelUsage ?? ev?.usage ?? null);
      const onAbort = () => finish(null);   // cancel → resolve with partial text

      session.on("event", onEvent);
      session.once("result", onResult);
      if (signal) {
        if (signal.aborted) return finish(null);
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (resultTimeoutMs > 0) timer = setTimeout(() => finish(null), resultTimeoutMs);

      // Send only the new user turn — the --resume session already holds history.
      const content = (userParts || []).map((p) => (typeof p === "string" ? p : p?.text || "")).filter(Boolean).join("\n");
      try {
        session.send(content);
      } catch (err) {
        finish(null);
      }
    });
  };
}
