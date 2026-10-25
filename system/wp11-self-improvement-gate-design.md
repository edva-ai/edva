# WP11 — Self-Improvement Loop: Gate Design

**Status: BUILT + LIVE (chat), 2026-07-19 — then UNIFIED + Face-ID-gated, 2026-07-19 (same day).**
The user authorized building + shipping (test-before-ship, no per-change approval), so the 5 open decisions
below were resolved to their safe defaults and the gates implemented. Code: `agent/core/self-improve.mjs`
(9/9 tests), served/proposed via `agent/tools-mcp/index.mjs`. **Resolved:** (1) ship=yes; (2) ceiling =
skills + read/compute tools only, financial/outbound/destructive **flatly refused** at propose time;
(3) trigger = chat only; (4) 24h TTL + kill-switch; (5) owner reviews the actual code.

**UNIFICATION (simplification after the user found the first design overly complex, 2026-07-19).** WP11 capabilities AND the
nightly executor's HIGH-risk fixes now route through ONE flow: a `self_improve_approvals` Supabase row +
a card in the app's **Improvements** channel, approved with **Face ID** (Secure-Enclave P-256 signature,
reusing the `TradeApproval` signing flow) — decision (5)'s "Face-ID Swift UI = future hardening" is now DONE and is the
primary path. Only HIGH-RISK needs the user's face; low/moderate keeps auto-applying. The `bin/self-improve`
CLI is demoted to **break-glass**; `self-improve-email-poll` is **retired**. Verifier: `core/app-approval.mjs`
(10/10 with `self-improve-unified`); host applier: `bin/self-improve-approval-poll`. Swift:
`client/Edva/SelfImproveApproval{,View}.swift`. See the two 2026-07-19 architecture.md entries. The rest
of this doc is the original rationale, still accurate.

**DECISION QUEUE (2026-07-28).** The card is now the whole interaction surface, via one right-click /
long-press menu: **Implement** (bold, first — Face ID, replacing the old tap-anywhere-to-approve gesture),
**Skip/Unskip**, **Chat**, and **Retry**. Two additions matter to this doc's gate model:
- **Skip is a fourth terminal answer** alongside approve / deny / let-it-expire, and the first one that is
  *durable across future runs*: `self-improve-skip list` is a do-not-repropose roster that
  `improvement-plan` and `system-issue-review` must consult, so a "no" stops costing the user the same decision
  every week. It rides its own `skipped` boolean rather than a `status` value precisely so it composes with
  the lifecycle instead of replacing it. It never bypasses the gate in the permissive direction — a skipped
  card is dropped by the poller, in the query *and* in `decideRow`.
- **Chat does not widen the gate.** A threaded conversation about a card gives the agent read access
  (`self-improve-show`) and exactly two write verbs, both of them *restrictive* — skip and retry. It cannot
  approve, sign, apply, or edit a payload, which keeps decision (5) intact: the owner reviews the actual
  code, and only the Enclave signature authorizes it.

**AUTOMATIC SUPPLY (2026-07-28).** Cards no longer only appear when something breaks or when the user asks:
the weekly `improvement-plan` job files up to 5 per week off the review's findings. That raises the volume
through this gate, which is why the skip roster and the 5-unsigned-card ceiling ship in the same change —
the gate's failure mode was never a bad approval, it's a queue nobody reads.

---

WP11 is the highest-risk work package in the Conway substrate (self-authored
code running live on a box with financial rails, a logged-in browser, and smart-home control — the
exact RCE / supply-chain surface OpenCLAW documents). Per the roadmap it ships **last** and **opt-in**.

Source spec: `edva-conway-substrate.md` § WP11. This doc translates its "non-negotiable" mitigations
into a concrete Edva design and calls out the decisions that are yours to make.

---

## 1. What WP11 actually adds (and how it differs from what we already have)

