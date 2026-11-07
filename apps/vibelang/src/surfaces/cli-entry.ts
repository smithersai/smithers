#!/usr/bin/env node
import * as Effect from "effect/Effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { cli } from "./cli.vibe"

process.exitCode = await Effect.runPromise(Effect.provide(cli(process.argv.slice(2), process.env.VIBELANG_FACTORY), NodeServices.layer))
