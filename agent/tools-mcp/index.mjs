import * as fsSync from "node:fs";
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
// A date the agent passed to a memory tool, or null. Structure only (the agent
// does the reading of "last spring"; Rule #0b) — a malformed value is ignored
// rather than silently matching nothing.
function isoOrNull(s) {
  return isIsoDate(s) ? s : null;
}
// Full-text recall over the raw supervisor event stream (events_fts in the same
// memory-index.db). Complements wiki_search: wiki = curated pages the agent
// chose to write; recall_events = everything that actually happened.
import { searchEvents as recallSearchEvents, searchEventsHybrid as recallSearchEventsHybrid } from "../../lib/event-fts.mjs";
import { searchPagesHybrid, associatePages, searchDaysAssociative } from "../../lib/wiki-embed.mjs";
import { inDateWindow, isIsoDate } from "../../lib/wiki-assoc.mjs";
import { factsForPage } from "../../lib/wiki-facts.mjs";
import { recall as unifiedRecall } from "../../lib/unified-recall.mjs";
import { getReplSandbox } from "../runtime/repl-runner.mjs";
import { localLlmEmbed } from "../../lib/local-llm.mjs";
// WP14 self-wake (Conway-substrate Multiplier 2). The supervisor already drains
// due wakes on a 15s tick and re-dispatches each as a self-message; this is the
// missing half — the model-callable creator. The wake is keyed to the calling
// agent (EDVA_AGENT_ID, set per-agent in the mcp-config; the chat supervisor's
// ticker fires only wakes whose session_id matches its Agent's id, "chat").
import { checkLater } from "../core/check-later.mjs";
import { requestFork, listForks, MAX_INFLIGHT_FORKS } from "../core/fork-queue.mjs";
const AGENT_ID = process.env.EDVA_AGENT_ID || "chat";
// WP11 self-improvement (gated). tools-mcp SERVES owner-approved ext/ modules as
// real tools; the chat agent (only) can PROPOSE new ones — which stay staged and
// inert until the user approves out-of-band via `bin/self-improve`.
import { createApprovalGate } from "../core/approval-gate.mjs";
import { createSelfImprove, analyzeModule } from "../core/self-improve.mjs";
import { createUnifiedApproval } from "../core/self-improve-unified.mjs";
import { createToolRegistry } from "../core/tool-registry.mjs";
import { createPluginLoader } from "../plugins/loader.mjs";
import * as siStore from "../core/message-store.mjs";
import { installRoot, installTools } from "../../lib/root.cjs";

const exec = promisify(execFile);
const BIN = installTools("bin");

// Who this installation serves (lib/instance.cjs): tool descriptions
// name the operator as `OWNER` ("the user" in a fresh install).
const { instance, localConfig, localDir } = require("../../lib/instance.cjs");
const INSTANCE = instance();
const OWNER = INSTANCE.owner_name;
// Wording an installation can set in agent/local/config/tools-mcp.json:
// the examples inside tool descriptions, and the name of the notify tool.
const TEXT = localConfig("tools-mcp", {
  notify_tool: "notify_user",
  delegate_skill_example: "so a planning request follows the matching skill's methodology rather than improvising",
  delegate_shell_examples: "",
  wiki_assoc_hubs: "`travel`, `user_<name>`",
  wiki_assoc_ids: "[\"user_<friend>\",\"restaurant_x\"]",
  wiki_assoc_question: "what else happened when we were with <friend>",
  episode_assoc_question: "which lunch did <friend> come to",
});

async function run(cmd, args = [], opts = {}) {
  try {
    const { env: optsEnv, ...restOpts } = opts;
    const { stdout, stderr } = await exec(cmd, args, {
      timeout: 30000,
      ...restOpts,
      env: {
        ...process.env,
        PATH: `${BIN}:/opt/homebrew/bin:${process.env.PATH}`,
        ...(optsEnv || {}),
      },
    });
    return (stdout || stderr || "Done").trim();
  } catch (err) {
    return `Error: ${err.stderr || err.message}`;
  }
}

