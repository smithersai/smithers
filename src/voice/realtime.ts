/**
 * OpenAI Realtime voice provider.
 *
 * Uses WebSocket to connect to OpenAI's Realtime API for bidirectional
 * audio streaming (speech-to-speech). This is the one capability the
 * Vercel AI SDK does not cover.
 *
 * Reference: .mastra-ref/voice/openai-realtime-api/src/index.ts
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  VoiceProvider,
  SpeakOptions,
  ListenOptions,
  SendOptions,
  VoiceEventType,
  VoiceEventCallback,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_VOICE = "alloy";
const DEFAULT_MODEL = "gpt-4o-mini-realtime-preview-2024-12-17";
const DEFAULT_URL = "wss://api.openai.com/v1/realtime";
const RESPONSE_TIMEOUT_MS = 30_000;
const VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type OpenAIRealtimeVoiceConfig = {
  /** OpenAI API key. Falls back to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Realtime model ID. */
  model?: string;
  /** WebSocket URL override. */
  url?: string;
  /** Default speaker voice. */
  speaker?: string;
  /** Transcription model for input audio. */
  transcriber?: string;
  /** Enable debug logging. */
  debug?: boolean;
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type StreamWithId = PassThrough & { id: string };

type EventMap = Record<string, VoiceEventCallback[]>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOpenAIRealtimeVoice(
  config: OpenAIRealtimeVoiceConfig = {},
): VoiceProvider {
  let ws: import("ws").WebSocket | undefined;
  let state: "open" | "close" = "close";
  const client = new EventEmitter();
  const events: EventMap = {};
  const queue: unknown[] = [];
  const speaker = config.speaker ?? DEFAULT_VOICE;
  const transcriber = config.transcriber ?? "whisper-1";
  const debug = config.debug ?? false;

  // -- helpers --

  function emit(event: string, ...args: any[]): void {
    const cbs = events[event];
    if (!cbs) return;
    for (const cb of cbs) {
      cb(...args);
    }
  }

  function addEventListener(event: string, callback: VoiceEventCallback): void {
    if (!events[event]) {
      events[event] = [];
    }
    events[event]!.push(callback);
  }

  function removeEventListener(
    event: string,
    callback: VoiceEventCallback,
  ): void {
    const cbs = events[event];
    if (!cbs) return;
    const idx = cbs.indexOf(callback);
    if (idx !== -1) cbs.splice(idx, 1);
  }

  function toError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
      return error;
    }
    if (typeof error === "string" && error.length > 0) {
      return new Error(error);
    }
    return new Error(fallbackMessage);
  }

  function sendEvent(type: string, data: any): void {
    const payload = { type, ...data };
    if (!ws || ws.readyState !== ws.OPEN) {
      queue.push(payload);
    } else {
      ws.send(JSON.stringify(payload));
    }
  }

  function int16ToBase64(int16: Int16Array): string {
    const buffer = new ArrayBuffer(int16.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < int16.length; i++) {
      view.setInt16(i * 2, int16[i]!, true);
    }
    const uint8 = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]!);
    }
    return btoa(binary);
  }

  function setupEventListeners(): void {
    const speakerStreams = new Map<string, StreamWithId>();

    if (!ws) throw new Error("WebSocket not initialized");

    function cleanupSpeakerStreams(error?: Error): void {
      for (const stream of speakerStreams.values()) {
        if (error) {
          stream.destroy(error);
        } else {
          stream.end();
        }
      }
      speakerStreams.clear();
    }

    ws.on("message", (message: Buffer | string) => {
      let data: any;
      try {
        data = JSON.parse(message.toString());
      } catch (error) {
        client.emit(
          "error",
          toError(error, "Failed to parse OpenAI realtime WebSocket message"),
        );
        return;
      }
      client.emit(data.type, data);

      if (debug) {
        const { delta, ...fields } = data;
        console.info(data.type, fields, delta?.length < 100 ? delta : "");
      }
    });

    ws.on("close", () => {
      state = "close";
      cleanupSpeakerStreams();
    });

    ws.on("error", (error: Error) => {
      state = "close";
      cleanupSpeakerStreams(error);
      client.emit("error", error);
    });

    client.on("session.created", (ev: any) => {
      emit("session.created", ev);
      const queued = queue.splice(0, queue.length);
      for (const item of queued) {
        ws?.send(JSON.stringify(item));
      }
    });

    client.on("session.updated", (ev: any) => {
      emit("session.updated", ev);
    });

    client.on("response.created", (ev: any) => {
      emit("response.created", ev);
      const stream = new PassThrough() as StreamWithId;
      stream.id = ev.response.id;
      speakerStreams.set(ev.response.id, stream);
      emit("speaker", stream);
    });

    client.on("response.audio.delta", (ev: any) => {
      const audio = Buffer.from(ev.delta, "base64");
      emit("speaking", { audio, response_id: ev.response_id });
      const stream = speakerStreams.get(ev.response_id);
      stream?.write(audio);
    });

    client.on("response.audio.done", (ev: any) => {
      emit("speaking.done", { response_id: ev.response_id });
      const stream = speakerStreams.get(ev.response_id);
      stream?.end();
    });

    client.on("response.audio_transcript.delta", (ev: any) => {
      emit("writing", {
        text: ev.delta,
        response_id: ev.response_id,
        role: "assistant",
      });
    });

    client.on("response.audio_transcript.done", (ev: any) => {
      emit("writing", {
        text: "\n",
        response_id: ev.response_id,
        role: "assistant",
      });
    });

    client.on("response.text.delta", (ev: any) => {
      emit("writing", {
        text: ev.delta,
        response_id: ev.response_id,
        role: "assistant",
      });
    });

    client.on("response.text.done", (ev: any) => {
      emit("writing", {
        text: "\n",
        response_id: ev.response_id,
        role: "assistant",
      });
    });

    client.on("response.done", (ev: any) => {
      emit("response.done", ev);
      speakerStreams.delete(ev.response?.id);
    });

    client.on("error", (ev: any) => {
      emit("error", ev);
    });
  }

  // -- provider --

  const provider: VoiceProvider = {
    name: "openai-realtime",

    async speak(
      input: string | NodeJS.ReadableStream,
      options?: SpeakOptions,
    ): Promise<NodeJS.ReadableStream> {
      let text: string;
      if (typeof input !== "string") {
        const chunks: Buffer[] = [];
        for await (const chunk of input) {
          chunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
          );
        }
        text = Buffer.concat(chunks).toString("utf-8");
      } else {
        text = input;
      }

      if (text.trim().length === 0) {
        throw new Error("Input text is empty");
      }

      // In realtime mode, speak sends a response.create event
      // The audio comes back through the 'speaker' event
      const audioPromise = new Promise<NodeJS.ReadableStream>(
        (resolve, reject) => {
          let timeout: NodeJS.Timeout | undefined;

          const onSpeaker = (stream: NodeJS.ReadableStream) => {
            cleanup();
            resolve(stream);
          };

          const onError = (error: unknown) => {
            cleanup();
            reject(toError(error, "OpenAI realtime speak request failed"));
          };

          const cleanup = () => {
            if (timeout) {
              clearTimeout(timeout);
              timeout = undefined;
            }
            removeEventListener("speaker", onSpeaker);
            removeEventListener("error", onError);
          };

          timeout = setTimeout(() => {
            cleanup();
            const error = new Error(
              `Timed out waiting for realtime speaker response after ${RESPONSE_TIMEOUT_MS}ms`,
            );
            emit("error", error);
            reject(error);
          }, RESPONSE_TIMEOUT_MS);

          addEventListener("speaker", onSpeaker);
          addEventListener("error", onError);
        },
      );

      sendEvent("response.create", {
        response: {
          instructions: `Repeat the following text: ${text}`,
          voice: options?.speaker ?? speaker,
        },
      });

      return audioPromise;
    },

    async listen(
      audioData: NodeJS.ReadableStream,
      _options?: ListenOptions,
    ): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of audioData) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
        chunks.push(buffer);
      }
      const buffer = Buffer.concat(chunks);
      const int16 = new Int16Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / 2,
      );
      const base64Audio = int16ToBase64(int16);

      // Collect the text response
      let responseText = "";
      const textPromise = new Promise<string>((resolve, reject) => {
        let timeout: NodeJS.Timeout | undefined;

        const onWriting = (data: any) => {
          if (data.role !== "assistant") {
            return;
          }
          if (data.text === "\n") {
            cleanup();
            resolve(responseText.trim());
            return;
          }
          responseText += data.text;
        };

        const onError = (error: unknown) => {
          cleanup();
          reject(toError(error, "OpenAI realtime listen request failed"));
        };

        const cleanup = () => {
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          removeEventListener("writing", onWriting);
          removeEventListener("error", onError);
        };

        timeout = setTimeout(() => {
          cleanup();
          const error = new Error(
            `Timed out waiting for realtime transcription after ${RESPONSE_TIMEOUT_MS}ms`,
          );
          emit("error", error);
          reject(error);
        }, RESPONSE_TIMEOUT_MS);

        addEventListener("writing", onWriting);
        addEventListener("error", onError);
      });

      sendEvent("conversation.item.create", {
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_audio", audio: base64Audio }],
        },
      });

      sendEvent("response.create", {
        response: {
          modalities: ["text"],
          instructions: "ONLY repeat the input and DO NOT say anything else",
        },
      });

      return textPromise;
    },

    async send(
      audioData: NodeJS.ReadableStream | Int16Array | Buffer,
      options?: SendOptions,
    ): Promise<void> {
      if (state !== "open") {
        console.warn("Cannot send audio when not connected. Call connect() first.");
        return;
      }

      if (
        typeof (audioData as any)[Symbol.asyncIterator] === "function" ||
        typeof (audioData as any).on === "function"
      ) {
        const stream = audioData as NodeJS.ReadableStream;
        for await (const chunk of stream) {
          try {
            const buffer = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk as any);
            sendEvent("input_audio_buffer.append", {
              audio: buffer.toString("base64"),
              event_id: options?.eventId,
            });
          } catch (err) {
            emit("error", err);
          }
        }
      } else if (audioData instanceof Int16Array) {
        try {
          const base64 = int16ToBase64(audioData);
          sendEvent("input_audio_buffer.append", {
            audio: base64,
            event_id: options?.eventId,
          });
        } catch (err) {
          emit("error", err);
        }
      } else if (Buffer.isBuffer(audioData)) {
        try {
          sendEvent("input_audio_buffer.append", {
            audio: audioData.toString("base64"),
            event_id: options?.eventId,
          });
        } catch (err) {
          emit("error", err);
        }
      }
    },

    async connect(_options?: Record<string, unknown>): Promise<void> {
      // Dynamic import ws to avoid hard dependency for users who don't need realtime
      const { WebSocket } = await import("ws");

      const url = `${config.url ?? DEFAULT_URL}?model=${config.model ?? DEFAULT_MODEL}`;
      const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;

      ws = new WebSocket(url, undefined, {
        headers: {
          Authorization: "Bearer " + apiKey,
          "OpenAI-Beta": "realtime=v1",
        },
      });
      const socket = ws;

      const connectionReady = new Promise<void>((resolve, reject) => {
        let isOpen = false;
        let isSessionCreated = false;

        const cleanup = () => {
          socket.off("open", onOpen);
          socket.off("error", onError);
          client.off("session.created", onSessionCreated);
        };

        const maybeResolve = () => {
          if (!isOpen || !isSessionCreated) {
            return;
          }
          cleanup();
          resolve();
        };

        const onOpen = () => {
          isOpen = true;
          maybeResolve();
        };

        const onSessionCreated = () => {
          isSessionCreated = true;
          maybeResolve();
        };

        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };

        socket.on("open", onOpen);
        socket.on("error", onError);
        client.on("session.created", onSessionCreated);
      });

      setupEventListeners();

      await connectionReady;

      sendEvent("session.update", {
        session: {
          input_audio_transcription: { model: transcriber },
          voice: speaker,
        },
      });

      state = "open";
    },

    close(): void {
      if (!ws) return;
      ws.close();
      state = "close";
    },

    async answer(options?: Record<string, unknown>): Promise<void> {
      sendEvent("response.create", { response: options ?? {} });
    },

    on<E extends VoiceEventType>(event: E, callback: VoiceEventCallback): void {
      addEventListener(event as string, callback);
    },

    off<E extends VoiceEventType>(
      event: E,
      callback: VoiceEventCallback,
    ): void {
      removeEventListener(event as string, callback);
    },

    async getSpeakers(): Promise<
      Array<{ voiceId: string; [key: string]: unknown }>
    > {
      return VOICES.map((v) => ({ voiceId: v }));
    },

    updateConfig(sessionConfig: Record<string, unknown>): void {
      sendEvent("session.update", { session: sessionConfig });
    },
  };

  return provider;
}
