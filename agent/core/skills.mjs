// skills.mjs — WP9: lazy-loaded, self-describing procedures (retire the 90 playbooks).
//
// Conway's SKILL contribution kind: a skill is pure data — a `<name>/SKILL.md`
// with `name` + `description` (+ optional `when_to_use`) frontmatter and a
// markdown body. The model sees ONLY a one-line index of every skill each turn
// (injected via a WP10 context hook); it reads the full body ON DEMAND when a
// task matches. 90 procedures then cost ~90 index lines, not 90 full playbooks —
// the exact context-bloat problem skills solve.
//
// This is the loader + index builder + on-demand body reader. Migrating the
// existing jobs/*.md playbooks into skills/<name>/SKILL.md is incremental and
// out of scope here; the format + machinery are what land.

import fs from "node:fs";
import path from "node:path";

// Parse `---`-fenced YAML-ish frontmatter (name/description/when_to_use) + body.
// Deliberately minimal (matches the wiki's yaml-mini spirit): scalar string
// values only, one per line. Returns { name, description, when_to_use, body }.
export function parseSkill(md, { fallbackName = null } = {}) {
  const text = String(md ?? "");
  let name = fallbackName, description = "", when_to_use = "", body = text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (m) {
    body = m[2];
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      let val = kv[2].trim().replace(/^["']|["']$/g, "");
      if (key === "name") name = val;
      else if (key === "description") description = val;
      else if (key === "when_to_use" || key === "when") when_to_use = val;
    }
  }
  return { name, description, when_to_use, body: body.trim() };
}

export function createSkillRegistry(dir) {
  let skills = [];   // { name, description, when_to_use, dir, path }

  function reload() {
    skills = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return skills; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const skillPath = path.join(dir, ent.name, "SKILL.md");
      let md;
      try { md = fs.readFileSync(skillPath, "utf8"); } catch { continue; }
      const parsed = parseSkill(md, { fallbackName: ent.name });
      skills.push({
        name: parsed.name || ent.name,
        description: parsed.description,
        when_to_use: parsed.when_to_use,
        dir: path.join(dir, ent.name),
        path: skillPath,
      });
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return skills;
  }

  function list() { return skills.map(({ name, description, when_to_use }) => ({ name, description, when_to_use })); }

  // The compact index injected each turn (progressive disclosure): one line per
  // skill, name + description (+ when_to_use hint). Bodies are NOT included.
  function buildIndex({ header = "Skills (read the body with load_skill when the task matches):" } = {}) {
    if (!skills.length) return "";
    const lines = skills.map((s) => {
      const hint = s.when_to_use ? ` — ${s.when_to_use}` : "";
      return `- ${s.name}: ${s.description}${hint}`;
    });
    return `${header}\n${lines.join("\n")}`;
  }

  // Load a skill's full body ON DEMAND (what the model calls when it commits to
  // a procedure). Returns the markdown body, or null if unknown/unreadable.
  function loadBody(name) {
    const s = skills.find((x) => x.name === name);
    if (!s) return null;
    try { return parseSkill(fs.readFileSync(s.path, "utf8"), { fallbackName: name }).body; } catch { return null; }
  }

  function get(name) { return skills.find((x) => x.name === name) || null; }

  reload();
  return { reload, list, buildIndex, loadBody, get, count: () => skills.length };
}
