#!/usr/bin/env node
// A deterministic agent that speaks the Agent Client Protocol (ACP) on stdio: one JSON-RPC 2.0 message per line.
// It does what its prompt's instruction lines say, in order, so tests of an ACP client or a runner see a real
// process, real streams and real file edits with no model. Dependency-free on purpose.
//
// Instructions, one per line of the prompt's text (other lines are ignored):
//   add the line `X` to `FILE`      appends X and a newline to FILE, relative to the session's cwd
//   run `sleep N`                   a tool call that waits N seconds; session/cancel ends it (stop reason cancelled)
//   run `busy N`                    a tool call that keeps a child process busy on the CPU for N seconds and says
//                                   nothing meanwhile, as a quiet build or test run does; session/cancel ends it
//   run `sleep N` detached          a tool call that starts `sleep N` in a session of its own and waits for it; a
//                                   cancel ends the turn but leaves the sleep running, as some agents' tools do
//   run `sleep N` through a helper  a tool call whose helper waits 2 s, then starts `sleep N` in a session of its own
//                                   and waits for it, so the command starts under a process already running; a cancel
//                                   kills the helper and ends the turn, orphaning the sleep, as one agent's adapter does.
//                                   The sleep's pid goes to `orphan-<uuid>.pid` in the state directory
//   refuse                          ends the turn with stop reason refusal
//   exit                            the process exits with code 3 in the middle of the turn
//   leak X                          sends X back as message text (for scrubbing tests)
//   say env NAME                    sends the value of environment variable NAME as message text
//   late update                     sends one more message a second after the turn ends
//   talk for N seconds              sends a message chunk every 250 ms for N seconds, as a long answer streams
//   say N KiB                       sends one message chunk of N KiB of text
//   fail the prompt                 answers the prompt with JSON-RPC error -32000, as a missing login does
//   ask permission [KIND,...]       asks session/request_permission with options of those kinds (allow_once and
//                                   reject_once unless named) and says which option the client chose
//   read a file                     asks the client fs/read_text_file and says the error code it got
//   say garbage                     writes a line that isn't JSON, an update that isn't one, a response to nothing
//                                   and an unknown notification, then goes on
//   answer badly                    answers the prompt with a stop reason the protocol doesn't have
//
// Each session's pending instructions live in a state file under ACP_TEST_AGENT_STATE (the OS temp directory
// unless set), never in its cwd. A prompt whose text has a line `continue` (case-insensitive) carries on with the
// session's pending instructions, so a run killed mid-turn and resumed with session/load then "continue" applies
// every instruction once. ACP_TEST_AGENT_MODE=bad-initialize answers initialize with no protocol version;
// ACP_TEST_AGENT_NO_LOAD=1 says it can't load sessions. It serves `_session/steering` (advertised as
// `_meta.steering.supported`, as two coding agents' adapters do): the steer's instruction lines join the turn in
// flight after its current step, which then says `Steered.`; with no turn in flight it answers `idle`. Each steer it
// takes appends a line to `steered.log` in the state directory.
// ACP_TEST_AGENT_NO_STEER=1 advertises no steering and answers the method not found. The agent writes its pid to `agent-<pid>.pid` in the state
// directory, and a detached sleep's pid to `detached-<pid>.pid`, so tests can check what is still running.
//
// As the published adapters do, each turn first echoes its prompt as a `user_message_chunk`, and session/load replays
// every update the session sent before (kept in `<session>.history.jsonl` in the state directory) before it answers.

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const stateDir = process.env.ACP_TEST_AGENT_STATE || join(tmpdir(), "acp-test-agent")
mkdirSync(stateDir, { recursive: true })
const stateFile = (sessionId) => join(stateDir, `${sessionId}.json`)
writeFileSync(join(stateDir, `agent-${process.pid}.pid`), String(process.pid))

const readState = (sessionId) =>
  existsSync(stateFile(sessionId)) ? JSON.parse(readFileSync(stateFile(sessionId), "utf8")) : undefined
