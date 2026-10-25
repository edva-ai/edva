// view-image.mjs — CAP A2. Resolve an image path into a model-ready content
// block.
//
// PURE + LOCAL — reads the file, base64-encodes it, and (for formats Claude
// can't take directly, or oversized images) converts/downsizes with macOS
// `sips`. It makes NO model call and NO API call: the returned block is
// consumed by whichever executor runs the NEXT turn, so this capability is
// Max-invariant by construction (it never itself talks to any model).

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";

const MEDIA = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const CONVERTABLE = new Set([".heic", ".heif", ".tiff", ".tif", ".bmp"]);
const MAX_ONDISK_BYTES = 4 * 1024 * 1024; // downsize above this (base64 ~+33%)
const MAX_DIM = 1568; // Claude's long-edge sweet spot.

const defaultSips = {
  convert(path) {
    const out = `${os.tmpdir()}/viewimg-${Date.now()}.png`;
    execFileSync("sips", ["-s", "format", "png", path, "--out", out], { stdio: "ignore" });
    return out;
  },
  resize(path, dim) {
    const out = `${os.tmpdir()}/viewimg-${Date.now()}-r.png`;
    execFileSync("sips", ["-Z", String(dim), path, "--out", out], { stdio: "ignore" });
    return out;
  },
};

// Resolve `path` to { block, path, media_type, bytes }. `sips` is injectable so
// the convert/resize side-effects can be exercised without a Mac in tests.
export function imageBlock(path, { sips = defaultSips } = {}) {
  let src = path;
  const ext = extname(path).toLowerCase();
  let media_type = MEDIA[ext];
  if (!media_type) {
    if (CONVERTABLE.has(ext)) {
      src = sips.convert(path);
      media_type = "image/png";
    } else {
      media_type = "image/png"; // best-effort default
    }
  }
  try {
    if (statSync(src).size > MAX_ONDISK_BYTES) {
      src = sips.resize(src, MAX_DIM);
    }
  } catch {
    /* stat failure: fall through and let readFile surface the real error */
  }
  const data = readFileSync(src).toString("base64");
  return {
    block: { type: "image", source: { type: "base64", media_type, data } },
    path: src,
    media_type,
    bytes: data.length,
  };
}

export function createViewImageTool({ sips } = {}) {
  return {
    name: "view_image",
    description:
      "Load an image file so it can be seen on the next turn. Returns {path, media_type, bytes} and attaches the pixels. Converts HEIC/TIFF and downsizes large images.",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "absolute image file path" } },
      required: ["path"],
    },
    async handler({ path } = {}) {
      if (!path) return { ok: false, error: "view_image: path required" };
      try {
        const { block, path: resolved, media_type, bytes } = imageBlock(
          path,
          sips ? { sips } : {}
        );
        return { ok: true, path: resolved, media_type, bytes, block };
      } catch (e) {
        return { ok: false, error: `view_image failed: ${e?.message || e}` };
      }
    },
  };
}