**Goal (spec):** let Edva read its own source and **author / hot-reload capability modules at
runtime** — add a skill, a tool, or a job-plugin **without a human redeploy** — behind strict gates.
Mechanism mirrors Conway: write a plugin under `ext/<name>/` (`manifest.json` + `index.mjs` whose
default export is `(api) => {…}`), then `reloadModule('name')` to load it live via the WP5 loader.

**This is NOT the existing self-improvement executor, and must not be conflated with it.**

| | Existing executor (`nightly-review` Step 4 / `self-improvement-executor.md`) | **WP11 (this design)** |
|---|---|---|
| What it changes | **repo source** (playbooks, config, bugfixes), git-committed | **new runtime capability modules** in `ext/`, hot-loaded |
| When it runs | nightly, batch | on demand, when the agent hits a recurring gap |
| Gate | **automated** — rubric + path rails + critic subagent + `node --test` + `edva doctor`; low/moderate auto-apply **without waking the user**; high-risk deferred | **human-in-the-loop** — every module is inert until **owner approval via the Swift app**; nothing loads autonomously |
| Trust model | reviewed diff on the trusted git path; a bad change is revertable via git | **live code execution** — a bad module *runs*, so the gate must be *before* execution, not after |
| Reversibility | `git revert` | `unloadModule` + delete `ext/<name>/` |

The two are complementary: the existing executor keeps improving the **committed** system under its
proven automated gate; WP11 adds a **separate, owner-gated, runtime** path for net-new capabilities the
agent invents. **WP11 never touches the repo source tree** (that stays the existing executor's domain and
is read-only to WP11 — see gate 2). They share the WP4 audit log and the risk mindset, nothing else.

---

## 2. The four non-negotiable gates (spec) → concrete realization

