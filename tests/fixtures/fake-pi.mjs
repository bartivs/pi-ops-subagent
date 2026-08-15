#!/usr/bin/env node
/**
 * Fake `pi --mode json` child for hermetic runner tests.
 *
 * Reads FAKE_PI_* environment variables and emits the NDJSON event protocol
 * the runner consumes (`message_end`, `tool_result_end`), plus malformed and
 * unknown event lines for diagnostics. Optional report file captures the
 * received argv (child args), the temp prompt path, its mode and content so
 * tests can assert ephemeral-child wiring.
 */
import { writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";

const env = process.env;
const turns = Number(env.FAKE_PI_TURNS ?? "1");
const digest = env.FAKE_PI_DIGEST ?? "final digest from fake pi";
const usage = JSON.parse(env.FAKE_PI_USAGE ?? "{}");
const stopReason = env.FAKE_PI_STOP ?? "end";
const exitCode = Number(env.FAKE_PI_EXIT ?? "0");
const delayMs = Number(env.FAKE_PI_DELAY_MS ?? "0");
const termMode = env.FAKE_PI_TERM_MODE ?? "exit"; // "exit" -> exit(0) on SIGTERM; "hold" -> ignore SIGTERM
const marker = env.FAKE_PI_MARKER;
const digestFromTask = env.FAKE_PI_DIGEST_FROM_TASK === "1";
const failIfTaskHas = env.FAKE_PI_FAIL_IF_TASK ?? null;
const markTasks = env.FAKE_PI_MARK_TASKS === "1";
const reportFile = env.FAKE_PI_REPORT;

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function assistant(text, turnUsage, stop) {
  const msg = {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: {
      input: turnUsage.input ?? 0,
      output: turnUsage.output ?? 0,
      cacheRead: turnUsage.cacheRead ?? 0,
      cacheWrite: turnUsage.cacheWrite ?? 0,
      total: turnUsage.total ?? 0,
      reasoning: turnUsage.reasoning ?? 0,
      cost: { total: turnUsage.cost ?? 0 },
    },
    stopReason: stop ?? "end",
    model: env.FAKE_PI_MODEL ?? "acme/fake-1",
    timestamp: new Date().toISOString(),
  };
  if (env.FAKE_PI_ERROR) msg.errorMessage = env.FAKE_PI_ERROR;
  emit({ type: "message_end", message: msg });
}

function userMessage(text) {
  emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text }], timestamp: new Date().toISOString() } });
}

function toolResult(name, text) {
  emit({
    type: "tool_result_end",
    message: { role: "toolResult", toolName: name, content: [{ type: "text", text }], timestamp: new Date().toISOString() },
  });
}

function writeNamedSession() {
  const idx = process.argv.findIndex((a) => a === "--session-dir");
  if (idx === -1 || !process.argv[idx + 1]) return;
  const dir = process.argv[idx + 1];
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "child-session.jsonl"), '{"type":"session","version":3}\n');
  } catch {
    /* ignore fixture persistence errors */
  }
}

function writeReport() {
  if (!reportFile) return;
  let promptFile = null;
  let promptMode = null;
  let promptContent = null;
  const idx = process.argv.findIndex((a) => a === "--append-system-prompt");
  if (idx !== -1 && process.argv[idx + 1]) {
    promptFile = process.argv[idx + 1];
    try {
      promptMode = statSync(promptFile).mode & 0o777;
      promptContent = readFileSync(promptFile, "utf8");
    } catch {
      /* missing already */
    }
  }
  const payload = {
    argv: process.argv.slice(2),
    promptFile,
    promptMode,
    promptContent,
    cwd: process.cwd(),
  };
  try {
    writeFileSync(reportFile, JSON.stringify(payload, null, 2));
  } catch {
    /* ignore */
  }
}

function appendMarker(text) {
  if (!marker) return;
  try {
    writeFileSync(marker, `${(readFileSync(marker, "utf8") || "")}${text}\n`);
  } catch {
    writeFileSync(marker, `${text}\n`);
  }
}

const taskArg = (() => {
  const idx = process.argv.findIndex((a) => a.startsWith("Task: "));
  return idx === -1 ? "" : process.argv[idx];
})();

if (env.FAKE_PI_TERM === "1" || env.FAKE_PI_TERM_MODE) {
  process.on("SIGTERM", () => {
    appendMarker("SIGTERM");
    if (termMode === "exit") {
      process.exit(0);
    }
    // "hold": do nothing; SIGKILL will follow.
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  if (env.FAKE_PI_DEBUG) console.error(`dbg argvLast=${(process.argv[process.argv.length-1] ?? "").length} taskArg=${taskArg.length}`);
  writeReport();
  writeNamedSession();
  if (markTasks) appendMarker(`task: ${JSON.stringify(taskArg)}`);
  appendMarker("start");
  if (delayMs > 0) await sleep(delayMs);

const extraTurns = Math.max(0, turns - 1);
userMessage("delegated task");
toolResult(env.FAKE_PI_TOOL ?? "bash", "fake tool payload");
for (let i = 0; i < extraTurns; i++) {
  assistant(`interim turn ${i + 1}`, usage);
}
const finalDigest = digestFromTask ? taskArg : digest;
assistant(finalDigest, usage, stopReason);
if (env.FAKE_PI_UNKNOWN === "1") emit({ type: "widget_turn_unknown", payload: { a: 1 } });
if (env.FAKE_PI_MALFORMED === "1") process.stdout.write("{this is not json\n");
  if (failIfTaskHas && taskArg.includes(failIfTaskHas)) {
    appendMarker("fail");
    process.exit(3);
  }
  appendMarker("end");
  process.exit(exitCode);
}
main();