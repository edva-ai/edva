// context-hooks.mjs — WP10: make the system prompt adaptive per turn.
//
// Conway's HOOK contribution kind + api.on(CONTEXT, ev => ({ systemAppend })).
// After messages are assembled and BEFORE the model call, every registered hook
// runs and its `systemAppend` is concatenated onto the system prompt. Append-only
// (a hook reads ev.messages/ev.system but can't replace them). This is how live
// state — today's calendar, open tasks, on-call, the WP9 skill index —
// reaches the model fresh each turn instead of being baked at session start.
//
// Discipline: hooks are cheap + append-only; a slow or throwing hook must not
// stall or break the turn, so each runs under a timeout and fails OPEN
// (contributes nothing). Pure logic, no I/O of its own.

const DEFAULT_HOOK_TIMEOUT_MS = 250;

export function createContextHookRegistry({ timeoutMs = DEFAULT_HOOK_TIMEOUT_MS } = {}) {
  const hooks = [];   // { name, fn }

  function registerContextHook(fn, { name = null } = {}) {
    if (typeof fn !== "function") throw new Error("registerContextHook: fn must be a function");
    const entry = { name: name || `hook_${hooks.length}`, fn };
    hooks.push(entry);
    return () => {                             // returns an unregister fn
      const i = hooks.indexOf(entry);
      if (i >= 0) hooks.splice(i, 1);
    };
  }

  function count() { return hooks.length; }
  function clear() { hooks.length = 0; }

  // Run all hooks over the turn event; concatenate their systemAppend outputs in
  // registration order. Each hook is bounded by a timeout and fail-open.
  async function runHooks(ev = {}) {
    const appends = [];
    for (const { fn } of hooks) {
      let out;
      try {
        out = await withTimeout(Promise.resolve().then(() => fn(ev)), timeoutMs);
      } catch {
        out = null;                            // fail-open: slow/throwing hook contributes nothing
      }
      const piece = out && typeof out === "object" ? out.systemAppend : null;
      if (typeof piece === "string" && piece.trim()) appends.push(piece.trim());
    }
    return { systemAppend: appends.join("\n\n") };
  }

  // Convenience: produce the full system prompt for a turn = base + hook appends.
  async function assembleSystem(baseSystem, ev = {}) {
    const { systemAppend } = await runHooks({ ...ev, system: baseSystem });
    return systemAppend ? `${baseSystem || ""}\n\n${systemAppend}`.trim() : (baseSystem || "");
  }

  return { registerContextHook, runHooks, assembleSystem, count, clear };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hook timeout")), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
