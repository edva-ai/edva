// create-image.mjs — CAP A3. Text->image generation.
//
// GATED OFF BY DEFAULT. Anthropic has no image-generation endpoint, so every
// real provider (OpenAI Images, Replicate/Flux, a local Stable Diffusion) is a
// non-Anthropic dependency (a paid key or a local model). Image generation is a
// capability Claude lacks, so the Auth Model allows one once the user wants it
// (docs/agent-auth-model.md § Non-Anthropic models); it is unwired, not
// forbidden. Rather than hardcode one, the
// provider is INJECTED and the tool self-reports "not configured" until a
// provider is deliberately wired. This keeps the capability registered and
// composable (discoverable in the WP1 registry / REPL) without silently
// introducing cost or a new external surface.
//
// Provider contract: async ({ prompt, out, size }) => { path } | { base64 }.

import { writeFileSync } from "node:fs";
import os from "node:os";

export function createCreateImageTool({ provider = null } = {}) {
  return {
    name: "create_image",
    description:
      "Generate an image from a text prompt. Returns {path}. Requires an image provider to be configured; otherwise reports not-configured.",
    schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        out: { type: "string", description: "output file path" },
        size: { type: "string" },
      },
      required: ["prompt"],
    },
    async handler({ prompt, out, size = "1024x1024" } = {}) {
      if (!prompt) return { ok: false, error: "create_image: prompt required" };
      if (typeof provider !== "function") {
        return {
          ok: false,
          error:
            "create_image: no image provider configured (Max-only auth has no Anthropic image path — wire a local/opt-in provider to enable)",
        };
      }
      const target = out || `${os.tmpdir()}/gen-${Date.now()}.png`;
      try {
        const res = await provider({ prompt, out: target, size });
        if (res && res.path) return { ok: true, path: res.path };
        if (res && res.base64) {
          writeFileSync(target, Buffer.from(res.base64, "base64"));
          return { ok: true, path: target };
        }
        return { ok: false, error: "create_image: provider returned no image" };
      } catch (e) {
        return { ok: false, error: `create_image failed: ${e?.message || e}` };
      }
    },
  };
}