const writeState = (state) => {
  const file = stateFile(state.sessionId)
  writeFileSync(`${file}.tmp`, JSON.stringify(state))
  renameSync(`${file}.tmp`, file)
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const historyFile = (sessionId) => join(stateDir, `${sessionId}.history.jsonl`)
const update = (sessionId, value) => {
  send({ method: "session/update", params: { sessionId, update: value } })
  appendFileSync(historyFile(sessionId), `${JSON.stringify(value)}\n`)
}
const say = (sessionId, text) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } })

let nextRequest = 1000
const waiting = new Map()
const ask = (method, params) =>
  new Promise((resolveAnswer) => {
    const id = nextRequest++
    waiting.set(id, resolveAnswer)
    send({ id, method, params })
  })

const PATTERNS = [
  [/^add the line `([^`]*)` to `([^`]+)`$/, (m) => ({ kind: "add", text: m[1], file: m[2] })],
  [/^run `sleep (\d+(?:\.\d+)?)`$/, (m) => ({ kind: "sleep", seconds: Number(m[1]) })],
  [/^run `busy (\d+(?:\.\d+)?)`$/, (m) => ({ kind: "busy", seconds: Number(m[1]) })],
  [/^run `sleep (\d+)` detached$/, (m) => ({ kind: "detached", seconds: Number(m[1]) })],
  [/^run `sleep (\d+)` through a helper$/, (m) => ({ kind: "helper", seconds: Number(m[1]) })],
  [/^say env ([A-Za-z_][A-Za-z0-9_]*)$/, (m) => ({ kind: "env", name: m[1] })],
  [/^late update$/, () => ({ kind: "late" })],
  [/^talk for (\d+(?:\.\d+)?) seconds$/, (m) => ({ kind: "talk", seconds: Number(m[1]) })],
  [/^say (\d+) KiB$/, (m) => ({ kind: "big", kib: Number(m[1]) })],
  [/^fail the prompt$/, () => ({ kind: "fail" })],
  [/^refuse$/, () => ({ kind: "refuse" })],
  [/^exit$/, () => ({ kind: "exit" })],
  [/^leak (.+)$/, (m) => ({ kind: "leak", text: m[1] })],
  [/^ask permission(?: ([a-z_,]+))?$/, (m) => ({ kind: "permission", kinds: m[1] ? m[1].split(",") : undefined })],
  [/^read a file$/, () => ({ kind: "read" })],
  [/^say garbage$/, () => ({ kind: "garbage" })],
  [/^answer badly$/, () => ({ kind: "badly" })]
]

const instructionsOf = (text) =>
  text.split("\n").map((line) => line.trim()).flatMap((line) => {
    for (const [pattern, make] of PATTERNS) {
      const match = pattern.exec(line)
      if (match !== null) return [make(match)]
    }
    return []
  })

const textOf = (prompt) =>
  (Array.isArray(prompt) ? prompt : []).filter((block) => block.type === "text").map((block) => block.text).join("\n")

// The turn in progress, per session: how to cancel it, and its state, which a steer adds instructions to.
const turns = new Map()

