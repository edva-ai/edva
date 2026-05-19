// Local LLM helper — wraps Ollama running on the same host.
// Default model: gemma4:e2b (Gemma 4 effective-2B, multimodal, 128K context).
// Use for quick, low-stakes tasks where the Max/API path would be wasteful
// (short acks, classifications, one-shot rewrites). Long-running or
// high-quality work still belongs on the agents.
//
// Ollama runs at http://127.0.0.1:11434 by default. Install with
// `brew install ollama` and pull the model with `ollama pull gemma4:e2b`
// (~7.2GB). Set OLLAMA_URL or LOCAL_LLM_MODEL env vars to override.
//
// keep_alive defaults to "24h" so the model stays resident across idle
// periods — the phone-channel can go minutes without a message, and we
// don't want to pay cold-start latency on the user's next phone reply.
//
// think: left unset here so Ollama's per-model default wins (Gemma 4 ships
// with thinking on, which is fine — inference is local/free and reasoning
// helps quality). Callers on a tight token budget (e.g. 40-token acks)
// should pass `think: false` explicitly, otherwise the thinking preamble
// eats the whole budget and `content` comes back empty.

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.LOCAL_LLM_MODEL || "gemma4:e2b";

// Gemma 4 recommended sampling (from model card on ollama.com/library/gemma4).
const GEMMA_DEFAULTS = { temperature: 1.0, topP: 0.95, topK: 64 };

export async function localLlmChat({
  system,
  messages,
  user,
  model = DEFAULT_MODEL,
  maxTokens = 200,
  numCtx = 8192,
  temperature = GEMMA_DEFAULTS.temperature,
  topP = GEMMA_DEFAULTS.topP,
  topK = GEMMA_DEFAULTS.topK,
  timeoutMs = 5000,
  keepAlive = "24h",
  think,
} = {}) {
  const chat = [];
  if (system) chat.push({ role: "system", content: system });
  if (messages) chat.push(...messages);
  if (user) chat.push({ role: "user", content: user });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: chat,
        stream: false,
        keep_alive: keepAlive,
        ...(think !== undefined ? { think } : {}),
        options: {
          num_ctx: numCtx,
          num_predict: maxTokens,
          temperature,
          top_p: topP,
          top_k: topK,
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return (json?.message?.content || "").trim();
  } finally {
    clearTimeout(timer);
  }
}

export const LOCAL_LLM_DEFAULT_MODEL = DEFAULT_MODEL;

// Embedding helper — Ollama's /api/embeddings. Default model: nomic-embed-text
// (768 dims), which is fast and good enough for semantic recall over short
// conversational messages. Matches the pgvector column dimension in
// data/migrations/*_merlin_messages_pgvector.sql — keep the two
// in sync if the model changes. Returns a plain Array<number>, or throws.
const EMBED_MODEL = process.env.LOCAL_EMBED_MODEL || "nomic-embed-text";

export async function localLlmEmbed(input, { model = EMBED_MODEL, timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: input }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ollama embeddings ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    if (!Array.isArray(json?.embedding)) {
      throw new Error("ollama embeddings: missing embedding array");
    }
    return json.embedding;
  } finally {
    clearTimeout(timer);
  }
}

export const LOCAL_EMBED_DEFAULT_MODEL = EMBED_MODEL;
