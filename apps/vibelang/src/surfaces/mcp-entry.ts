#!/usr/bin/env node
import * as Effect from "effect/Effect"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { mcp } from "./mcp.vibe"

const args = process.argv.slice(2)
NodeRuntime.runMain(Effect.provide(mcp(args.includes("--mock"), process.env.VIBELANG_FACTORY), NodeServices.layer), { disableErrorReporting: true })