const runTurn = async (id, sessionId, text) => {
  const state = readState(sessionId)
  if (state === undefined) return send({ id, error: { code: -32002, message: "Unknown session" } })
  if (!/^continue$/im.test(text)) {
    state.pending = [...state.pending, ...instructionsOf(text)]
    writeState(state)
  }
  let cancelled = false
  let late = false
  let wake = () => {}
  turns.set(sessionId, {
    cancel: () => {
      cancelled = true
      wake()
    },
    steer: (instructions) => {
      state.pending = [...state.pending, { kind: "steered" }, ...instructions]
      writeState(state)
    }
  })
  const end = (stopReason) => {
    turns.delete(sessionId)
    update(sessionId, { sessionUpdate: "usage_update", used: 1234, size: 200000, cost: { amount: 0, currency: "USD" } })
    send({ id, result: { stopReason } })
    if (late) setTimeout(() => say(sessionId, "Late note."), 1000)
  }
  update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } })
  say(sessionId, `Working through ${state.pending.length} instructions.`)
  while (state.pending.length > 0) {
    if (cancelled) return end("cancelled")
    const step = state.pending[0]
    if (step.kind === "add") {
      const toolCallId = randomUUID()
      update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Edit a file", kind: "edit", status: "in_progress" })
      const path = resolve(state.cwd, step.file)
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${step.text}\n`)
      state.pending.shift()
      writeState(state)
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" })
      continue
    }
    if (step.kind === "sleep") {
      const toolCallId = randomUUID()
      update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Run a command", kind: "execute", status: "in_progress" })
      await new Promise((done) => {
        const timer = setTimeout(done, step.seconds * 1000)
        wake = () => {
          clearTimeout(timer)
          done()
        }
      })
      if (cancelled) {
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" })
        return end("cancelled")
      }
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" })
      state.pending.shift()
      writeState(state)
      continue
    }
    if (step.kind === "talk") {
      const until = Date.now() + step.seconds * 1000
      let n = 0
      while (Date.now() < until && !cancelled) {
        say(sessionId, `word ${n++} `)
        await new Promise((done) => setTimeout(done, 250))
      }
      state.pending.shift()
      writeState(state)
      continue
    }
    if (step.kind === "helper") {
      const toolCallId = randomUUID()
      update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Run a command", kind: "execute", status: "in_progress" })
      // The helper starts the command in a session of its own 2 s in, once the helper itself has been running.
      const file = join(stateDir, `orphan-${randomUUID()}.pid`)
      const helper = spawn(process.execPath, [
        "-e",
        `setTimeout(() => { const c = require("node:child_process").spawn("sleep", [${JSON.stringify(String(step.seconds))}], ` +
        `{ detached: true, stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(file)}, String(c.pid)); ` +
        `c.on("exit", () => process.exit(0)) }, 2000); setInterval(() => {}, 1000)`
      ], { stdio: "ignore" })
      const exited = new Promise((done) => helper.on("exit", done))
      await Promise.race([exited, new Promise((done) => (wake = done))])
      if (cancelled) {
        // The helper goes; the command it started is left to whoever finds it.
        helper.kill("SIGKILL")
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" })
        return end("cancelled")
      }
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" })
      state.pending.shift()
      writeState(state)
      continue
    }
    if (step.kind === "busy") {
      const toolCallId = randomUUID()
      update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Run a command", kind: "execute", status: "in_progress" })
      const child = spawn(process.execPath, ["-e", `const end = Date.now() + ${step.seconds * 1000}; while (Date.now() < end) {}`], {
        stdio: "ignore"
      })
      const exited = new Promise((done) => child.on("exit", done))
      await Promise.race([exited, new Promise((done) => (wake = done))])
      if (cancelled) {
        child.kill("SIGKILL")
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" })
        return end("cancelled")
      }
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" })
      state.pending.shift()
      writeState(state)
      continue
    }
    if (step.kind === "detached") {
      const toolCallId = randomUUID()
      update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Run a command", kind: "execute", status: "in_progress" })
      const child = spawn("sleep", [String(step.seconds)], { detached: true, stdio: "ignore" })
      writeFileSync(join(stateDir, `detached-${child.pid}.pid`), String(child.pid))
      // The cancel ends the turn, but nothing here stops the command.
      const exited = new Promise((done) => child.on("exit", done))
      await Promise.race([exited, new Promise((done) => (wake = done))])
      if (cancelled) {
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" })
        return end("cancelled")
      }
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" })
      state.pending.shift()
      writeState(state)
      continue
    }
    state.pending.shift()
    writeState(state)
    if (step.kind === "steered") say(sessionId, "Steered.")
    if (step.kind === "refuse") return end("refusal")
    if (step.kind === "env") say(sessionId, process.env[step.name] ?? "")
    if (step.kind === "late") late = true
    if (step.kind === "fail") {
      turns.delete(sessionId)
      return send({ id, error: { code: -32000, message: "Authentication required" } })
    }
    if (step.kind === "exit") process.exit(3)
    if (step.kind === "leak") say(sessionId, step.text)
    if (step.kind === "big") say(sessionId, "k".repeat(step.kib * 1024))
    if (step.kind === "permission") {
      const kinds = step.kinds ?? ["allow_once", "reject_once"]
      const answer = await ask("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: randomUUID(), title: "Run a command" },
        options: kinds.map((kind, n) => ({ optionId: `${kind}-${n}`, name: kind, kind }))
      })
      const outcome = answer.result?.outcome
      say(sessionId, `permission: ${outcome?.outcome === "selected" ? outcome.optionId : outcome?.outcome}`)
    }
    if (step.kind === "read") {
      const answer = await ask("fs/read_text_file", { sessionId, path: resolve(state.cwd, "README.md") })
      say(sessionId, `fs: ${answer.error?.code ?? "answered"}`)
    }
    if (step.kind === "garbage") {
      process.stdout.write("this line is not JSON\n")
      send({ method: "session/update", params: { sessionId, update: "not an object" } })
      send({ method: "session/update", params: { sessionId } })
      send({ id: 999999, result: {} })
      send({ method: "agent/whatever", params: {} })
    }
    if (step.kind === "badly") {
      turns.delete(sessionId)
      return send({ id, result: { stopReason: "nonsense" } })
    }
  }
  say(sessionId, "Done.")
  end("end_turn")
}

const handle = (message) => {
  if (message.method === undefined) {
    const resolveAnswer = waiting.get(message.id)
    if (resolveAnswer !== undefined) {
      waiting.delete(message.id)
      resolveAnswer(message)
    }
    return
  }
  const { id, method, params } = message
  if (method === "initialize") {
    if (process.env.ACP_TEST_AGENT_MODE === "bad-initialize") return send({ id, result: {} })
    return send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: process.env.ACP_TEST_AGENT_NO_LOAD !== "1" },
        authMethods: [],
        ...(process.env.ACP_TEST_AGENT_NO_STEER === "1" ? {} : { _meta: { steering: { supported: true } } })
      }
    })
  }
  if (method === "session/new") {
    const sessionId = randomUUID()
    writeState({ sessionId, cwd: params.cwd, pending: [] })
    return send({ id, result: { sessionId } })
  }
  if (method === "session/load") {
    const state = readState(params.sessionId)
    if (state === undefined || process.env.ACP_TEST_AGENT_NO_LOAD === "1") {
      return send({ id, error: { code: -32002, message: "Unknown session" } })
    }
    state.cwd = params.cwd
    writeState(state)
    const replay = existsSync(historyFile(params.sessionId))
      ? readFileSync(historyFile(params.sessionId), "utf8").split("\n").filter((line) => line !== "")
      : []
    for (const line of replay) {
      send({ method: "session/update", params: { sessionId: params.sessionId, update: JSON.parse(line) } })
    }
    return send({ id, result: {} })
  }
  if (method === "session/prompt") return void runTurn(id, params.sessionId, textOf(params.prompt))
  if (method === "session/cancel") {
    const turn = turns.get(params.sessionId)
    if (turn !== undefined) turn.cancel()
    return
  }
  if (method === "_session/steering" && process.env.ACP_TEST_AGENT_NO_STEER !== "1") {
    const turn = turns.get(params.sessionId)
    if (turn === undefined) return send({ id, result: { outcome: "idle" } })
    turn.steer(instructionsOf(textOf(params.prompt)))
    appendFileSync(join(stateDir, "steered.log"), `${params.sessionId}\n`)
    return send({ id, result: { outcome: "injected" } })
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: "Method not found" } })
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf("\n")
  while (newline >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim() !== "") handle(JSON.parse(line))
    newline = buffer.indexOf("\n")
  }
})
process.stdin.on("end", () => process.exit(0))
