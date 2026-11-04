#!/usr/bin/env node
/**
 * decisiontrail CLI.
 *
 *   decisiontrail mcp
 *   decisiontrail <tool> '<json-args>'
 *   decisiontrail --version
 *
 * <tool> is one of the elen_* tool names; the JSON argument is optional
 * for the no-argument tools. Results are printed as JSON.
 * Exit codes: 0 success, 1 domain error (e.g. unknown decision id),
 * 2 usage / argument-validation error.
 *
 * The store lives at DECISIONTRAIL_DB or ~/.decisiontrail/decisions.json;
 * DECISIONTRAIL_AGENT / DECISIONTRAIL_PROJECT name the namespace
 * (default "local").
 */
import { DecisionTrail, TOOL_NAMES, ValidationError, VERSION } from "./decisiontrail.js";

function usage(): never {
  console.error(`Usage:
  decisiontrail mcp
  decisiontrail <tool> '<json-args>'
  decisiontrail --version

Tools: ${TOOL_NAMES.join(", ")}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (!cmd || !(TOOL_NAMES as readonly string[]).includes(cmd)) usage();
  if (rest.length > 1) usage();
  let args: unknown = {};
  if (rest.length === 1) {
    try {
      args = JSON.parse(rest[0]);
    } catch {
      console.error(`error: argument for ${cmd} is not valid JSON`);
      process.exit(2);
    }
  }
  try {
    const trail = DecisionTrail.fromEnv();
    const result = trail.dispatch(cmd, args);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(`error: ${err.message}`);
      process.exit(2);
    }
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