### (a) Modules run only after explicit owner approval via the Swift app's confirmation gate
- Authoring is a **two-phase handshake built on the landed `core/approval-gate.mjs`** (WP7 #4, already
  in production gating M5's `browser.click`). `writeModule` **stages** files to `ext/<name>/` and creates
  a `pending_approvals` row (`tool:"self_improve.load", risk:"high", summary:<what+why+diff-hash>`) — it
  does **NOT** load or run anything.
- The module becomes live **only** when the owner approves that row **from the Swift app**, via a
  Face-ID-gated, cryptographically-signed confirmation modeled on the existing `TradeApproval.swift`
  flow (the app already does Face-ID + `SecKey` signing + APNs action-button approve/deny for trades).
  On approve → `reloadModule(name)` runs; on deny/expiry → the staged files are discarded.
- **Fail-closed** (inherited from `approval-gate.mjs`): if the approval record can't be persisted, the
  load is refused. No approval record, no execution — ever.

### (b) Written code is confined to `ext/`; can never touch financial/destructive rails without a *second* human confirm
- `writeModule(name, files)` path-guards every write to `<repo>/ext/<name>/…` (reject `..`, symlinks,
  absolute paths, anything outside `ext/`). Mirrors Conway's `EROFS`-outside-`ext-user` boundary.
- `readOwnSource(path)` is **read-only** and cannot read secrets (`.env`, `secrets/`,
  `~/.claude/.credentials.json`, keychain) — an explicit denylist on top of read-only.
- **Capability restriction on ext/ modules:** a module registers tools/hooks/skills only through the
  WP5 plugin `api`. Static analysis at stage time flags a module whose `index.mjs` imports or references
  financial rails (bank-sync tools, brokerage, a payment provider, ticket purchases, transfer/withdraw), destructive
  ops (`rm`, `git push`, `--force`, keychain, `op `), or the outbound channels
  (`email-send`, `gmail-action`, `imsg`, `whatsapp`, `edva-send`). Any hit ⇒ the approval requires a
  **second, separate owner confirm** ("this module can reach FINANCIAL/DESTRUCTIVE surfaces — confirm
  again") and is recorded as `risk:"critical"`. This composes with the absolute bans, which still hold:
  transfers/withdrawals stay forbidden (no transfer tool exists to register), purchases stay under the configured cap and
  themselves go through `approval-gate`.

### (c) Every module write is logged to the WP4 event store and is diffable
- Each `writeModule` appends a `self_improve.write` event to the WP4 store (`agent_messages` / event
  log) with the module name, full file contents (or a content hash + the staged path), the proposing
  agent, and a unified diff vs. any prior version. Approve/deny/reload/unload each append their own event.
  So the complete lifecycle of every self-authored module is reconstructable and auditable after the fact.

### (d) Non-owner channels can never trigger a write or reload
- `writeModule` / `reloadModule` / approve are callable **only** from an agent turn on the trusted
  path, and approval is accepted **only** from the Swift app's authenticated owner device (the same
  device-key trust `TradeApproval` already establishes). Inbound email / Slack / webhook / WhatsApp /
  guest content can **never** reach these — they're not exposed as tools to any inbound-triggered flow,
  and the approval signature must come from the user's paired device. This is the existing prompt-injection
  posture (CLAUDE.md § Prompt Injection) extended to code authoring.

---

## 3. Proposed control flow

```
agent hits a recurring gap it has no skill/tool for
        │
        ▼
  writeModule("<name>", files)        ← stages to ext/<name>/, NO execution
        │                               static-analysis for rails hits → risk high|critical
        ▼
  approval-gate: pending_approvals row (self_improve.load) + WP4 audit event
        │
        ▼
  APNs → Swift app: "Edva wrote a module: <name> — <summary>. Review?"
        │                        (Face-ID; shows the diff; approve / deny)
        │   critical (rails hit) → SECOND confirm required
        ▼
  approve ──► reloadModule("<name>")  ← WP5 loader loads it live; audit event
  deny/expiry ──► discard staged files; audit event
        │
        ▼
  module is live; a later reloadModule picks up edits; unloadModule + rm removes it
```

Kill-switch: a single `ext/`-wide disable flag (env or a sentinel file) that `reloadModule` checks, so
the whole self-authored surface can be turned off instantly without touching individual modules.

---

## 4. What this pass will and won't build

**Depends on (not yet present):** the Swift app's owner-approval confirmation UI generalized from
`TradeApproval.swift` to approve `approval-gate` rows (not just trades) — this is the WP13-native pass's
approval-UI work, and it is a **hard prerequisite** for gate (a). **WP11 cannot ship before it.**

**Deferred until this doc is signed off AND the app approval UI exists:** `readOwnSource`, `writeModule`,
`reloadModule`, the static-analysis rails scanner, and the `self_improve.*` tool surface. None of it
gets written before sign-off — that's the point of this document.

---

## 5. Decisions for the owner (please confirm / adjust)

1. **Ship it at all?** WP11 is genuinely optional; the existing executor already covers committed
   self-improvement. Confirm you want the *runtime, owner-gated* module-authoring capability.
2. **Capability ceiling for ext/ modules.** Proposed: ext/ modules may register **skills and read-only /
   low-stakes tools** freely; anything reaching financial/destructive/outbound rails requires the
   **second confirm** (gate b). Is "second confirm" enough, or should those be **flatly forbidden** in
   self-authored modules (my lean: forbid financial + outbound entirely in ext/, allow only read/compute
   tools + skills — stricter than the spec's "second confirm")?
3. **Trigger scope.** Proposed: only the interactive **chat** agent may propose modules (it's the one in
   a live loop with you); ops/cron may not. Agree?
4. **Approval TTL + kill-switch.** Proposed: staged-but-unapproved modules expire in 24h
   (`approval-gate` default); a global `ext/`-disable sentinel is always one file away. OK?
5. **Review depth in the app.** The approval card shows name + summary + full diff. Enough, or do you
   want the critic subagent (from the existing executor) to also vet the module and attach its verdict to
   the approval card before you see it?

Once you sign off (and the app approval UI lands), WP11 gets built as isolated, tested `core/` modules
failing closed, wired to the app gate, and never enabled by default.