// The server's instructions (the tool overview every session reads). An
// installation whose tool set differs keeps its own overview in
// agent/local/prompts/tools-mcp-instructions.md, which replaces this one.
const DEFAULT_INSTRUCTIONS = `Edva's built-in tools. Keep responses short — ${OWNER} is usually on the phone.

## Quick Reference

### Loop primitives
- check_later — one-shot self-wake after N seconds (survives a restart)
- delegate / delegate_status — hand a self-contained research task to a background sub-agent
- repl_run — persistent JS sandbox for bulk read + compute over memory

### Gmail actions
- gmail_label / gmail_mark_read / gmail_label_read / gmail_draft_reply / gmail_labels
  (triage never archives: P3 filing is gmail_label_read — labelled, read, still in the inbox)

### Contacts (Google Contacts via \`gog\`)
- contacts_search / contacts_get / contacts_list

### Email triage memory
- email_mem_add / email_mem_search / email_mem_test

### Context search
- context_search — search across all indexed sources, returns summaries

### Spam filter
- spam_block / spam_list

### Notifications
- ${TEXT.notify_tool} — out-of-band alert to ${OWNER}

### Wiki (long-term context memory)
- recall — ONE fused recall across recent chat + wiki (+ optionally the activity log). Reach for it first.
- wiki_search — paraphrased search for what ${OWNER} IS / PREFERS / DECIDED (profile, feedback rules, projects, references). NOT for what happened on a day — use episode_search
- wiki_read — fetch one page by id (e.g. "user_profile")
- wiki_list — browse by type/status/pinned
- wiki_backlinks — what links to <id>
- wiki_associate — associative recall: what is tied to these pages / this query
- wiki_map — table of contents over memory (what exists to ask for)
- recall_events — full-text search over Edva's own activity stream (dispatches, job outcomes, triage decisions) — "what did I actually do/decide about X?", even if it never became a wiki page

### Daily activities (episodic memory)
- episode_get — narrative for a specific day (YYYY-MM-DD or 'yesterday'/'today')
- episode_search — THE tool for "where/when did we…" about anything that happened; beats wiki_search on episodic recall
- episode_list — list dates with episode files on disk

Tools an installation adds under agent/tools-mcp/_ext/ are listed with the others.
`;
function serverInstructions() {
  try {
    return fsSync.readFileSync(`${localDir()}/prompts/tools-mcp-instructions.md`, "utf8");
  } catch {
    return DEFAULT_INSTRUCTIONS;
  }
}

const mcp = new Server(
  { name: "tools", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: serverInstructions(),
  }
);

