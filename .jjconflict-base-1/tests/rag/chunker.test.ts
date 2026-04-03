import { describe, expect, test } from "bun:test";
import { chunk } from "../../src/rag/chunker";
import { createDocument } from "../../src/rag/document";

function doc(content: string) {
  return createDocument(content, { id: "test-doc" });
}

describe("chunk", () => {
  describe("recursive strategy", () => {
    test("splits on paragraph boundaries", () => {
      const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
      const chunks = chunk(doc(text), {
        strategy: "recursive",
        size: 30,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]!.content).toContain("Paragraph one");
    });

    test("falls back to newlines when paragraphs are too large", () => {
      const text = "Line one\nLine two\nLine three\nLine four\nLine five";
      const chunks = chunk(doc(text), {
        strategy: "recursive",
        size: 25,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    test("respects overlap", () => {
      const text = "A ".repeat(100) + "\n\n" + "B ".repeat(100);
      const chunks = chunk(doc(text), {
        strategy: "recursive",
        size: 150,
        overlap: 50,
      });
      // With overlap, adjacent chunks should share some content
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    test("produces chunks with correct structure", () => {
      const text = "Hello world.\n\nGoodbye world.";
      const chunks = chunk(doc(text), {
        strategy: "recursive",
        size: 500,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0]!.id).toBeString();
      expect(chunks[0]!.documentId).toBe("test-doc");
      expect(chunks[0]!.index).toBe(0);
    });

    test("handles empty document", () => {
      const chunks = chunk(doc(""), {
        strategy: "recursive",
        size: 100,
        overlap: 0,
      });
      expect(chunks.length).toBe(0);
    });
  });

  describe("character strategy", () => {
    test("splits on default separator (double newline)", () => {
      const text = "Part one.\n\nPart two.\n\nPart three.";
      const chunks = chunk(doc(text), {
        strategy: "character",
        size: 20,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    test("splits on custom separator", () => {
      const text = "apple|banana|cherry|date";
      const chunks = chunk(doc(text), {
        strategy: "character",
        size: 20,
        overlap: 0,
        separator: "|",
      });
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("sentence strategy", () => {
    test("splits on sentence boundaries", () => {
      const text = "First sentence. Second sentence. Third sentence. Fourth sentence.";
      const chunks = chunk(doc(text), {
        strategy: "sentence",
        size: 40,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    test("keeps whole sentences together", () => {
      const text = "Short. Another short. A third one.";
      const chunks = chunk(doc(text), {
        strategy: "sentence",
        size: 100,
        overlap: 0,
      });
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.content).toContain("Short");
    });

    test("handles sentences ending with different punctuation", () => {
      const text = "Question? Exclamation! Statement. Another one.";
      const chunks = chunk(doc(text), {
        strategy: "sentence",
        size: 30,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("markdown strategy", () => {
    test("splits on headers", () => {
      const text = "# Title\n\nIntro paragraph.\n\n## Section One\n\nContent one.\n\n## Section Two\n\nContent two.";
      const chunks = chunk(doc(text), {
        strategy: "markdown",
        size: 50,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    test("handles code blocks", () => {
      const text = "# Title\n\nSome text.\n\n```ts\nconst x = 1;\n```\n\nMore text.";
      const chunks = chunk(doc(text), {
        strategy: "markdown",
        size: 500,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("token strategy", () => {
    test("splits by approximate token count", () => {
      const text = "word ".repeat(500);
      const chunks = chunk(doc(text), {
        strategy: "token",
        size: 50,
        overlap: 10,
      });
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    test("handles short text that fits in one chunk", () => {
      const text = "Short text.";
      const chunks = chunk(doc(text), {
        strategy: "token",
        size: 100,
        overlap: 0,
      });
      expect(chunks.length).toBe(1);
    });
  });

  describe("validation", () => {
    test("throws when overlap >= size", () => {
      expect(() =>
        chunk(doc("text"), { strategy: "recursive", size: 100, overlap: 100 }),
      ).toThrow("overlap");
    });

    test("throws for unknown strategy", () => {
      expect(() =>
        chunk(doc("text"), { strategy: "unknown" as any, size: 100, overlap: 0 }),
      ).toThrow("Unknown chunk strategy");
    });
  });

  describe("chunk metadata", () => {
    test("assigns sequential indices", () => {
      const text = "A\n\nB\n\nC\n\nD\n\nE";
      const chunks = chunk(doc(text), {
        strategy: "recursive",
        size: 5,
        overlap: 0,
      });
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i]!.index).toBe(i);
      }
    });

    test("carries document metadata to chunks", () => {
      const d = createDocument("Hello.\n\nWorld.", {
        id: "test",
        metadata: { source: "test-file" },
      });
      const chunks = chunk(d, { strategy: "recursive", size: 500, overlap: 0 });
      expect(chunks[0]!.metadata?.source).toBe("test-file");
    });
  });
});
