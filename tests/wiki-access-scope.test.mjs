// wiki-access-scope.test.mjs — who may read what, and the default that keeps
// the whole wiki from becoming public because nobody thought about a new page.
//
// The scoping model is DEFAULT DENY. These tests exist to keep it that way;
// the case that matters most is the one asserting an unlisted page is
// invisible. The rules run against a synthetic config here; this install's
// own sharing policy is pinned in wiki-access-scope-local.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { scopeFor, loadScopes } = require("../lib/wiki-access.js");
const { scopeFromConfig, emailQaIdentityFromConfig } = require("../lib/wiki-scope.js");

const OWNER = "owner@example.com";
const PARTNER = "partner@example.com";
const CFG = {
  identities: {
    [OWNER]: { label: "Owner", unrestricted: true },
    [PARTNER]: {
      label: "Partner",
      allow_ids: ["reference_accounts", "user_homes", "reference_door_codes", "reference_wifi"],
      allow_prefixes: ["trip_", "travel_"],
      deny_ids: ["travel_private_note"],
      deny_prefixes: ["travel_medical_"],
      email_qa: true,
      email_deny_ids: ["reference_door_codes", "reference_wifi"],
    },
    "kid@example.com": { label: "Kid", inherits: PARTNER, email_qa: true, email_deny_ids: ["reference_wifi"] },
    "chain@example.com": { label: "Chain", inherits: "kid@example.com" },
  },
};
const scope = (email) => scopeFromConfig(CFG, email);

// wiki-access.js reads its scopes file from WIKI_SHARE_SCOPES_FILE when set, so
// scopeFor() runs on the same synthetic config.
const SCOPES_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-scopes-"));
process.env.WIKI_SHARE_SCOPES_FILE = path.join(SCOPES_TMP, "wiki-share-scopes.json");
fs.writeFileSync(process.env.WIKI_SHARE_SCOPES_FILE, JSON.stringify(CFG));
test.after(() => fs.rmSync(SCOPES_TMP, { recursive: true, force: true }));

test("the owner is unrestricted — including pages that do not exist yet", () => {
  const s = scope(OWNER);
  assert.equal(s.unrestricted, true);
  for (const id of ["reference_accounts", "user_health_notes", "day_2026-08-09", "something_invented_next_year"]) {
    assert.ok(s.canRead(id), `owner should read ${id}`);
  }
});

test("a scoped viewer reads explicit ids and allowed prefixes", () => {
  const s = scope(PARTNER);
  assert.equal(s.unrestricted, false);
  for (const id of ["reference_accounts", "user_homes", "trip_plan_example", "travel_stay_northport"]) {
    assert.ok(s.canRead(id), `partner should read ${id}`);
  }
});

test("a scoped viewer does NOT read health, episodes, people or operational pages", () => {
  const s = scope(PARTNER);
  for (const id of ["user_owner", "day_2026-08-09", "week_2026-08-03", "project_example", "feedback_health_analysis"]) {
    assert.equal(s.canRead(id), false, `partner must NOT read ${id}`);
  }
});

test("inherits gives another identity's rules under its own label, one level only", () => {
  const partner = scope(PARTNER);
  const kid = scope("kid@example.com");
  assert.equal(kid.known, true);
  assert.equal(kid.unrestricted, false);
  assert.equal(kid.label, "Kid");
  for (const id of ["reference_accounts", "trip_plan_x", "reference_wifi", "user_owner", "day_2026-08-09"]) {
    assert.equal(kid.canRead(id), partner.canRead(id), id);
  }
  const chain = scope("chain@example.com");
  assert.equal(chain.known, false, "an inherited entry that itself inherits is no access");
  assert.equal(chain.canRead("reference_accounts"), false);
});

test("an unlisted page is invisible — default deny, not default allow", () => {
  // The load-bearing one. A pattern-based ALLOW would leak whatever gets named
  // in an unanticipated way; this asserts the opposite posture.
  const s = scope(PARTNER);
  assert.equal(s.canRead("reference_something_nobody_has_written_yet"), false);
  assert.equal(s.canRead(""), false);
  assert.equal(s.canRead(null), false);
  assert.equal(s.canRead(undefined), false);
});

test("an authenticated but unlisted identity gets nothing", () => {
  for (const s of [scope("someone.else@example.com"), scopeFor("someone.else@example.com")]) {
    assert.equal(s.known, false);
    assert.equal(s.unrestricted, false);
    assert.equal(s.canRead("reference_accounts"), false);
  }
});

test("deny beats allow, so a carve-out can be reversed", () => {
  const s = scope(PARTNER);
  assert.equal(s.canRead("travel_private_note"), false, "deny_ids wins over an allowed prefix");
  assert.equal(s.canRead("travel_medical_kit"), false, "deny_prefixes wins over an allowed prefix");
  assert.equal(s.canRead("travel_packing_list"), true);
  assert.equal(typeof s.canRead, "function");
});

test("email matching is case-insensitive", () => {
  assert.equal(scope("Owner@Example.COM").unrestricted, true);
  assert.equal(scope("Partner@EXAMPLE.com").known, true);
});

test("scopeFor reads the configured scopes file", () => {
  assert.deepEqual(loadScopes(), CFG);
  assert.equal(scopeFor(OWNER).unrestricted, true);
  assert.equal(scopeFor(PARTNER).canRead("trip_plan_example"), true);
  assert.equal(scopeFor(PARTNER).canRead("user_owner"), false);
  assert.equal(scopeFor("kid@example.com").label, "Kid");
});

test("email Q&A: the site scope minus the email-denied pages", () => {
  const kid = emailQaIdentityFromConfig(CFG, "Kid@example.com");
  assert.equal(kid.label, "Kid");
  assert.equal(kid.canRead("user_owner"), false); // outside the shared scope
  assert.equal(kid.canRead("reference_accounts"), true);
  assert.equal(kid.canRead("reference_wifi"), false); // credentials never go out by email
  assert.equal(kid.canRead("reference_door_codes"), true, "email_deny_ids are the identity's own, not inherited");
  assert.equal(emailQaIdentityFromConfig(CFG, PARTNER).canRead("reference_door_codes"), false);
  assert.equal(emailQaIdentityFromConfig(CFG, OWNER), null); // full assistant, not this path
  assert.equal(emailQaIdentityFromConfig(CFG, "chain@example.com"), null);
  assert.equal(emailQaIdentityFromConfig(CFG, "stranger@example.com"), null);
});
