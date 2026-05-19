import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
// In-process wiki access — avoids forking `node bin/wiki ...` per call.
// ~50 ms saved per wiki_* invocation, which matters in dense memory-recall
// turns. The `WIKI_LOG_CALLER=mcp` env is no longer needed because we pass
// caller="mcp" explicitly via ws.logAccess.
const ws = require("../../lib/wiki-store.js");

const exec = promisify(execFile);
const MERLIN_HOME = process.env.MERLIN_HOME || `${process.env.HOME}/Dev/merlin`;
const BIN = `${MERLIN_HOME}/bin`;

async function run(cmd, args = [], opts = {}) {
  try {
    const { env: optsEnv, ...restOpts } = opts;
    const { stdout, stderr } = await exec(cmd, args, {
      timeout: 30000,
      ...restOpts,
      env: {
        ...process.env,
        PATH: `${BIN}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}`,
        ...(optsEnv || {}),
      },
    });
    return (stdout || stderr || "Done").trim();
  } catch (err) {
    return `Error: ${err.stderr || err.message}`;
  }
}

const mcp = new Server(
  { name: "tools", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: `Built-in tools for the Merlin agents. Keep responses short — the user is usually on their phone.

This server ships with the kernel substrate (wiki/memory/context/email triage helpers).
Other personal-automation tools (smart home, location, Notes, iMessage, WhatsApp,
Resy, flight tracking, Office docs, Apollo contacts, etc.) were excluded from
the public tree — they depend on host-specific CLIs and API keys that you must
supply yourself. To enable them in your fork, write a binary
that matches the contract in this file, drop it in \`bin/\`, and register a tool
block here.

## Currently shipping

### Memory / Wiki (long-term context — works out of the box)
- wiki_search — paraphrased search across all memory pages
- wiki_read — fetch one page by id (e.g. "user_food_taste")
- wiki_list — browse by type/status/pinned
- wiki_backlinks — which pages link to <id>

### Episodic memory (day/week/month pages from the wiki)
- episode_get — narrative for a specific day (YYYY-MM-DD or 'yesterday'/'today')
- episode_search — text or semantic search across archived days
- episode_list — list dates with episode pages

### Context search (cross-source indexed via bin/context-sync)
- context_search — search across all indexed sources, returns summaries

### Email triage memory (works with bin/email-mem)
- email_mem_add / email_mem_search / email_mem_test

### Notifications
- notify_user — out-of-band alert via Slack DM (placeholder; wire to your channel)

## Requires backend (REGISTERED — wire up the corresponding CLI to use)

### Gmail actions (REQUIRES \`bin/gmail-action\` — supply your own)
- gmail_label / gmail_archive / gmail_label_archive / gmail_draft_reply / gmail_labels

### Spam filter (REQUIRES \`bin/spam-filter\` — supply your own)
- spam_block / spam_list

### Google Contacts (REQUIRES \`gog\` CLI — see docs/dependencies.md § Google Calendar / Tasks / Contacts)
- contacts_search / contacts_get / contacts_list
`,
  }
);

