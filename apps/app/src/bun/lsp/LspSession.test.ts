import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TYPESCRIPT_SERVER } from "./LanguageServers"
import { createLspSession } from "./LspSession"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex")

test.each(["hover", "definition"] as const)("%s keeps the queried digest when a concurrent query syncs an edit", async (method) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-lsp-digest-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const oldText = "export const value = 1\n"
  const newText = 'export const value = "new"\n'
  await writeFile(join(root, "a.ts"), oldText)
  const script = join(root, "server.mjs")
  // Hold the first answer until the second query has observed didChange.
  // Derive both answers from the text/version actually received over stdio.
  await writeFile(script, `
let buffer = Buffer.alloc(0), document, held;
function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");
  process.stdout.write(body);
}
function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") send({ id, result: { capabilities: {} } });
  if (method === "textDocument/didOpen") document = params.textDocument;
  if (method === "textDocument/didChange") {
    document = { ...params.textDocument, text: params.contentChanges[0].text };
  }
  if (method === "textDocument/hover" || method === "textDocument/definition") {
    const result = method === "textDocument/hover" ? { contents: document.text } : [{
      uri: document.uri,
      range: { start: { line: 0, character: document.version - 1 }, end: { line: 0, character: document.version } }
    }];
    if (!held) {
      held = { id, result };
      send({ method: "window/logMessage", params: { type: 1, message: "first query held" } });
    } else {
      send({ id, result });
      send(held);
    }
  }
  if (method === "shutdown") send({ id, result: null });
  if (method === "exit") process.exit(0);
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.indexOf("\\r\\n\\r\\n");
    if (header < 0) return;
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, header).toString())[1]);
    if (buffer.length < header + 4 + length) return;
    const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length));
    buffer = buffer.subarray(header + 4 + length);
    handle(message);
  }
});
`)
  const held = Promise.withResolvers<void>()
  const session = createLspSession({
    repoId: "repo", repoRoot: root, spec: TYPESCRIPT_SERVER,
    argv: [process.execPath, script], env: {}, publish: () => {},
    log: (line) => { if (line.endsWith("first query held")) held.resolve() },
    killGraceMs: 100
  })
  cleanup.push(() => session.shutdown())
  const first = session[method]("a.ts", { line: 1, character: 14 })
  await Promise.race([held.promise, first.then(() => { throw new Error("first query was not held") })])
  await writeFile(join(root, "a.ts"), newText)
  const second = session[method]("a.ts", { line: 1, character: 14 })
  const [oldAnswer, newAnswer] = await Promise.all([first, second])
  if ("hover" in oldAnswer && "hover" in newAnswer) {
    expect(oldAnswer.hover?.contents).toBe(oldText)
    expect(newAnswer.hover?.contents).toBe(newText)
  } else if ("locations" in oldAnswer && "locations" in newAnswer) {
    expect(oldAnswer.locations[0]?.character).toBe(1)
    expect(newAnswer.locations[0]?.character).toBe(2)
  }
  expect(newAnswer.digest).toBe(digestOf(newText))
  expect(oldAnswer.digest).toBe(digestOf(oldText))
}, 20_000)
