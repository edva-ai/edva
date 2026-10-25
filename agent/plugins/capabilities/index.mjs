// Capability-tools plugin (CAP / Appendix A) — registers the four capability
// tools into the WP1 registry via the WP5 plugin API. This proves the plugin
// path end-to-end: a whole capability set added with ZERO supervisor edits.
//
// Providers stay at their Max-safe defaults — web_search via a key-stripped
// `claude -p` WebSearch one-shot, view_image via local sips, browser via the
// logged-in Chrome (cdp.py), create_image gated OFF (no Anthropic image path).
// A future host that wants a direct search API or an image provider overrides
// them by calling the capability factories directly instead of via this plugin.

import { createWebSearchTool } from "../../capabilities/web-search.mjs";
import { createViewImageTool } from "../../capabilities/view-image.mjs";
import { createCreateImageTool } from "../../capabilities/create-image.mjs";
import { createBrowserTool } from "../../capabilities/browser.mjs";

export default function capabilitiesPlugin(api) {
  api.registerTool(createWebSearchTool());
  api.registerTool(createViewImageTool());
  api.registerTool(createCreateImageTool());
  api.registerTool(createBrowserTool());
}