const TOOLS = [
  // ── Gmail Action ── (requires bin/gmail-action — supply your own)
  {
    name: "gmail_label",
    description: "Add a Gmail label to a message",
    schema: { type: "object", properties: { message_id: { type: "string" }, label: { type: "string" } }, required: ["message_id", "label"] },
    run: (a) => run("node", [`${BIN}/gmail-action`, "label", a.message_id, a.label]),
  },
  {
    name: "gmail_archive",
    description: "Archive a Gmail message (remove from inbox)",
    schema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] },
    run: (a) => run("node", [`${BIN}/gmail-action`, "archive", a.message_id]),
  },
  {
    name: "gmail_label_archive",
    description: "Label and archive a Gmail message in one step",
    schema: { type: "object", properties: { message_id: { type: "string" }, label: { type: "string" } }, required: ["message_id", "label"] },
    run: (a) => run("node", [`${BIN}/gmail-action`, "label-archive", a.message_id, a.label]),
  },
  {
    name: "gmail_draft_reply",
    description: "Create a draft reply to a Gmail message",
    schema: { type: "object", properties: { message_id: { type: "string" }, body: { type: "string" } }, required: ["message_id", "body"] },
    run: (a) => run("node", [`${BIN}/gmail-action`, "draft-reply", a.message_id, a.body]),
  },
  {
    name: "gmail_labels",
    description: "List all Gmail labels",
    schema: { type: "object", properties: {} },
    run: () => run("node", [`${BIN}/gmail-action`, "labels"]),
  },

  // ── Google Contacts (source of truth for the user's contacts) ──
  {
    name: "contacts_search",
    description: "Search the user's Google Contacts by name, email, or phone. Use this whenever a phone number or email address is needed for anyone the user knows — Google Contacts is the canonical source. Returns JSON.",
    schema: { type: "object", properties: { query: { type: "string", description: "Name, email, or phone fragment" } }, required: ["query"] },
    run: (a) => run("gog", ["contacts", "search", a.query, "-j"]),
  },
  {
    name: "contacts_get",
    description: "Fetch a specific Google Contacts record by its resourceName (e.g. 'people/c12345'), as returned by contacts_search. Returns JSON.",
    schema: { type: "object", properties: { resource_name: { type: "string" } }, required: ["resource_name"] },
    run: (a) => run("gog", ["contacts", "get", a.resource_name, "-j"]),
  },
  {
    name: "contacts_list",
    description: "List the user's Google Contacts (paginated). Use contacts_search when possible — this is for enumeration.",
    schema: { type: "object", properties: {} },
    run: () => run("gog", ["contacts", "list", "-j"]),
  },

  // ── Email Memory ──
  {
    name: "email_mem_add",
    description: "Add an email classification memory",
    schema: { type: "object", properties: { text: { type: "string" }, tags: { type: "string", description: "Comma-separated tags" } }, required: ["text"] },
    run: (a) => run("node", [`${BIN}/email-mem`, "add", a.text, ...(a.tags ? ["--tags", a.tags] : [])]),
  },
  {
    name: "email_mem_search",
    description: "Search email classification memories",
    schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run: (a) => run("node", [`${BIN}/email-mem`, "search", a.query]),
  },
  {
    name: "email_mem_test",
    description: "Test what memories match an email",
    schema: { type: "object", properties: { from: { type: "string" }, subject: { type: "string" } }, required: ["from", "subject"] },
    run: (a) => run("node", [`${BIN}/email-mem`, "test", "--from", a.from, "--subject", a.subject]),
  },

  // ── Context Search ──
  {
    name: "context_search",
    description: "Search across all indexed sources (Apple Notes, iMessage, email memories, project files). Returns summaries + which tool to call for the full item. Use this BEFORE calling source-specific tools when the user asks about a topic that could span multiple sources.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query" },
        source: { type: "string", enum: ["notes", "imsg", "email", "files", "docs"], description: "Optional: filter to one source" },
      },
      required: ["query"],
    },
    run: (a) => run("node", [`${BIN}/context-search`, a.query, ...(a.source ? ["--source", a.source] : [])]),
  },

  // ── Spam Filter ──
  {
    name: "spam_block",
    description: "Block an email sender or topic",
    schema: { type: "object", properties: { sender: { type: "string" }, topic: { type: "string" }, reason: { type: "string" } } },
    run: (a) => run("node", [`${BIN}/spam-filter`, "block", ...(a.sender ? ["--sender", a.sender] : []), ...(a.topic ? ["--topic", a.topic] : []), ...(a.reason ? ["--reason", a.reason] : [])]),
  },
  {
    name: "spam_list",
    description: "List blocked senders and topics",
    schema: { type: "object", properties: {} },
    run: () => run("node", [`${BIN}/spam-filter`, "list"]),
  },

  // ── Notify user (out-of-band) ──
  {
    name: "notify_user",
    description: "Send an out-of-band notification to the user via Slack DM. Use for P1 email alerts, scheduled task results, and anything that needs attention via a secondary channel. Keep messages short.",
    schema: { type: "object", properties: { message: { type: "string", description: "Notification text — keep short, the user reads on phone" } }, required: ["message"] },
    run: async (a) => {
      // This is a placeholder — the CLI agent should use the Slack connector (mcp__claude_ai_Slack) directly.
      // This tool exists so the agent has a named action for "notify user".
      return `NOTIFY_VIA_SLACK: ${a.message}`;
    },
  },

  // ── iMessage Caller ID ──

  // ── iMessage (read/search/send) ──

  // ── WhatsApp (read/search/send via Desktop automation) ──

  // ── Office Documents (Word & Excel) ──

  // ── Contacts (Apollo + local DB) ──

  // ── Wiki (long-term context memory in DB) ──
  // In-process calls into lib/wiki-store.js (no per-call fork). Every
  // call records caller="mcp" in data/wiki-access.jsonl so the nightly
  // wiki-audit pin auditor can distinguish agent hits from ad-hoc CLI use.
  {
    name: "wiki_search",
    description: "Search long-term context memory pages (user profile, feedback rules, projects, references). FTS5 over title + description + body with type-weighted ranking — user/feedback/project rank above reference at equal text match, pinned gets a small boost. Returns page-level hits with FTS5 snippet showing the matched span. Use `type` to restrict to one category and skip the 400+ travel reference pages.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query" },
        k: { type: "number", description: "Max results (default 10)" },
        mode: { type: "string", enum: ["fts", "page"], description: "fts = full-text BM25 (default); page = title/description LIKE only" },
        type: { type: "string", enum: ["user", "feedback", "project", "reference", "day"], description: "Restrict to one page type. Big speedup + cleaner results when the category is known." },
      },
      required: ["query"],
    },
    run: async (a) => {
      const limit = Number.isFinite(a.k) ? a.k : 10;
      const mode = a.mode || "fts";
      const type = a.type || null;
      const results = ws.searchPages(a.query, { mode, limit, type });
      ws.logAccess({
        tool: "wiki_search",
        query: a.query,
        page_ids: results.map((r) => r.id),
        caller: "mcp",
      });
      return JSON.stringify({ query: a.query, mode, type, results }, null, 2);
    },
  },
  {
    name: "wiki_read",
    description: "Read a single memory page by id (e.g. 'user_food_taste' or 'feedback_no_shorthand'). Returns frontmatter + body + outgoing/incoming links.",
    schema: {
      type: "object",
      properties: { id: { type: "string", description: "Page id (basename without .md)" } },
      required: ["id"],
    },
    run: async (a) => {
      const row = ws.getPage(a.id);
      if (!row) return `read: no page with id ${a.id}`;
      ws.logAccess({ tool: "wiki_read", page_ids: [row.id], caller: "mcp" });
      const lines = [];
      lines.push(`=== ${row.id} (${row.basename}) ===`);
      lines.push(`type        : ${row.type || ""}`);
      lines.push(`status      : ${row.status}${row.pinned ? "  📌 pinned" : ""}`);
      if (row.title) lines.push(`title       : ${row.title}`);
      if (row.description) lines.push(`description : ${row.description}`);
      let scope = [];
      try { scope = JSON.parse(row.scope_json || "[]"); } catch {}
      if (scope.length) lines.push(`scope       : ${scope.join(", ")}`);
      if (row.last_verified_at) lines.push(`verified_at : ${row.last_verified_at}`);
      if (row.confidence) lines.push(`confidence  : ${row.confidence}`);
      if (row.expires_at) lines.push(`expires_at  : ${row.expires_at}`);
      lines.push("");
      lines.push(row.body_md);
      const out = ws.getForwardLinks(row.id);
      const incoming = ws.getBacklinks(row.id);
      if (out.length || incoming.length) {
        lines.push("\n=== links ===");
        if (out.length) {
          const byType = {};
          for (const r of out) (byType[r.link_type] = byType[r.link_type] || []).push(r);
          for (const [t, rows] of Object.entries(byType)) {
            const txt = rows
              .map((r) => (r.display ? `${r.dst_id} (${r.display})` : r.dst_id))
              .join(", ");
            lines.push(`  → ${t.padEnd(12)} ${txt}`);
          }
        }
        if (incoming.length) {
          const byType = {};
          for (const r of incoming) (byType[r.link_type] = byType[r.link_type] || []).push(r);
          for (const [t, rows] of Object.entries(byType)) {
            lines.push(`  ← ${t.padEnd(12)} ${rows.map((r) => r.src_id).join(", ")}`);
          }
        }
      }
      return lines.join("\n");
    },
  },
  {
    name: "wiki_list",
    description: "List memory pages with optional filters. Use to browse by type or to find what's pinned (always-loaded subset).",
    schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["user", "feedback", "project", "reference", "day"] },
        status: { type: "string", enum: ["active", "superseded", "resolved", "historical"] },
        pinned: { type: "boolean", description: "Only the pinned (always-loaded) subset" },
      },
    },
    run: async (a) => {
      const filter = {};
      if (a.type) filter.type = a.type;
      if (a.status) filter.status = a.status;
      if (a.pinned) filter.pinned = true;
      const rows = ws.listPages(filter);
      if (!rows.length) return "(no pages match)";
      const pad = (s, n) => String(s ?? "").padEnd(n);
      const out = rows.map((r) => {
        const flags = [r.pinned ? "📌" : "  ", r.status === "active" ? "  " : "❌"].join("");
        return `${flags}  ${pad(r.type, 10)}  ${pad(r.id, 38)}  ${r.title || ""}`;
      });
      out.push("");
      out.push(`${rows.length} page${rows.length === 1 ? "" : "s"}`);
      return out.join("\n");
    },
  },
  {
    name: "wiki_backlinks",
    description: "Find which memory pages link TO the given page. Useful for understanding what's affected if a memory changes.",
    schema: {
      type: "object",
      properties: { id: { type: "string", description: "Page id (basename without .md)" } },
      required: ["id"],
    },
    run: async (a) => {
      const rows = ws.getBacklinks(a.id);
      ws.logAccess({ tool: "wiki_backlinks", page_ids: [a.id], caller: "mcp" });
      return JSON.stringify(rows, null, 2);
    },
  },

  // ── Episodes (day-page wiki entries) ──
  // Episodic + permanent memory share a single mechanism — the wiki
  // `pages` table — with `type` carrying the distinction (`day`/`week`/
  // `month` vs `user`/`feedback`/`project`/`reference`). All three tools
  // call `wiki-store` directly in-process (same path the `wiki_*` tools
  // took in step 6c) — no `node bin/episode ...` fork per call.
  // ~50 ms per invocation, which matters during dense recall turns.
  // Semantic search keeps its Ollama embed + Supabase pgvector RPC path
  // since FTS5 doesn't cover paraphrased "when did I last X?" lookups.
  {
    name: "episode_get",
    description: "Fetch the day-in-review narrative for a specific date (YYYY-MM-DD, 'yesterday', 'today', or 'last-week'). Reads `day_<date>` from the wiki. Returns frontmatter + narrative including key events, places, photo refs.",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD or one of: yesterday, today, last-week" },
      },
      required: ["date"],
    },
    run: async (a) => {
      const date = resolveEpisodeDate(a.date);
      if (a.date === "last-week") {
        return runLastWeek();
      }
      if (!date) return `episode_get: unrecognized date "${a.date}". Use YYYY-MM-DD, yesterday, today, or last-week.`;
      const page = ws.getPage(`day_${date}`);
      ws.logAccess({ tool: "episode_get", page_ids: [`day_${date}`], caller: "mcp" });
      if (!page) return `no episode for ${date} (no day_${date} in wiki). The daily-summary cron probably didn't run that night.`;
      return page.raw_md;
    },
  },
  {
    name: "episode_search",
    description: "Search day pages. Default mode is FTS5 over `pages_fts` scoped to type=day (same index `wiki_search` uses, instant after any save). Use semantic=true for paraphrased queries (pgvector + Ollama nomic-embed-text against daily_summaries.embedding).",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for" },
        semantic: { type: "boolean", description: "Semantic search via embeddings (default false = FTS5)" },
        limit: { type: "number", description: "Max results (default 8)" },
      },
      required: ["query"],
    },
    run: async (a) => {
      const limit = a.limit || 8;
      if (a.semantic) return runEpisodeSemantic(a.query, limit);
      const hits = ws.searchPages(a.query, { mode: "fts", limit: limit * 2, type: "day" });
      ws.logAccess({ tool: "episode_search", page_ids: hits.slice(0, limit).map((h) => h.id), caller: "mcp" });
      if (!hits.length) return "(no results)";
      const lines = [];
      for (const h of hits.slice(0, limit)) {
        const date = h.id.slice(4);
        const snippet = (h.snippet || h.body_md || "").slice(0, 240).replace(/\s+/g, " ");
        lines.push(`=== ${date} === (${h.id})`);
        lines.push(`  ${snippet}${snippet.length >= 240 ? "…" : ""}`);
      }
      lines.push("");
      lines.push(`${Math.min(hits.length, limit)} day page${hits.length === 1 ? "" : "s"} matched "${a.query}"`);
      return lines.join("\n");
    },
  },
  {
    name: "episode_list",
    description: "List dates that have a day_* wiki page (ascending order).",
    schema: { type: "object", properties: {} },
    run: async () => {
      const all = ws.listPages({ status: "active" });
      const dates = all
        .filter((p) => p.type === "day" && /^day_\d{4}-\d{2}-\d{2}$/.test(p.id))
        .map((p) => p.id.slice(4))
        .sort();
      ws.logAccess({ tool: "episode_list", page_ids: [], caller: "mcp" });
      return dates.length ? dates.join("\n") : "(no episodes)";
    },
  },
];

