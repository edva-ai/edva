// browser.mjs — CAP A4. Drive Edva's ALREADY-logged-in Chrome (real cookies,
// real sessions) through the existing CDP driver (bin/cdp.py on port
// 9222). Conway drives a headless Chromium; Edva's authenticated profile is
// strictly better, so we wrap it rather than borrow the headless approach.
//
// Discipline (Conway + OpenCLAW): `read` returns a SIMPLIFIED DOM — visible
// text + links + interactive controls — NEVER raw HTML (raw HTML burns tokens
// and adds noise). The CDP runner is INJECTED (`{ cdp }`) so this is fully
// testable without a live Chrome. Max-invariant: driving a browser talks to
// Chrome, never to any model.

import { execFileSync } from "node:child_process";

import { installTools } from "../../lib/root.cjs";
function defaultCdp(args) {
  const bin =
    process.env.CDP_BIN ||
    (process.env.HOME ? installTools("bin/cdp.py") : "cdp.py");
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
}

// Evaluated in-page to extract a simplified DOM: text + links + controls only.
export const SIMPLIFY_DOM_JS = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const links = [...document.querySelectorAll("a[href]")].slice(0, 100)
    .map((a) => ({ text: clean(a.innerText).slice(0, 120), href: a.href }))
    .filter((l) => l.text);
  const controls = [...document.querySelectorAll("button, input, textarea, select, [role=button]")].slice(0, 60)
    .map((el) => ({ tag: el.tagName.toLowerCase(), type: el.type || null, name: el.name || null,
                    label: clean(el.innerText || el.value || el.placeholder || el.getAttribute("aria-label")).slice(0, 80) }))
    .filter((c) => c.label || c.name);
  const text = clean(document.body ? document.body.innerText : "").slice(0, 6000);
  return { title: document.title, url: location.href, text, links, controls };
})()`;

export function createBrowserTool({ cdp = defaultCdp } = {}) {
  return {
    name: "browser",
    description:
      "Drive the logged-in Chrome: navigate, read (simplified DOM: text+links+controls), click, screenshot. Never returns raw HTML.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "read", "click", "screenshot"] },
        url: { type: "string" },
        selector: { type: "string", description: "CSS selector for click" },
        path: { type: "string", description: "output PNG path for screenshot" },
      },
      required: ["action"],
    },
    async handler({ action, url, selector, path } = {}) {
      try {
        switch (action) {
          case "navigate": {
            if (!url) return { ok: false, error: "browser navigate: url required" };
            cdp(["open", url]);
            return { ok: true, action, url };
          }
          case "read": {
            if (url) cdp(["open", url]);
            const raw = cdp(["eval", SIMPLIFY_DOM_JS]);
            let dom;
            try {
              dom = JSON.parse(raw);
            } catch {
              dom = { text: String(raw).slice(0, 6000) };
            }
            return { ok: true, action, ...dom };
          }
          case "click": {
            if (!selector) return { ok: false, error: "browser click: selector required" };
            const js = `(() => { const el = document.querySelector(${JSON.stringify(
              selector
            )}); if (!el) return {clicked:false}; el.click(); return {clicked:true}; })()`;
            const raw = cdp(["eval", js]);
            let r;
            try {
              r = JSON.parse(raw);
            } catch {
              r = {};
            }
            return r.clicked
              ? { ok: true, action, selector }
              : { ok: false, error: `browser click: no element for ${selector}` };
          }
          case "screenshot": {
            const out = path || `${process.env.TMPDIR || "/tmp"}/shot-${Date.now()}.png`;
            cdp(["shot", out]);
            return { ok: true, action, path: out };
          }
          default:
            return { ok: false, error: `browser: unknown action ${action}` };
        }
      } catch (e) {
        return { ok: false, error: `browser ${action} failed: ${e?.message || e}` };
      }
    },
  };
}
