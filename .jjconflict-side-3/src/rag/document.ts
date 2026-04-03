import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import crypto from "node:crypto";
import type { Document, DocumentFormat } from "./types";

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

function detectFormat(content: string, hint?: string): DocumentFormat {
  if (hint) {
    const ext = hint.startsWith(".") ? hint : `.${hint}`;
    if (ext === ".md" || ext === ".mdx") return "markdown";
    if (ext === ".html" || ext === ".htm") return "html";
    if (ext === ".json") return "json";
  }

  const trimmed = content.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // not valid JSON, fall through
    }
  }
  if (trimmed.startsWith("<!") || trimmed.startsWith("<html")) return "html";
  if (/^#{1,6}\s/m.test(trimmed)) return "markdown";

  return "text";
}

// ---------------------------------------------------------------------------
// Document creation
// ---------------------------------------------------------------------------

export type CreateDocumentOptions = {
  id?: string;
  metadata?: Record<string, unknown>;
  format?: DocumentFormat;
};

export function createDocument(
  content: string,
  opts?: CreateDocumentOptions,
): Document {
  const id =
    opts?.id ?? crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  const format = opts?.format ?? detectFormat(content);
  return {
    id,
    content,
    metadata: opts?.metadata,
    format,
  };
}

// ---------------------------------------------------------------------------
// Load from file
// ---------------------------------------------------------------------------

export function loadDocument(path: string): Document {
  const abs = resolve(process.cwd(), path);
  const ext = extname(abs);
  const content = readFileSync(abs, "utf-8");
  const format = detectFormat(content, ext);
  const id = crypto.createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return {
    id,
    content,
    metadata: { source: abs },
    format,
  };
}