const TOOLS = [
  // ── Substrate: self-wake (WP14) ──
  {
    name: "check_later",
    description: "Schedule a one-shot self-wake: after `seconds` (1-3600) you'll be re-sent `note` as a message so you can follow up WITHOUT holding this turn open. Use for short in-conversation deferrals ('re-check that in 5 min', 'circle back on this'). NOT for long-term reminders — those belong on the calendar. The wake persists (survives a restart) and fires once.",
    schema: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "delay in seconds (1-3600; clamped)" },
        note: { type: "string", description: "what to remind yourself to do when it fires" },
      },
      required: ["seconds", "note"],
    },
    run: (a) => {
      const w = checkLater(AGENT_ID, a.seconds, a.note || "");
      if (!w) return "Error: could not schedule self-wake (store unavailable)";
      const mins = w.seconds >= 60 ? ` (~${Math.round(w.seconds / 60)} min)` : "";
      return `Scheduled a self-wake in ${w.seconds}s${mins}: "${a.note || ""}"`;
    },
  },
  // ── Substrate: fork / delegate (WP3) ──
  {
    name: "delegate",
    description:
      "Hand a self-contained research task to a background sub-agent, then END YOUR TURN. It inherits the recent conversation as background, runs on its own (web search available), and its findings come back to you as a message minutes later — you relay them to " + OWNER + " then.\n\n" +
      "Use it when the work would otherwise make " + OWNER + " wait mid-conversation, or would dump a lot of raw material into this conversation: 'compare these four hotels', 'find out what changed in X since June', 'dig up the reviews for these three places'.\n\n" +
      "What it HAS: web search/fetch, and Edva's own skills — " + TEXT.delegate_skill_example + ".\n" +
      "What it LACKS: any shell, file, calendar, wiki, email, home-control or money access. It reads a skill's judgment but cannot execute a skill step that shells out" + (TEXT.delegate_shell_examples ? " " + TEXT.delegate_shell_examples : "") + ", so anything needing live Edva data must come from YOU in the task text, or be done by you afterward. It is deliberately read-only: it exists to digest untrusted web content, which is not something to hand a shell.\n" +
      "Do NOT use it for anything you can answer directly, for anything needing a tool it lacks, or to avoid a short lookup. Tell " + OWNER + " you're looking into it before you end the turn, otherwise the reply lands with no explanation.",
    schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "the task, written so it stands alone — the sub-agent sees only recent conversation as background" },
      },
      required: ["task"],
    },
    run: (a) => {
      const r = requestFork(AGENT_ID, a.task || "");
      if (r.error) return `Could not delegate: ${r.error}`;
      return `Delegated to a background sub-agent (request #${r.id}). It will report back here when done — end your turn now and tell ${OWNER} you're on it. Max ${MAX_INFLIGHT_FORKS} run at once.`;
    },
  },
  {
    name: "delegate_status",
    description: "List this session's background sub-agent tasks (delegate) and their status: queued, running, done, or failed.",
    schema: { type: "object", properties: {} },
    run: () => {
      const rows = listForks(AGENT_ID, { limit: 10 });
      if (!rows.length) return "No background tasks.";
      return rows.map((r) => {
        const when = r.finished_at ? new Date(r.finished_at).toISOString() : new Date(r.created_at).toISOString();
        const tail = r.status === "failed" ? ` — ${r.error || "unknown error"}` : "";
        return `#${r.id} [${r.status}] ${String(r.task).slice(0, 90)}${tail}  (${when})`;
      }).join("\n");
    },
  },

  // ── Gmail Action ──
  {
    name: "gmail_label",
    description: "Add a Gmail label to a message",
    schema: { type: "object", properties: { message_id: { type: "string" }, label: { type: "string" } }, required: ["message_id", "label"] },
    run: (a) => run("node", [`${BIN}/gmail-action`, "label", a.message_id, a.label]),
  },
  // No archive tools here: triage NEVER archives (archiving pulls P3 mail out
  // of the inbox while leaving it UNREAD). P3 = gmail_label_read.
  {
    name: "gmail_mark_read",
    description: "Mark a Gmail message read (refuses a P1 Edva email)",
    schema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] },
    run: (a) => run("node", [`${BIN}/gmail-action`, "mark-read", a.message_id]),
  },
  {
    name: "gmail_label_read",
    description: "P3 filing: add a Gmail label and mark the message read (stays in the inbox — never archive)",
    schema: { type: "object", properties: { message_id: { type: "string" }, label: { type: "string" } }, required: ["message_id", "label"] },
    run: async (a) => {
      const labeled = await run("node", [`${BIN}/gmail-action`, "label", a.message_id, a.label]);
      if (labeled.startsWith("Error:")) return labeled;
      return `${labeled}\n${await run("node", [`${BIN}/gmail-action`, "mark-read", a.message_id])}`;
    },
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
    description: "Search " + OWNER + "'s Google Contacts by name, email, or phone. Use this whenever a phone number or email address is needed for anyone " + OWNER + " knows — Google Contacts is the canonical source. Returns JSON.",
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
    description: "List " + OWNER + "'s Google Contacts (paginated). Use contacts_search when possible — this is for enumeration.",
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
    description: "Block an email sender or topic. Set scam=true for a confirmed scam/phishing/junk sender: its mail then goes straight to Gmail's Spam folder, and message_id (if given) is moved there now. Leave scam off to only silence a real sender " + OWNER + " doesn't want to hear from (marked read, stays in the inbox).",
    schema: { type: "object", properties: { sender: { type: "string" }, topic: { type: "string" }, reason: { type: "string" }, scam: { type: "boolean", description: "Confirmed scam/phishing/junk: move its mail to Gmail's Spam folder" }, message_id: { type: "string", description: "Gmail messageId of the email that prompted the block: moved to Spam if scam, else marked read" } } },
    run: (a) => run("node", [`${BIN}/spam-filter`, "block", ...(a.sender ? ["--sender", a.sender] : []), ...(a.topic ? ["--topic", a.topic] : []), ...(a.reason ? ["--reason", a.reason] : []), ...(a.scam ? ["--scam"] : []), ...(a.message_id ? ["--message", a.message_id] : [])]),
  },
  {
    name: "spam_list",
    description: "List blocked senders and topics",
    schema: { type: "object", properties: {} },
    run: () => run("node", [`${BIN}/spam-filter`, "list"]),
  },

  // ── Notify the user ──
  {
    name: TEXT.notify_tool,
    description: "Push a short message to " + OWNER + "'s phone (the app) via edva-send-curl. Use for things that need their attention now: P1 email alerts, a result they asked to hear about. `chat` (default) is their conversation and passes the outbound precheck; `system` is the silent infrastructure tab. Not for long-form content (email it with email-send and push a one-line pointer).",
    schema: { type: "object", properties: { message: { type: "string", description: "Notification text — keep short, " + OWNER + " reads on phone" }, channel: { type: "string", enum: ["chat", "system"], description: "Default chat" }, intent: { type: "string", description: "Optional topic for the outbound precheck" } }, required: ["message"] },
    run: (a) => run(`${BIN}/edva-send-curl`, [...(a.channel === "system" ? ["--channel", "system"] : []), ...(a.intent ? ["--intent", a.intent] : []), a.message]),
  },

  // ── Wiki (long-term context memory in DB) ──
  // In-process calls into lib/wiki-store.js (no per-call fork). Every
  // call records caller="mcp" in data/wiki-access.jsonl so the nightly
  // wiki-audit pin auditor can distinguish agent hits from ad-hoc CLI use.
  {
    name: "wiki_search",
    description: "Search long-term context memory for what " + OWNER + " IS, PREFERS or DECIDED — profile, feedback rules, projects, references. For anything that HAPPENED on a day (a meal, a stop, an errand) reach for `episode_search` instead: it scopes to day pages and measured 79% hit@5 against this tool's 64% on 14 real episodic questions. Default `fts`: FTS5/BM25 over title + description + body with type-weighted ranking — user/feedback/project rank above reference at equal text match, pinned gets a small boost. `hybrid` additionally fuses semantic KNN (local Ollama nomic-embed-text) with BM25 via RRF — reach for it when the query is paraphrased rather than exact-term (\"where does the user like to eat\" finding a page titled \"restaurant preferences\"); auto-degrades to fts when Ollama is down or nothing is embedded yet. Hybrid also indexes each page through several CUE ANCHORS (its description and section headings) rather than one whole-page vector, so a query about one facet of a many-topic page still finds it — the matched cue comes back as `cue`; Returns page-level hits with a snippet. Use `type` to restrict to one category and skip unrelated reference pages.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query" },
        k: { type: "number", description: "Max results (default 10)" },
        mode: { type: "string", enum: ["fts", "hybrid", "page"], description: "fts = full-text BM25 (default). hybrid = fuse BM25 with semantic KNN via RRF (best for paraphrased recall; degrades to fts if Ollama is down). page = title/description LIKE only." },
        type: { type: "string", enum: ["user", "feedback", "project", "reference", "day"], description: "Restrict to one page type. Big speedup + cleaner results when the category is known." },
        after: { type: "string", description: "YYYY-MM-DD. Hybrid mode only: drop day/week/month pages that end before this date (you work out the date from what " + OWNER + " said; other page types are never date-filtered)." },
        before: { type: "string", description: "YYYY-MM-DD. Hybrid mode only: drop day/week/month pages that start after this date." },
      },
      required: ["query"],
    },
    run: async (a) => {
      const limit = Number.isFinite(a.k) ? a.k : 10;
      const mode = a.mode || "fts";
      const type = a.type || null;
      const results = mode === "hybrid"
        ? await searchPagesHybrid(a.query, { limit, type, embedQuery: (t) => localLlmEmbed(t), after: isoOrNull(a.after), before: isoOrNull(a.before) })
        : ws.searchPages(a.query, { mode, limit, type });
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
    description: "Read a single memory page by id (e.g. 'user_profile' or 'feedback_<rule>'). Returns frontmatter + body + outgoing/incoming links.",
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
      // Typed facts (lib/wiki-facts.mjs): what this page's links MEAN —
      // spouse_of, works_at, avoids — current ones only, each with the page it
      // was read from. Older facts stay queryable with `wiki-assoc facts list
      // <id> --all`.
      const facts = factsForPage(row.id);
      if (facts.length) {
        lines.push("\n=== facts ===");
        for (const f of facts) {
          const obj = f.dst_id ? ` → ${f.dst_id}` : "";
          const when = f.valid_at ? ` (since ${f.valid_at})` : "";
          const src = f.source_page !== row.id ? `  [from ${f.source_page}]` : "";
          lines.push(`  ${f.src_id} ${f.rel}${obj}: ${f.fact_text}${when}${src}`);
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
  {
    name: "wiki_associate",
    description: "Associative recall — \"recall this, and bring up what's tied to it\". Spreads activation out from one or more seed pages (or from the top hits of a query) through the memory graph: wikilinks in BOTH directions (so a person brings up the days that mention them), related/supersedes edges, typed fact edges, pages often recalled together, and day-to-day contiguity (a day brings up the day before and after). Hubs (" + TEXT.wiki_assoc_hubs + ") are automatically damped by how many things link to them, and a page reached from SEVERAL seeds outranks one reached from one, so `ids:" + TEXT.wiki_assoc_ids + "` finds the day both were part of. Each result says how it was reached: `from` (the seed), `via` (the last edge: wikilink, backlink, next_day, prev_day, fact:<relation>, hebbian, related…) and `hops`. Use it after wiki_read/episode_get when the question is about everything connected to something (\"" + TEXT.wiki_assoc_question + "\", \"what do we know around this trip\"), or to find the bridge between two things. `type` scopes the results (type:\"day\" → the days associated with the seeds); `after`/`before` (YYYY-MM-DD, you work out the dates) scope day/week/month pages.",
    schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Seed page ids (equal weight). Several seeds = find what ties them together." },
        query: { type: "string", description: "Seed from this query's top hits instead (or as well); the spread is then also weighted by how much each reached page resembles the query." },
        type: { type: "string", enum: ["user", "feedback", "project", "reference", "day", "week", "month"], description: "Only return pages of this type." },
        after: { type: "string", description: "YYYY-MM-DD: drop day/week/month pages ending before this." },
        before: { type: "string", description: "YYYY-MM-DD: drop day/week/month pages starting after this." },
        method: { type: "string", enum: ["sa", "ppr"], description: "sa = spreading activation (default); ppr = personalized PageRank." },
        k: { type: "number", description: "Max results (default 15)" },
      },
    },
    run: async (a) => {
      const ids = Array.isArray(a.ids) ? a.ids.filter((x) => typeof x === "string") : [];
      if (!ids.length && !a.query) return "wiki_associate: pass `ids` (seed pages) and/or `query`.";
      const out = await associatePages({
        ids,
        query: a.query || null,
        limit: Number.isFinite(a.k) ? a.k : 15,
        type: a.type || null,
        after: isoOrNull(a.after),
        before: isoOrNull(a.before),
        method: a.method === "ppr" ? "ppr" : "sa",
        embedQuery: a.query ? (t) => localLlmEmbed(t) : null,
      });
      ws.logAccess({ tool: "wiki_associate", query: a.query || ids.join(","), page_ids: out.results.map((r) => r.id), caller: "mcp" });
      if (!out.seeds.length) return "wiki_associate: none of the seeds exist (check the ids with wiki_search).";
      return JSON.stringify(out, null, 2);
    },
  },
  {
    name: "wiki_map",
    description: "Table of contents over long-term memory — the navigation tier for a large corpus. Where wiki_search finds pages about a topic, wiki_map shows what IS in memory so you know what you can even ask for (the blind spot of pull-only recall: you won't search for what you can't name). No args → overview: every page type with its count + a few sample titles. `type` → that type's pages as id · title — description; if the type is large it returns a prefix histogram instead so you can drill. `type`+`prefix` → the pages under that id prefix. Cheap and live (never stale). Flow: wiki_map() → wiki_map(type) → wiki_read(id).",
    schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["user", "feedback", "project", "reference", "day", "week", "month"], description: "Drill into one page type. Omit for the overview." },
        prefix: { type: "string", description: "With `type`, restrict to pages whose id starts with this prefix (e.g. 'travel_<city>'). Use the prefixes returned when a type is too large to list." },
      },
    },
    run: async (a) => {
      const map = ws.pageMap({ type: a.type || null, prefix: a.prefix || null });
      ws.logAccess({ tool: "wiki_map", query: a.type || "(overview)", page_ids: [], caller: "mcp" });
      return JSON.stringify(map, null, 2);
    },
  },
  {
    name: "recall",
    description: "ONE recall across everything Edva knows — fuses recent chat (what " + OWNER + " just typed, from the edva_messages semantic index), the curated wiki (hybrid page search), and optionally the activity log — ranked together via RRF. Reach for this FIRST when answering 'what do we know / did " + OWNER + " say / did I decide about X', especially anything recent: a fact stated in chat this morning won't be in the wiki yet, and this is the only surface that sees both. Each result is tagged with its source (chat|wiki|events). Set events:true to also fuse the activity log. Falls back gracefully if a source is unavailable.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to recall" },
        k: { type: "number", description: "Max fused results (default 10)" },
        events: { type: "boolean", description: "Also fuse Edva's own activity log (default false)" },
        chat: { type: "boolean", description: "Include recent chat (default true)" },
        wiki: { type: "boolean", description: "Include the curated wiki (default true)" },
        chatSinceDays: { type: "number", description: "Bound chat recall to the last N days (default 21)" },
      },
      required: ["query"],
    },
    run: async (a) => {
      const out = await unifiedRecall(a.query, {
        k: Number.isFinite(a.k) ? a.k : 10,
        chat: a.chat !== false,
        wiki: a.wiki !== false,
        events: a.events === true,
        chatSinceDays: Number.isFinite(a.chatSinceDays) ? a.chatSinceDays : 21,
      });
      ws.logAccess({
        tool: "recall",
        query: a.query,
        page_ids: out.results.filter((r) => r.source === "wiki").map((r) => r.id),
        caller: "mcp",
      });
      return JSON.stringify(out, null, 2);
    },
  },
  {
    name: "repl_run",
    description: "Run JavaScript in a persistent sandbox to orchestrate bulk READ + COMPUTE + safe memory-maintenance IN CODE — the force multiplier for work a serial tool-caller can't hold. Variables persist across calls (\"buffers outside context\"): fetch a large dataset into a variable, filter/map/reduce it, and return only what matters, so hundreds of rows never flood your context window. In-code bridge: `executeTool(name,args)` and camelCase globals for the READ tools (`wikiSearch`, `wikiRead`, `recall`, `recallEvents`, `episodeSearch`, `wikiMap`, …); SAFE WRITE tools `wikiSave({id,body})` / `wikiSupersede({old_id,new_id})` for bulk memory maintenance (tracked revisions, revertable via `wiki history`, ≤20/run, refuses episodic + pin_locked identity-core pages, NO hard-delete); `sample({messages:[{role,content}], modelId:'haiku'})` to fan out cheap-model sub-tasks in a loop (capped ≤3 concurrent, ≤40/run); `spawn(key,fn)`/`wait(key)`/`bg`; `console.log(...)` (captured). Top-level `await` + persistent vars; a result >20k chars spills to disk (pointer+preview returned). HARD LIMITS by construction: no filesystem/network/process/require, no shell, and NO outbound/financial/browser/delete tools — the only writes are guarded wiki-page edits. Use it for: summarize/cluster N records, cross-reference many pages, classify a batch, dedup/merge across the wiki corpus. Return a value or console.log the answer.",
    schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript to evaluate. Top-level await allowed. Return a value (auto-captured) or console.log the result. Undeclared assignments (x = …) persist across repl_run calls." },
      },
      required: ["code"],
    },
    run: async (a) => {
      const code = String(a.code || "");
      if (!code.trim()) return JSON.stringify({ ok: false, error: "repl_run: empty code" });
      const { sandbox, resetRun } = getReplSandbox(TOOLS);
      resetRun(); // reset the per-run Haiku sample budget
      const res = await sandbox.evaluate(code);
      return JSON.stringify(res, null, 2);
    },
  },
  {
    name: "recall_events",
    description: "Full-text search over Edva's own activity stream — every event the ops/chat supervisors logged (dispatches, job outcomes, triage decisions, digests, errors), not just curated wiki pages. Use this for 'what did I actually do / decide / see about X?' when it may never have been promoted to a memory page. Backed by an FTS5 index (events_fts) over the append-only event log. Complements wiki_search (curated) and episode_search (day narratives).",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query (BM25 over kind + source + event text)" },
        k: { type: "number", description: "Max results (default 20)" },
        mode: { type: "string", enum: ["fts", "hybrid"], description: "fts = lexical BM25 (default, fast, no dependency). hybrid = fuse BM25 with semantic KNN (local Ollama embeddings) via RRF — better for paraphrased 'when did I decide X' recall; auto-falls back to fts if Ollama is down or nothing is embedded." },
        source: { type: "string", description: "Restrict to one dispatch source, e.g. 'daily-summary', 'nightly-review', a 'gmail:<id>' push" },
        kind: { type: "string", description: "Restrict to one event kind, e.g. 'dispatcher.dispatching', 'dispatcher.turn_complete', 'result'" },
        agent: { type: "string", description: "Restrict to one supervisor: 'ops', 'ops-light', 'ops-haiku', 'chat'" },
        since: { type: "string", description: "ISO timestamp — only events at/after this time" },
      },
      required: ["query"],
    },
    run: async (a) => {
      const limit = Number.isFinite(a.k) ? a.k : 20;
      const opts = {
        limit,
        source: a.source || null,
        kind: a.kind || null,
        agent: a.agent || null,
        since: a.since || null,
      };
      const results = a.mode === "hybrid"
        ? await recallSearchEventsHybrid(a.query, { ...opts, embedQuery: (t) => localLlmEmbed(t) })
        : recallSearchEvents(a.query, opts);
      return JSON.stringify({ query: a.query, mode: a.mode || "fts", count: results.length, results }, null, 2);
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
    description: "THE tool for \"where/when did we…\" about something that HAPPENED — a meal, a stop, a walk, an errand, a show you skipped. Prefer it over wiki_search for anything episodic: measured 2026-08-09 over 14 real questions, this scores 79% hit@5 against wiki_search hybrid's 64%, because scoping to type=day stops every other page type competing. FTS5 over `pages_fts` scoped to type=day (same index wiki_search uses, instant after any save), AND-matched then topped up with OR. Use semantic=true only for a paraphrase that shares no words with the page (pgvector + Ollama nomic-embed-text against daily_summaries.embedding) — plain FTS beats it on this corpus. Follow a hit with `wiki_read day_YYYY-MM-DD` for the full narrative.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for" },
        semantic: { type: "boolean", description: "Semantic search via embeddings (default false = FTS5)" },
        limit: { type: "number", description: "Max results (default 8)" },
        after: { type: "string", description: "YYYY-MM-DD: only days on or after this date. You turn \"last spring\" / \"when we were in <city>\" into dates; this applies them." },
        before: { type: "string", description: "YYYY-MM-DD: only days on or before this date." },
        associate: { type: "boolean", description: "Also bring up days ASSOCIATED with the matching ones — days sharing the people, places or trip they link to, and the day before/after — tagged `linked` with the day they were reached from. For questions where the words you have are not the words the day page uses (\"" + TEXT.episode_assoc_question + "\")." },
      },
      required: ["query"],
    },
    run: async (a) => {
      const limit = a.limit || 8;
      if (a.semantic) return runEpisodeSemantic(a.query, limit);
      const after = isoOrNull(a.after);
      const before = isoOrNull(a.before);
      const hits = a.associate
        ? searchDaysAssociative(a.query, { limit, after, before })
        : ws.searchPages(a.query, { mode: "fts", limit: limit * 2, type: "day" })
            .filter((h) => inDateWindow(h.id, after, before));
      ws.logAccess({ tool: "episode_search", page_ids: hits.slice(0, limit).map((h) => h.id), caller: "mcp" });
      if (!hits.length) return "(no results)";
      const lines = [];
      for (const h of hits.slice(0, limit)) {
        const date = h.id.slice(4);
        const snippet = (h.snippet || h.body_md || "").slice(0, 240).replace(/\s+/g, " ");
        const how = h.matched === "linked" ? `  [associated — reached from ${h.expanded_from || "?"} via ${h.via || "link"}]` : "";
        lines.push(`=== ${date} === (${h.id})${how}`);
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

// ─── Installation tools (_ext/) ─────────────────────────────────────────────
// An installation adds its own tools — integrations that depend on its own
// CLIs, devices and accounts — as modules in agent/tools-mcp/_ext/*.mjs.
// Each exports `tools`: an array of entries shaped like the ones above
// ({ name, description, schema, run }), or a function `({ run, exec, BIN, ws })`
// returning one. Optional `after`: the name of a tool (kernel or _ext) the
// module's tools follow in the served list, so the list — part of every
// session's cached prompt prefix — keeps a stable order; without it they are
// appended. A name a kernel tool already has is ignored (the kernel tool wins);
// a module that fails to import is skipped with a log line.
const EXT_TOOLS_DIR = new URL("./_ext/", import.meta.url);
async function loadExtTools() {
  let files;
  try { files = fsSync.readdirSync(EXT_TOOLS_DIR).filter((f) => /\.m?js$/.test(f)).sort(); } // lang-regex-ok: file extension
  catch { return; } // no _ext/ dir: no installation tools
  const groups = [];
  for (const file of files) {
    try {
      const mod = await import(new URL(file, EXT_TOOLS_DIR).href);
      const raw = mod.tools ?? mod.default?.tools ?? mod.default;
      const list = typeof raw === "function" ? await raw({ run, exec, BIN, ws }) : raw;
      if (!Array.isArray(list)) { console.error(`[tools-mcp/_ext] ${file}: no exported 'tools' — skipped`); continue; }
      const tools = [];
      for (const t of list) {
        if (!t?.name || typeof t.run !== "function") { console.error(`[tools-mcp/_ext] ${file}: tool missing name/run — skipped`); continue; }
        if (TOOLS.some((k) => k.name === t.name) || groups.some((g) => g.tools.some((x) => x.name === t.name))) {
          console.error(`[tools-mcp/_ext] ${file}: '${t.name}' is already a tool — ignored`);
          continue;
        }
        tools.push(t);
      }
      groups.push({ file, after: mod.after ?? mod.default?.after ?? null, tools });
    } catch (err) {
      console.error(`[tools-mcp/_ext] ${file}: import failed: ${err.message}`);
    }
  }
  // Place each group after its anchor; a group whose anchor is another
  // group's tool waits until that group is placed. Unplaceable groups append.
  let pending = groups;
  while (pending.length) {
    const next = pending.filter((g) => g.after && !TOOLS.some((t) => t.name === g.after));
    if (next.length === pending.length) break;
    for (const g of pending) {
      if (next.includes(g)) continue;
      const at = g.after ? TOOLS.findIndex((t) => t.name === g.after) + 1 : TOOLS.length;
      TOOLS.splice(at, 0, ...g.tools);
    }
    pending = next;
  }
  for (const g of pending) TOOLS.push(...g.tools);
}
await loadExtTools();

// Helpers for episode_* in-process tools. Dates are in the home time zone.
function homeDateOffset(offsetDays = 0) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: INSTANCE.tz,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date(Date.now() + offsetDays * 86400000));
}

