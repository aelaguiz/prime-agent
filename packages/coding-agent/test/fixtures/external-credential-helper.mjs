#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [statePath, requestLogPath] = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(requestLogPath, `${JSON.stringify(request)}\n`);

const state = JSON.parse(readFileSync(statePath, "utf8"));
const callIndex = state.callCount ?? 0;
const response = state.responses[Math.min(callIndex, state.responses.length - 1)];
state.callCount = callIndex + 1;
writeFileSync(statePath, JSON.stringify(state));
if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
process.stdout.write(JSON.stringify(response));
process.exitCode = response.ok ? 0 : 1;
