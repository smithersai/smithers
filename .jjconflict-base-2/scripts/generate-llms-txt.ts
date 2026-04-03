#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { generateLlmsFull } from "./docs-utils";

const output = generateLlmsFull();

writeFileSync("docs/llms-full.txt", output);
console.log(`Generated docs/llms-full.txt (${output.length} chars, ~${Math.round(output.length / 4)} tokens)`);
