import { join } from "node:path";
import { rmSync } from "node:fs";

export const BUN = Bun.which("bun") ?? process.execPath;
export const TUI_ENTRY = join(process.cwd(), "src/cli/index.ts");

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

export interface TUITestInstance {
  waitForText(text: string, timeoutMs?: number): Promise<void>;
  waitForNoText(text: string, timeoutMs?: number): Promise<void>;
  sendKeys(text: string): void;
  snapshot(): string;
  terminate(): Promise<void>;
}

class BunSpawnBackend implements TUITestInstance {
  private buffer: string = "";
  private proc: any;

  constructor(proc: any) {
    this.proc = proc;
    this.readStream(this.proc.stdout);
    this.readStream(this.proc.stderr);
  }

  private async readStream(stream: ReadableStream<Uint8Array> | null | undefined) {
    if (!stream) return;
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
      }
    } catch {}
  }

  private getBufferText(): string {
    // Basic stripping of ANSI escape sequences
    return this.buffer.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  }

  private matchesText(expected: string): boolean {
    const buffer = this.getBufferText();
    if (buffer.includes(expected)) return true;

    // OpenTUI occasionally reflows or collapses spaces in the captured buffer.
    const compact = (value: string) => value.replace(/\s+/g, "");
    return compact(buffer).includes(compact(expected));
  }

  async waitForText(text: string, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (this.matchesText(text)) return;
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`waitForText: "${text}" not found within ${timeoutMs}ms.\nBuffer:\n${this.getBufferText()}`);
  }

  async waitForNoText(text: string, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (!this.matchesText(text)) return;
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`waitForNoText: "${text}" still present after ${timeoutMs}ms.\nBuffer:\n${this.getBufferText()}`);
  }

  sendKeys(text: string): void {
    if (this.proc.stdin) {
      if (typeof this.proc.stdin.write === "function") {
        this.proc.stdin.write(text);
      } else if (typeof this.proc.stdin.getWriter === "function") {
        const writer = this.proc.stdin.getWriter();
        writer.write(new TextEncoder().encode(text));
        writer.releaseLock();
      }
    }
  }

  snapshot(): string {
    return this.getBufferText();
  }

  async terminate(): Promise<void> {
    try { this.proc.kill(); } catch {}
  }
}

export async function launchTUI(args: string[]): Promise<TUITestInstance> {
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
  };

  const proc = Bun.spawn([BUN, "run", TUI_ENTRY, ...args], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const backend = new BunSpawnBackend(proc);
  // wait for it to run and output something
  await new Promise(r => setTimeout(r, 1000));
  return backend;
}
