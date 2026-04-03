import { describe, expect, test } from "bun:test";
import { createDocument, loadDocument } from "../../src/rag/document";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("createDocument", () => {
  test("creates a document with auto-detected text format", () => {
    const doc = createDocument("Hello world");
    expect(doc.id).toBeString();
    expect(doc.content).toBe("Hello world");
    expect(doc.format).toBe("text");
  });

  test("detects markdown format from content", () => {
    const doc = createDocument("# Heading\n\nParagraph text");
    expect(doc.format).toBe("markdown");
  });

  test("detects JSON format from content", () => {
    const doc = createDocument('{"key": "value"}');
    expect(doc.format).toBe("json");
  });

  test("detects HTML format from content", () => {
    const doc = createDocument("<!DOCTYPE html><html><body>Hello</body></html>");
    expect(doc.format).toBe("html");
  });

  test("accepts custom id", () => {
    const doc = createDocument("content", { id: "custom-id" });
    expect(doc.id).toBe("custom-id");
  });

  test("accepts metadata", () => {
    const doc = createDocument("content", { metadata: { source: "test" } });
    expect(doc.metadata).toEqual({ source: "test" });
  });

  test("accepts explicit format override", () => {
    const doc = createDocument("plain text", { format: "markdown" });
    expect(doc.format).toBe("markdown");
  });

  test("generates deterministic id from content", () => {
    const doc1 = createDocument("same content");
    const doc2 = createDocument("same content");
    expect(doc1.id).toBe(doc2.id);
  });

  test("generates different ids for different content", () => {
    const doc1 = createDocument("content one");
    const doc2 = createDocument("content two");
    expect(doc1.id).not.toBe(doc2.id);
  });
});

describe("loadDocument", () => {
  const tmpDir = join(import.meta.dir, ".tmp-doc-test");

  test("loads a text file", () => {
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "test.txt");
    writeFileSync(filePath, "Hello from file");
    try {
      const doc = loadDocument(filePath);
      expect(doc.content).toBe("Hello from file");
      expect(doc.format).toBe("text");
      expect(doc.metadata?.source).toBe(filePath);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loads a markdown file", () => {
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "test.md");
    writeFileSync(filePath, "# Title\n\nContent here");
    try {
      const doc = loadDocument(filePath);
      expect(doc.content).toBe("# Title\n\nContent here");
      expect(doc.format).toBe("markdown");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loads a JSON file", () => {
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, "test.json");
    writeFileSync(filePath, '{"key": "value"}');
    try {
      const doc = loadDocument(filePath);
      expect(doc.format).toBe("json");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("throws for missing file", () => {
    expect(() => loadDocument("/nonexistent/file.txt")).toThrow();
  });
});
