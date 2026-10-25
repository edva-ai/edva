// wiki-scope.js — who may read which wiki page, from wiki-share-scopes.json.
//
// Pure (no fs, no Node APIs) so the host's `wiki serve` (via wiki-access.js)
// and the Cloudflare Worker behind the wiki hostname (wiki-worker/) apply
// the SAME rules. The worker gets the config from Supabase `wiki_config`
// (key 'share_scopes'), which wiki-cloud-sync keeps equal to the repo file.

"use strict";

/**
 * Resolve an email to what it may read.
 *
 * Returns `{ label, unrestricted, canRead(id) }`. An email with no entry gets a
 * scope that permits nothing — Access should never let one through, but the
 * origin does not assume that.
 */
function scopeFromConfig(scopes, email) {
  const id = String(email || "").toLowerCase();
  let entry = scopes.identities && scopes.identities[id];
  // "inherits": another identity's rules, under this identity's own label —
  // so a family scope is ONE list, not copies that drift apart. One level only;
  // an inherited entry that itself inherits is treated as no access.
  if (entry && entry.inherits) {
    const base = scopes.identities[String(entry.inherits).toLowerCase()];
    entry = base && !base.inherits ? { ...base, label: entry.label || base.label } : null;
  }

  if (!entry) {
    return { label: id || "unknown", unrestricted: false, known: false, canRead: () => false };
  }
  if (entry.unrestricted) {
    return { label: entry.label || id, unrestricted: true, known: true, canRead: () => true };
  }

  const allowIds = new Set(entry.allow_ids || []);
  const allowPrefixes = entry.allow_prefixes || [];
  const denyIds = new Set(entry.deny_ids || []);
  const denyPrefixes = entry.deny_prefixes || [];

  return {
    label: entry.label || id,
    unrestricted: false,
    known: true,
    // Deny wins, then explicit allow, then prefix allow. Anything unmatched is
    // denied — the default that makes a forgotten page safe rather than public.
    canRead(pageId) {
      const pid = String(pageId || "");
      if (!pid) return false;
      if (denyIds.has(pid)) return false;
      if (denyPrefixes.some((d) => pid.startsWith(d))) return false;
      if (allowIds.has(pid)) return true;
      return allowPrefixes.some((a) => pid.startsWith(a));
    },
  };
}

/**
 * May this sender email Edva for read-only answers (an installation's scoped
 * email Q&A responder)? Requires `"email_qa": true` on the identity. Returns the pages it may draw on
 * by email: its site scope minus `email_deny_ids` (passwords/codes — those go
 * through 1Password, never email). The owner has no `email_qa` and uses the
 * full assistant instead.
 */
function emailQaIdentityFromConfig(scopes, email) {
  const id = String(email || "").toLowerCase();
  const entry = scopes.identities && scopes.identities[id];
  if (!entry || !entry.email_qa) return null;
  const scope = scopeFromConfig(scopes, id);
  if (!scope.known) return null;
  const deny = new Set(entry.email_deny_ids || []);
  return {
    email: id,
    label: scope.label,
    unrestricted: scope.unrestricted,
    canRead: (pageId) => !deny.has(String(pageId || "")) && scope.canRead(pageId),
  };
}

module.exports = { scopeFromConfig, emailQaIdentityFromConfig };