function resolveEpisodeDate(arg) {
  if (!arg) return null;
  if (arg === "today") return homeDateOffset(0);
  if (arg === "yesterday") return homeDateOffset(-1);
  if (arg === "last-week") return null; // handled separately
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  return null;
}

function runLastWeek() {
  const out = [];
  for (let i = 1; i <= 7; i++) {
    const d = homeDateOffset(-i);
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

// ── WP11 self-improvement: serve approved ext/ modules + (chat-only) propose/read ──
const SI_ROOT = installRoot();
const siRegistry = createToolRegistry({ allowlist: [] });
const siLoader = createPluginLoader({ toolRegistry: siRegistry });
const selfImprove = createSelfImprove({
  root: SI_ROOT, approvalGate: createApprovalGate({}), pluginLoader: siLoader,
  store: siStore, exec: (c, a, o) => exec(c, a, o),
});
// UNIFIED approval: a proposed capability creates ONE
// self_improve_approvals row (Supabase) + posts to the "Improvements" channel;
// it is applied only after the user's Face-ID/Enclave signature verifies
// (self-improve-approval-poll). Same flow the nightly executor's HIGH-risk items
// use. Retires the WP11 email/CLI-as-primary path.
const _supaBase = process.env.SUPABASE_URL || (INSTANCE.supabase_project ? `https://${INSTANCE.supabase_project}.supabase.co` : "");
const _supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || (() => { try { return (require("node:fs").readFileSync(installTools(".env"), "utf8").match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m) || [])[1]; } catch { return null; } })();
const _supaH = { apikey: _supaKey, Authorization: "Bearer " + _supaKey, "Content-Type": "application/json" };
const unifiedApproval = createUnifiedApproval({
  store: {
    async insertApproval(r) { await fetch(`${_supaBase}/rest/v1/self_improve_approvals`, { method: "POST", headers: _supaH, body: JSON.stringify(r) }); },
    async updateApproval() {}, async listSignedPending() { return []; }, async getApproval() { return null; },
    // Duplicate guard: same content already a live/skipped/in-flight/applied card → dropped.
    async findByItemHash(h) { const r = await fetch(`${_supaBase}/rest/v1/self_improve_approvals?item_hash=eq.${encodeURIComponent(h)}&select=id,status,skipped,risk,expires_at,expires_at_ms`, { headers: _supaH }); if (!r.ok) throw new Error(`lookup ${r.status}`); return r.json(); },
  },
  deviceKeys: { getKey: async () => null },   // verify/apply live in the poller, not here
  postSuggestion: async (summary, rationale) => { try { await run(`${BIN}/edva-send-curl`, ["--channel", "improvements", "--skip-precheck", `🔧 New capability proposed: ${summary}\n${rationale || ""}\n\nApprove in the app (Face ID) to load it.`]); } catch {} },
  applyItem: async () => ({ ok: false, error: "apply is the poller's job" }),
});
// Serve already-approved ext/ modules as REAL, callable MCP tools.
try {
  const res = await siLoader.loadAll(installTools("agent/ext"));
  // Sorted by name so the tool list — part of every session's cached prompt
  // prefix — is byte-identical across spawns regardless of ext/ readdir or
  // load order (prompt-prefix stability).
  for (const t of [...siRegistry.list()].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    if (TOOLS.some((x) => x.name === t.name)) continue;   // never clobber a core tool
    TOOLS.push({ name: t.name, description: `[self-authored] ${t.description}`, schema: t.schema, run: async (a) => JSON.stringify(await siRegistry.executeTool(t.name, a)) });
  }
  if (res.loaded?.length) console.error(`[tools-mcp] serving approved ext/ module(s): ${res.loaded.join(", ")}`);
  if (res.failed?.length) console.error(`[tools-mcp] ext/ load failures: ${JSON.stringify(res.failed)}`);
} catch (e) { console.error(`[tools-mcp] ext/ load error: ${e.message}`); }

// Only the chat agent may author + propose new modules (never ops/cron/inbound).
if (process.env.EDVA_AGENT_ID === "chat") {
  TOOLS.push(
    {
      name: "read_own_source",
      description: "Read one of Edva's own source files (READ-ONLY; secrets denied). Use to understand your own code before proposing a new capability.",
      schema: { type: "object", properties: { path: { type: "string", description: "repo-relative path" } }, required: ["path"] },
      run: (a) => { const r = selfImprove.readOwnSource(String(a.path || "")); return r.ok ? r.content : `Error: ${r.error}`; },
    },
    {
      name: "propose_module",
      description: "Propose a NEW self-authored capability for yourself — a skill or a read/compute tool — for " + OWNER + " to review + approve. It does NOTHING until they approve it in the app with Face ID; you cannot approve your own module. Anything referencing money, destructive ops, or outbound/network/subprocess is refused. `files` is a map of filename→contents forming a WP5 plugin (manifest.json required; optional index.mjs default-exporting (api)=>{ api.registerTool({...}) }). Give a clear rationale. NOT for something " + OWNER + " asked you to build: that goes to `bin/build-request`, which builds it on Opus (chat-agent CLAUDE.md § Escalation).",
      schema: { type: "object", properties: { name: { type: "string", description: "kebab-case module name" }, files: { type: "object", description: "map filename -> contents; manifest.json required" }, rationale: { type: "string", description: "why this capability is needed" } }, required: ["name", "files"] },
      run: async (a) => {
        const name = String(a.name || ""), files = a.files || {};
        if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(name)) return "Error: module name must be kebab-case [a-z0-9-], 2-49 chars";
        if (!files || typeof files !== "object" || !Object.keys(files).length) return "Error: at least one file (manifest.json) is required";
        const scan = analyzeModule(files);
        if (!scan.ok) return `Refused (safety rails): references money/destructive/outbound. Hits: ${JSON.stringify(scan.hits)}`;
        try {
          const r = await unifiedApproval.requestApproval({ itemType: "new-capability", summary: `New capability: ${name} — ${String(a.rationale || "").slice(0, 100)}`, rationale: String(a.rationale || ""), item: { name, files } });
          if (r.dropped && r.duplicate_of) return `Not proposed — "${name}" with identical files is already a ${r.reason}, so nothing new was sent to your Improvements channel.`;
          if (r.dropped) return `Not proposed — the rationale for "${name}" looked stale or already resolved (${r.reason}), so nothing was sent to your Improvements channel.`;
          return `Proposed "${name}" — sent to your Improvements channel for Face-ID approval (id ${r.id}). It will NOT run until you approve it in the app.`;
        } catch (e) { return `Error: ${e.message}`; }
      },
    },
    {
      name: "self_improve_status",
      description: "List your capability proposals awaiting " + OWNER + "'s Face-ID approval + the ext/ modules already loaded.",
      schema: { type: "object", properties: {} },
      run: async () => {
        let pending = [];
        try { const r = await fetch(`${_supaBase}/rest/v1/self_improve_approvals?status=in.(pending,signed)&select=id,summary,status&order=created_at.desc`, { headers: _supaH }); pending = r.ok ? await r.json() : []; } catch {}
        return JSON.stringify({ pending, loaded: selfImprove.listModules() }, null, 2);
      },
    },
  );
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
