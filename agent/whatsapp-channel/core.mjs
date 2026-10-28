// core.mjs: the whatsapp-channel runner's pure pieces: no socket, no file or
// network I/O, so they are unit-tested without a paired session
// (tests/whatsapp-channel-core.test.mjs). index.mjs wires them to Baileys.

// Which upsert batches the runner logs. Other people's messages arrive as
// "notify". The user's own messages, typed on their phone or another linked
// device, can arrive as "notify" or as "append", so both are accepted for them.
export function acceptUpsert(upsertType, fromMe) {
  if (upsertType === "notify") return true;
  return !!fromMe && upsertType === "append";
}

// Message keys that are session machinery, not something a person wrote. A
// message from the user's own devices made only of these is not logged
// (phones send history-sync notices and key shares this way all day).
const MACHINERY_KEYS = new Set(["messageContextInfo", "protocolMessage", "senderKeyDistributionMessage"]);

export function isOwnMachinery(message) {
  const m = message?.message;
  if (!m) return true;
  return Object.keys(m).every((k) => MACHINERY_KEYS.has(k));
}

// The message's content key. A group message often carries a
// senderKeyDistributionMessage (a key share) beside its real payload; that key
// share names the type only when nothing else is there, so the push filter
// silences true protocol-only messages and not real text riding with a key.
const WRAPPER_KEYS = new Set(["messageContextInfo", "senderKeyDistributionMessage"]);
export function messageType(message) {
  const keys = Object.keys(message?.message || {});
  return keys.find((k) => !WRAPPER_KEYS.has(k))
    || keys.find((k) => k !== "messageContextInfo")
    || "unknown";
}

export function extractText(message) {
  const m = message?.message;
  if (!m) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return `[image]: ${m.imageMessage.caption}`;
  if (m.imageMessage) return "[image]";
  if (m.videoMessage?.caption) return `[video]: ${m.videoMessage.caption}`;
  if (m.videoMessage) return "[video]";
  if (m.audioMessage) return "[voice note]";
  if (m.documentMessage) return `[document: ${m.documentMessage.fileName || "file"}]`;
  if (m.locationMessage) return "[location]";
  if (m.contactMessage) return `[contact: ${m.contactMessage.displayName || ""}]`;
  if (m.stickerMessage) return "[sticker]";
  const types = Object.keys(m).filter((k) => k !== "messageContextInfo");
  return `[${types[0] || "unknown"}]`;
}

// A bounded set of recently seen ids that forgets after ttlMs. Used for the
// ids /send just sent (so their own-device echo is not logged a second time)
// and for own messages already logged (a message can come as notify and append).
export function createRecentIds({ ttlMs = 10 * 60 * 1000, max = 2000, now = () => Date.now() } = {}) {
  const seen = new Map();
  const prune = () => {
    const t = now();
    for (const [id, at] of seen) {
      if (t - at <= ttlMs && seen.size <= max) break;
      seen.delete(id);
    }
  };
  return {
    add(id) {
      if (!id) return;
      seen.delete(id);
      seen.set(id, now());
      prune();
    },
    has(id) {
      if (!id || !seen.has(id)) return false;
      if (now() - seen.get(id) > ttlMs) { seen.delete(id); return false; }
      return true;
    },
    get size() { return seen.size; },
  };
}

// Group metadata, cached in memory. `get` returns the cached value or fetches
// it (fetch failures cache null for a shorter time so a broken group is not
// re-queried on every message). `peek` never fetches; it is what Baileys'
// `cachedGroupMetadata` option and the send path read.
export function createGroupCache({ fetch, ttlMs = 30 * 60 * 1000, failTtlMs = 2 * 60 * 1000, timeoutMs = 5000, now = () => Date.now() } = {}) {
  const store = new Map(); // jid -> { meta, at, ttl }
  const inflight = new Map();
  const fresh = (e) => e && now() - e.at <= e.ttl;
  const withTimeout = (p) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("group metadata timeout")), timeoutMs);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  const cache = {
    peek(jid) {
      const e = store.get(jid);
      return fresh(e) ? e.meta || undefined : undefined;
    },
    set(jid, meta) {
      if (jid && meta) store.set(jid, { meta, at: now(), ttl: ttlMs });
    },
    // Merge a partial update (a subject change) into a cached entry; a group
    // not cached yet is fetched on first use instead.
    update(partial) {
      const id = partial?.id;
      if (!id) return;
      const e = store.get(id);
      if (e?.meta) store.set(id, { meta: { ...e.meta, ...partial }, at: now(), ttl: ttlMs });
      else if (partial.subject && Array.isArray(partial.participants)) cache.set(id, partial);
    },
    invalidate(jid) { store.delete(jid); },
    async get(jid) {
      const e = store.get(jid);
      if (fresh(e)) return e.meta || null;
      if (inflight.has(jid)) return inflight.get(jid);
      const p = (async () => {
        try {
          const meta = await withTimeout(Promise.resolve().then(() => fetch(jid)));
          if (meta) cache.set(jid, meta);
          else store.set(jid, { meta: null, at: now(), ttl: failTtlMs });
          return meta || null;
        } catch {
          store.set(jid, { meta: null, at: now(), ttl: failTtlMs });
          return null;
        } finally {
          inflight.delete(jid);
        }
      })();
      inflight.set(jid, p);
      return p;
    },
  };
  return cache;
}

// The /groups listing: id, subject, participant count, by subject.
export function summarizeGroups(all) {
  return Object.values(all || {})
    .filter((g) => g && g.id)
    .map((g) => ({ id: g.id, subject: g.subject || "", participants: Array.isArray(g.participants) ? g.participants.length : (g.size ?? null) }))
    .sort((a, b) => a.subject.localeCompare(b.subject) || a.id.localeCompare(b.id));
}

// Resolve a group by its subject, the way a person names it: an exact match
// first, then a case-insensitive one. More than one group at the deciding step
// is ambiguous and is refused, never guessed. This is an identifier lookup
// against the group list, not a reading of what anyone meant.
export function resolveGroupBySubject(groups, name) {
  const want = String(name || "").trim();
  if (!want) return { error: "none", candidates: [] };
  const exact = groups.filter((g) => (g.subject || "").trim() === want);
  if (exact.length === 1) return { group: exact[0] };
  if (exact.length > 1) return { error: "ambiguous", candidates: exact };
  const lower = want.toLowerCase();
  const loose = groups.filter((g) => (g.subject || "").trim().toLowerCase() === lower);
  if (loose.length === 1) return { group: loose[0] };
  if (loose.length > 1) return { error: "ambiguous", candidates: loose };
  return { error: "none", candidates: [] };
}
