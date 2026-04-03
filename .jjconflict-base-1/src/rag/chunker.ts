import crypto from "node:crypto";
import type { Document, Chunk, ChunkOptions } from "./types";

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

const DEFAULT_SIZE = 1000;
const DEFAULT_OVERLAP = 200;

// ---------------------------------------------------------------------------
// Internal: merge splits with overlap (shared by recursive & character)
// ---------------------------------------------------------------------------

function mergeSplits(
  splits: string[],
  separator: string,
  maxSize: number,
  overlap: number,
): string[] {
  const docs: string[] = [];
  let current: string[] = [];
  let total = 0;

  for (const piece of splits) {
    const len = piece.length;
    const sepLen = current.length > 0 ? separator.length : 0;

    if (total + len + sepLen > maxSize && current.length > 0) {
      const doc = current.join(separator).trim();
      if (doc) docs.push(doc);

      // keep overlap content from the end
      if (overlap > 0) {
        const overlapPieces: string[] = [];
        let overlapSize = 0;
        for (let i = current.length - 1; i >= 0; i--) {
          const p = current[i]!;
          if (overlapSize + p.length > overlap) break;
          overlapPieces.unshift(p);
          overlapSize += p.length + (overlapPieces.length > 1 ? separator.length : 0);
        }
        current = overlapPieces;
        total = overlapSize;
      } else {
        current = [];
        total = 0;
      }
    }

    current.push(piece);
    total += len + (current.length > 1 ? separator.length : 0);
  }

  if (current.length > 0) {
    const doc = current.join(separator).trim();
    if (doc) docs.push(doc);
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Strategy: recursive
// ---------------------------------------------------------------------------

function splitRecursive(
  text: string,
  separators: string[],
  maxSize: number,
  overlap: number,
): string[] {
  const finalChunks: string[] = [];

  let separator = separators[separators.length - 1] ?? "";
  let remaining: string[] = [];

  for (let i = 0; i < separators.length; i++) {
    const s = separators[i]!;
    if (s === "") {
      separator = s;
      break;
    }
    if (text.includes(s)) {
      separator = s;
      remaining = separators.slice(i + 1);
      break;
    }
  }

  const splits = separator
    ? text.split(separator).filter((s) => s !== "")
    : text.split("");

  const good: string[] = [];

  for (const s of splits) {
    if (s.length < maxSize) {
      good.push(s);
    } else {
      if (good.length > 0) {
        finalChunks.push(...mergeSplits(good, separator, maxSize, overlap));
        good.length = 0;
      }
      if (remaining.length === 0) {
        finalChunks.push(s);
      } else {
        finalChunks.push(...splitRecursive(s, remaining, maxSize, overlap));
      }
    }
  }

  if (good.length > 0) {
    finalChunks.push(...mergeSplits(good, separator, maxSize, overlap));
  }

  return finalChunks;
}

function chunkRecursive(text: string, size: number, overlap: number): string[] {
  const separators = ["\n\n", "\n", " ", ""];
  return splitRecursive(text, separators, size, overlap);
}

// ---------------------------------------------------------------------------
// Strategy: character
// ---------------------------------------------------------------------------

function chunkCharacter(
  text: string,
  size: number,
  overlap: number,
  separator?: string,
): string[] {
  const sep = separator ?? "\n\n";
  const splits = text.split(sep).filter((s) => s !== "");
  return mergeSplits(splits, sep, size, overlap);
}

// ---------------------------------------------------------------------------
// Strategy: sentence
// ---------------------------------------------------------------------------

function detectSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";
  const enders = [".", "!", "?"];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    current += ch;
    if (enders.includes(ch)) {
      const rest = text.slice(i + 1);
      // Real sentence boundary: followed by whitespace then uppercase, or end of text
      if (!rest.trim() || /^\s+[A-Z]/.test(rest)) {
        sentences.push(current.trim());
        current = "";
      }
    }
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences.filter((s) => s.length > 0);
}

function chunkSentence(text: string, size: number, overlap: number): string[] {
  const sentences = detectSentences(text);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentSize = 0;

  for (const sentence of sentences) {
    const sepLen = current.length > 0 ? 1 : 0; // space separator
    if (currentSize + sentence.length + sepLen > size && current.length > 0) {
      chunks.push(current.join(" "));

      // overlap: keep trailing sentences
      if (overlap > 0) {
        const overlapSentences: string[] = [];
        let oSize = 0;
        for (let i = current.length - 1; i >= 0; i--) {
          const s = current[i]!;
          if (oSize + s.length > overlap) break;
          overlapSentences.unshift(s);
          oSize += s.length + (overlapSentences.length > 1 ? 1 : 0);
        }
        current = overlapSentences;
        currentSize = oSize;
      } else {
        current = [];
        currentSize = 0;
      }
    }
    current.push(sentence);
    currentSize += sentence.length + sepLen;
  }

  if (current.length > 0) {
    chunks.push(current.join(" "));
  }

  return chunks.filter((c) => c.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Strategy: markdown
// ---------------------------------------------------------------------------

function chunkMarkdown(text: string, size: number, overlap: number): string[] {
  const separators = [
    "\n## ",
    "\n### ",
    "\n#### ",
    "\n##### ",
    "\n###### ",
    "\n# ",
    "```\n",
    "\n\n",
    "\n",
    " ",
    "",
  ];
  return splitRecursive(text, separators, size, overlap);
}

// ---------------------------------------------------------------------------
// Strategy: token (approximate)
// ---------------------------------------------------------------------------

function chunkToken(text: string, size: number, overlap: number): string[] {
  // Approximate: ~4 chars per token for English text
  const charsPerToken = 4;
  const charSize = size * charsPerToken;
  const charOverlap = overlap * charsPerToken;
  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    const end = Math.min(pos + charSize, text.length);
    const chunkText = text.slice(pos, end).trim();
    if (chunkText) chunks.push(chunkText);
    if (end >= text.length) break;
    pos += Math.max(1, charSize - charOverlap);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function chunk(document: Document, options?: ChunkOptions): Chunk[] {
  const strategy = options?.strategy ?? "recursive";
  const size = options?.size ?? DEFAULT_SIZE;
  const overlap = options?.overlap ?? DEFAULT_OVERLAP;

  if (overlap >= size) {
    throw new Error(
      `Chunk overlap (${overlap}) must be less than chunk size (${size})`,
    );
  }

  let pieces: string[];
  switch (strategy) {
    case "recursive":
      pieces = chunkRecursive(document.content, size, overlap);
      break;
    case "character":
      pieces = chunkCharacter(document.content, size, overlap, options?.separator);
      break;
    case "sentence":
      pieces = chunkSentence(document.content, size, overlap);
      break;
    case "markdown":
      pieces = chunkMarkdown(document.content, size, overlap);
      break;
    case "token":
      pieces = chunkToken(document.content, size, overlap);
      break;
    default:
      throw new Error(`Unknown chunk strategy: ${strategy}`);
  }

  return pieces.map((content, index) => ({
    id: crypto
      .createHash("sha256")
      .update(`${document.id}:${index}`)
      .digest("hex")
      .slice(0, 16),
    documentId: document.id,
    content,
    index,
    metadata: document.metadata ? { ...document.metadata } : undefined,
  }));
}
