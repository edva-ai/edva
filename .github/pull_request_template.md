<!--
  Keep the PR description short. The mandatory checks below are about
  intent — the CI does the mechanical scanning. Your job here is to
  confirm you thought about it.
-->

## What this PR does

<!-- One paragraph. -->

## Public-content review

Merlin is the public kernel; personal/identity-coupled content belongs in
the operator's private overlay (see
[`docs/architecture-public-private.md`](../docs/architecture-public-private.md)).
Confirm the following before requesting review:

- [ ] No personal names, addresses, businesses, project codenames, or
  account-specific identifiers appear in any added/modified file. Things
  the pre-commit `sanitize-guard` cannot catch (paraphrased descriptions,
  specific dollar amounts, dated events) were reviewed manually.
- [ ] Any new external integration is referenced by *class* (e.g.
  "Supabase project" via `SUPABASE_URL` env) rather than by *instance*
  (e.g. a specific project ref).
- [ ] If `.tools/sanitize-guard-baseline.json` changed, the new accepted
  hits are listed in the section below with a one-line rationale per hit.
- [ ] CLAUDE.md changes apply universally to anyone running Merlin (no
  rules that only make sense for a specific household, business, or
  property — those go in the overlay's `local/CLAUDE.md`).

## Baseline changes (if any)

<!--
  If .tools/sanitize-guard-baseline.json grew, list each new accepted
  pattern hit and why it's intentional public content. Empty if no change.

  Example:
    - `README.md` — `domain_silo` for marketing URL silo.co/merlin (kept)
    - `SECURITY.md` — `owner_handle` for the public repo URL (kept)
-->

## Related

<!-- Issue/PR refs, architecture doc sections, etc. -->
