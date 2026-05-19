"use strict";
// mime-types.js — tiny MIME type lookup for email attachments.
// Shared between gmail-action and email-send.

const path = require("node:path");

const MIME_TYPES = {
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".html": "text/html",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function guessMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

module.exports = { MIME_TYPES, guessMimeType };