// Helpers for episode_* in-process tools.
function etDateOffset(offsetDays = 0) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date(Date.now() + offsetDays * 86400000));
}

function resolveEpisodeDate(arg) {
  if (!arg) return null;
  if (arg === "today") return etDateOffset(0);
  if (arg === "yesterday") return etDateOffset(-1);
  if (arg === "last-week") return null; // handled separately
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  return null;
}

function runLastWeek() {
  const out = [];
  for (let i = 1; i <= 7; i++) {
    const d = etDateOffset(-i);
    const page = ws.getPage(`day_${d}`);
    if (page) {
      out.push(page.raw_md);
      out.push("\n\n---\n\n");
    }
  }
  ws.logAccess({ tool: "episode_get", page_ids: ["day_last-week"], caller: "mcp" });
  return out.length ? out.join("") : "(no episodes in last 7 days)";
}

async function runEpisodeSemantic(query, limit) {
  try {
    const { localLlmEmbed } = await import("../../lib/local-llm.mjs");
    const { request } = require("../../lib/supabase-rest.js");
    const embedding = await localLlmEmbed(query);
    const rows = await request(`/rest/v1/rpc/daily_summaries_semantic_search`, {
      method: "POST",
      body: { query_embedding: embedding, match_count: limit },
    });
    if (!rows.length) return "(no results)";
    const lines = [];
    for (const r of rows) {
      const snippet = (r.narrative || "").slice(0, 200).replace(/\n/g, " ");
      lines.push(`=== ${r.date} === (similarity ${r.similarity.toFixed(3)})`);
      lines.push(`  ${snippet}${r.narrative?.length > 200 ? "…" : ""}`);
    }
    lines.push("");
    lines.push(`${rows.length} result${rows.length === 1 ? "" : "s"} (semantic, daily_summaries.embedding)`);
    return lines.join("\n");
  } catch (err) {
    return `episode_search --semantic failed: ${err.message}. Is Ollama running on :11434?`;
  }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.schema,
  })),
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find((t) => t.name === request.params.name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
  }
  const result = await tool.run(request.params.arguments || {});
  return { content: [{ type: "text", text: result }] };
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
