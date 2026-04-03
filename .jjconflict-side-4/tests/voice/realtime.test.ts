import { describe, expect, test, mock } from "bun:test";
import { createOpenAIRealtimeVoice } from "../../src/voice/realtime";

describe("voice: openai-realtime", () => {
  test("creates a provider with correct name", () => {
    const provider = createOpenAIRealtimeVoice();
    expect(provider.name).toBe("openai-realtime");
  });

  test("has all required methods", () => {
    const provider = createOpenAIRealtimeVoice();
    expect(typeof provider.speak).toBe("function");
    expect(typeof provider.listen).toBe("function");
    expect(typeof provider.send).toBe("function");
    expect(typeof provider.connect).toBe("function");
    expect(typeof provider.close).toBe("function");
    expect(typeof provider.answer).toBe("function");
    expect(typeof provider.on).toBe("function");
    expect(typeof provider.off).toBe("function");
    expect(typeof provider.getSpeakers).toBe("function");
    expect(typeof provider.updateConfig).toBe("function");
  });

  test("getSpeakers returns available voices", async () => {
    const provider = createOpenAIRealtimeVoice();
    const speakers = await provider.getSpeakers!();
    expect(speakers.length).toBeGreaterThan(0);
    const voiceIds = speakers.map((s) => s.voiceId);
    expect(voiceIds).toContain("alloy");
    expect(voiceIds).toContain("echo");
    expect(voiceIds).toContain("shimmer");
  });

  test("on/off manage event listeners", () => {
    const provider = createOpenAIRealtimeVoice();
    const events: any[] = [];
    const cb = (...args: any[]) => events.push(args);

    provider.on!("speaking", cb);
    provider.off!("speaking", cb);
    // No error thrown
    expect(true).toBe(true);
  });

  test("close does not throw when not connected", () => {
    const provider = createOpenAIRealtimeVoice();
    // Should not throw
    provider.close!();
    expect(true).toBe(true);
  });

  test("send warns when not connected", async () => {
    const provider = createOpenAIRealtimeVoice();
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warns.push(msg);
    try {
      await provider.send!(Buffer.from("audio"));
      expect(warns.some((w) => w.includes("not connected"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test("speak rejects with empty text", async () => {
    const provider = createOpenAIRealtimeVoice();
    await expect(provider.speak!("   ")).rejects.toThrow(/empty/i);
  });

  test("config accepts custom options", () => {
    const provider = createOpenAIRealtimeVoice({
      apiKey: "sk-test",
      model: "gpt-4o-realtime",
      url: "wss://custom.api/realtime",
      speaker: "echo",
      transcriber: "whisper-1",
      debug: true,
    });
    expect(provider.name).toBe("openai-realtime");
  });
});
