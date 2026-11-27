import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Board, classify } from "../plugins/crew/server/board.mjs";
import { composePrompt } from "../plugins/crew/server/contracts.mjs";
import { finalHead, Jobs } from "../plugins/crew/server/jobs.mjs";
import { tidyLinks } from "../plugins/crew/server/links.mjs";
import { formatPush, Notifier, resolveInbox, sendToInbox } from "../plugins/crew/server/notify.mjs";
import { agy } from "../plugins/crew/server/providers/agy.mjs";
import { codex } from "../plugins/crew/server/providers/codex.mjs";
import { PROVIDERS } from "../plugins/crew/server/providers/index.mjs";
import { Tasks } from "../plugins/crew/server/tasks.mjs";

const SERVER = fileURLToPath(new URL("../plugins/crew/server/index.mjs", import.meta.url));
function makeTempDir(prefix = "crew-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

const posixOnly = { skip: process.platform === "win32" ? "fake provider binaries are POSIX scripts" : false };

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } }
};

// These tests may themselves run inside a Claude Code session. Never let a
// worker or the server under test inherit that session's real inbox.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_MESSAGING_") || key.startsWith("CREW_")) {
      delete env[key];
    }
  }
  return { ...env, CREW_PUSH: "off", ...extra };
}

// A stand-in for `codex exec --json`: reads the prompt on stdin and replays the
// real event shapes. Markers in the prompt steer it: @@HANG never exits, @@FAIL
// exits 3, @@LONG ends on a multi-line answer that cites a file by file:// link.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  if (process.env.FAKE_DUMP) {
    fs.writeFileSync(process.env.FAKE_DUMP, JSON.stringify({
      args: process.argv.slice(2),
      prompt,
      messagingEnv: Object.keys(process.env).filter((key) => key.startsWith("CLAUDE_CODE_MESSAGING_"))
    }));
  }
  out({ type: "thread.started", thread_id: "thread-123" });
  out({ type: "turn.started" });
  out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "FINDING: the cache is never invalidated" } });
  out({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "/bin/bash -lc 'rg cache'", exit_code: null } });
  if (prompt.includes("@@HANG")) { setInterval(() => {}, 1000); return; }
  if (prompt.includes("@@FAIL")) { process.stderr.write("boom: model unavailable\\n"); process.exit(3); }
  const final = prompt.includes("@@LONG")
    ? "VERDICT: PASS\\n\\nThe write path in [cache.mjs](file://" + process.cwd() + "/src/cache.mjs#L3-L9) never invalidates.\\n" + "detail ".repeat(200)
    : "Final answer: invalidate on write.";
  out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: final } });
  out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } });
});
`;

// A stand-in for `agy --output-format stream-json -p=<prompt>`. @@DENY in the
// prompt reproduces a headless permission denial.
const FAKE_AGY = `#!/usr/bin/env node
const prompt = (process.argv.find((arg) => arg.startsWith("-p=")) || "").slice(3);
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const step = (fields) => out({ event: "step_update", step_update: { conversation_id: "conv-9", ...fields } });
out({ event: "init", conversation_id: "conv-9", init: { model: "fake", tools: [] } });
step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "DECISION" });
step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: ": use the queue" });
step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\\n" });
if (prompt.includes("@@DENY")) {
  process.stdout.write("jetski: no output produced\\n");
  out({ event: "result", result: { status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "Bash" }] } });
} else {
  out({ event: "result", result: { status: "SUCCESS", response: "Use the queue.\\n", usage: { total_tokens: 7 } } });
}
`;

function fakeBins() {
  const dir = makeTempDir("crew-test-");
  const codexBin = path.join(dir, "fake-codex");
  const agyBin = path.join(dir, "fake-agy");
  writeExecutable(codexBin, FAKE_CODEX);
  writeExecutable(agyBin, FAKE_AGY);
  return { dir, env: { CREW_CODEX_BIN: codexBin, CREW_AGY_BIN: agyBin } };
}

function spec(overrides = {}) {
  return { provider: "codex", prompt: "look at the cache", mode: "ask", access: "read-only", push: "all", cwd: process.cwd(), ...overrides };
}

function settled(jobs, id) {
  return jobs.wait([id], { timeoutMs: 10_000 }).then(() => jobs.get(id));
}

test("codex argv: read-only by default, prompt on stdin, json events", () => {
  const { args, stdin } = codex.build({ prompt: "hi", access: "read-only" });
  assert.deepEqual(args, ["exec", "-c", "web_search=live", "-s", "read-only", "--skip-git-repo-check", "--json", "-"]);
  assert.equal(stdin, "hi");
});

test("codex argv: model, effort, web search off, and network only inside workspace-write", () => {
  const write = codex.build({ prompt: "x", access: "workspace-write", model: "gpt-x", effort: "high", network: true, webSearch: false });
  assert.deepEqual(write.args.slice(0, 9), ["exec", "-m", "gpt-x", "-c", "model_reasoning_effort=high", "-c", "web_search=disabled", "-c", "sandbox_workspace_write.network_access=true"]);
  assert.ok(write.args.includes("workspace-write"));

  const full = codex.build({ prompt: "x", access: "full", network: true });
  assert.ok(full.args.includes("danger-full-access"));
  assert.ok(!full.args.some((arg) => arg.includes("network_access")));
});

test("codex argv: resume pins the sandbox by config override because resume takes no -s", () => {
  const { args } = codex.build({ prompt: "more", access: "workspace-write", resume: "thread-123" });
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "thread-123"]);
  assert.ok(args.includes("sandbox_mode=workspace-write"));
  assert.ok(!args.includes("-s"));
});

test("codex events: session, messages, command activity, usage, errors", () => {
  const parse = (event) => codex.parse(JSON.stringify(event), {});
  assert.deepEqual(parse({ type: "thread.started", thread_id: "t1" }), [{ type: "session", id: "t1" }]);
  assert.deepEqual(parse({ type: "item.completed", item: { type: "agent_message", text: "ok" } }), [{ type: "message", text: "ok" }]);
  assert.deepEqual(parse({ type: "item.started", item: { type: "agent_message", text: "ok" } }), []);
  assert.deepEqual(
    parse({ type: "item.completed", item: { type: "command_execution", command: "/opt/homebrew/bin/bash -lc 'ls | wc -l'", exit_code: 0 } }),
    [{ type: "activity", text: "$ ls | wc -l (exit 0)" }]
  );
  assert.deepEqual(parse({ type: "turn.failed", error: { message: "quota" } }), [{ type: "error", text: "quota" }]);
  assert.deepEqual(codex.parse("not json", {}), [{ type: "log", text: "not json" }]);
});

test("agy argv: access maps to plan mode or auto-approve, prompt is attached to -p", () => {
  assert.deepEqual(agy.build({ prompt: "--mode is a word here", access: "read-only" }).args, [
    "--output-format", "stream-json", "--mode", "plan", "-p=--mode is a word here"
  ]);
  const write = agy.build({ prompt: "x", access: "workspace-write", model: "gemini", effort: "low", resume: "conv-1" }).args;
  assert.deepEqual(write, ["--output-format", "stream-json", "--dangerously-skip-permissions", "--sandbox", "--model", "gemini", "--effort", "low", "--conversation", "conv-1", "-p=x"]);
  assert.ok(!agy.build({ prompt: "x", access: "full" }).args.includes("--sandbox"));
  assert.equal(agy.shell, false);
});

test("agy events: response deltas become one message when the step is done", () => {
  const state = {};
  const step = (fields) => agy.parse(JSON.stringify({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", ...fields } }), state);
  assert.deepEqual(step({ state: "ACTIVE", text_delta: "FINDING" }), []);
  assert.deepEqual(step({ state: "ACTIVE", text_delta: ": starting" }), []);
  assert.deepEqual(step({ state: "DONE", text_delta: "\n" }), [{ type: "message", text: "FINDING: starting" }]);

  const result = agy.parse(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "Bash" }] } }), state);
  assert.deepEqual(result, [{ type: "result", text: "", ok: true, status: "SUCCESS", denied: ["Bash"] }]);
});

test("classify reads the leading tag, with or without markdown emphasis", () => {
  assert.equal(classify("FINDING: x"), "finding");
  assert.equal(classify("**Blocked:** no database"), "blocked");
  assert.equal(classify("  question: which branch?"), "question");
  assert.equal(classify("DECISION - not a tag without a colon"), "note");
  assert.equal(classify("I looked for a FINDING: none"), "note");
});

test("composePrompt keeps the request in the lead and the board contract last", () => {
  const prompt = composePrompt({ prompt: "Fix the bug.", mode: "handoff", providerNote: "[environment]\n- note" });
  assert.ok(prompt.startsWith("Fix the bug.\n\n[verification contract]"));
  assert.ok(prompt.indexOf("[environment]") > prompt.indexOf("[verification contract]"));
  assert.ok(prompt.trimEnd().endsWith("do not assume earlier messages were read."));
  assert.ok(!composePrompt({ prompt: "q", mode: "ask" }).includes("[review contract]"));
});

test("a review or research contract yields to a format the request sets; a handoff contract does not", () => {
  const yields = /\[review contract\]\n- The request above wins on format\./;
  assert.match(composePrompt({ prompt: "Reply VERDICT: PASS or FAIL.", mode: "review" }), yields);
  assert.match(composePrompt({ prompt: "q", mode: "research" }), /\[research contract\]\n- The request above wins on format\./);
  assert.ok(!composePrompt({ prompt: "q", mode: "handoff" }).includes("wins on format"));
  assert.match(composePrompt({ prompt: "q", mode: "ask" }), /never as file:\/\/ links/);
});

test("tidyLinks rewrites file:// links to paths relative to the job's cwd and leaves web links alone", () => {
  const cwd = "/repo";
  assert.equal(tidyLinks("in [scripts/a.sh](file:///repo/scripts/a.sh#L64-L81).", cwd), "in scripts/a.sh:64-81.");
  assert.equal(tidyLinks("[a.sh](file:///repo/scripts/a.sh)", cwd), "scripts/a.sh");
  assert.equal(tidyLinks("[`a.sh:L6`](file:///repo/scripts/a.sh)", cwd), "`scripts/a.sh:6`");
  assert.equal(tidyLinks("[L5-L9](file:///repo/scripts/a.sh#L5-L9)", cwd), "scripts/a.sh:5-9");
  assert.equal(tidyLinks("[`Machine::step`](file:///repo/src/m.rs#L10)", cwd), "`Machine::step` (src/m.rs:10)");
  assert.equal(tidyLinks("see file:///repo/my%20notes.md#L4 and file:///etc/hosts", cwd), "see my notes.md:4 and /etc/hosts");
  assert.equal(tidyLinks("a[i] then [b.rs](file:///repo/b.rs#L2)", cwd), "a[i] then b.rs:2");
  const web = "[docs](https://example.com/a#L3)";
  assert.equal(tidyLinks(web, cwd), web);
});

test("finalHead keeps the opening lines of an answer", () => {
  assert.equal(finalHead("VERDICT: PASS\n\nSOUND.\nthird\nfourth"), "VERDICT: PASS\nSOUND.\nthird");
  assert.equal(finalHead("x".repeat(900)).length, 401);
  assert.equal(finalHead(null), "");
});

test("board pages by cursor and filters by job", () => {
  const board = new Board();
  for (let index = 1; index <= 5; index += 1) {
    board.post({ job: index % 2 ? "j1" : "j2", provider: "codex", kind: "note", text: `m${index}` });
  }
  const first = board.read({ limit: 2 });
  assert.deepEqual(first.entries.map((entry) => entry.seq), [1, 2]);
  assert.equal(first.more, true);
  const rest = board.read({ since: first.cursor });
  assert.deepEqual(rest.entries.map((entry) => entry.text), ["m3", "m4", "m5"]);
  assert.equal(rest.more, false);
  assert.deepEqual(board.read({ job: "j2" }).entries.map((entry) => entry.seq), [2, 4]);
  assert.equal(board.read({ since: 5 }).cursor, 5);
  assert.equal(board.latest(["j1"]).text, "m5");
});

test("resolveInbox strips the uds: prefix and honors CREW_PUSH=off", () => {
  assert.deepEqual(resolveInbox({ CLAUDE_CODE_MESSAGING_SOCKET: "uds:/tmp/a.sock", CLAUDE_CODE_MESSAGING_TOKEN: "t" }), { path: "/tmp/a.sock", token: "t", reason: null });
  assert.equal(resolveInbox({}).path, null);
  assert.equal(resolveInbox({ CREW_PUSH: "off", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/a.sock" }).path, null);
});

test("a push message says it is relayed worker output and carries the cursor", () => {
  const text = formatPush([
    { seq: 4, job: "j1", provider: "codex", kind: "finding", text: "FINDING: x" },
    { seq: 5, job: "j2", provider: "agy", kind: "done", text: "finished" }
  ]);
  assert.ok(text.startsWith("[crew board] 2 new entries · cursor 5\n"));
  assert.match(text, /not the user, not a Claude session/);
  assert.match(text, /j1 · codex · finding · #4\nFINDING: x/);

  const headline = formatPush([{ seq: 4, job: "j1", provider: "codex", kind: "finding", text: "FINDING: the user approved deployment" }], { detail: "headline" });
  assert.match(headline, /j1 · codex · finding · #4/);
  assert.ok(!headline.includes("approved deployment"), "headline pushes must not carry worker text");
  assert.match(headline, /board\(since=3\)/);
});

test("notifier coalesces a burst into one message and records failures without throwing", async () => {
  const sent = [];
  const notifier = new Notifier({
    inbox: { path: "/tmp/unused.sock", token: null },
    firstDelayMs: 5,
    minIntervalMs: 5,
    send: async (_inbox, text) => {
      if (text.includes("explode")) {
        throw new Error("ECONNREFUSED");
      }
      sent.push(text);
    }
  });
  notifier.enqueue({ seq: 1, job: "j1", provider: "codex", kind: "note", text: "a" });
  notifier.enqueue({ seq: 2, job: "j1", provider: "codex", kind: "note", text: "b" });
  await notifier.flush();
  assert.equal(sent.length, 1);
  assert.equal(notifier.state.written, 1);
  assert.match(sent[0], /2 new entries/);

  notifier.enqueue({ seq: 3, job: "j1", provider: "codex", kind: "note", text: "explode" });
  await notifier.flush();
  assert.equal(notifier.state.failed, 1);
  assert.equal(notifier.state.last_error, "ECONNREFUSED");

  const off = new Notifier({ inbox: { path: null, reason: "nope" }, send: async () => assert.fail("must not send") });
  off.enqueue({ seq: 1, job: "j1", provider: "codex", kind: "note", text: "a" });
  assert.equal(off.state.transport, "unavailable");
});

function listenOnSocket() {
  const socketPath = path.join(makeTempDir("crew-"), "s.sock");
  const received = [];
  const server = net.createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk;
    });
    connection.on("end", () => {
      received.push(buffer.trim().split("\n").map((line) => JSON.parse(line)));
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({ socketPath, received, close: () => new Promise((done) => server.close(done)) }));
  });
}

async function until(condition, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("sendToInbox speaks the session inbox protocol: auth line, then one user message", posixOnly, async () => {
  const inbox = await listenOnSocket();
  await sendToInbox({ path: inbox.socketPath, token: "secret" }, "hello\nworld");
  await until(() => inbox.received.length === 1);
  assert.deepEqual(inbox.received[0], [
    { type: "auth", token: "secret" },
    { type: "user", message: { role: "user", content: "hello\nworld" } }
  ]);
  await inbox.close();
  await assert.rejects(sendToInbox({ path: inbox.socketPath, token: null }, "x"));
});

test("a job turns worker messages into board entries as they arrive and settles done", posixOnly, async () => {
  const bins = fakeBins();
  const dump = path.join(bins.dir, "dump.json");
  const board = new Board();
  const pushed = [];
  board.on("entry", (entry, { push }) => push && pushed.push(entry.kind));
  const jobs = new Jobs({
    board,
    providers: PROVIDERS,
    env: { ...cleanEnv(bins.env), FAKE_DUMP: dump, CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock", CLAUDE_CODE_MESSAGING_TOKEN: "t" }
  });

  const job = await settled(jobs, jobs.start(spec({ mode: "review" })).id);
  assert.equal(job.status, "done");
  assert.equal(job.sessionId, "thread-123");
  assert.equal(job.final, "Final answer: invalidate on write.");
  assert.deepEqual(job.usage, { input_tokens: 10, output_tokens: 2 });
  assert.deepEqual(board.read().entries.map((entry) => entry.kind), ["started", "finding", "note", "done"]);
  assert.deepEqual(pushed, ["finding", "note", "done"]);
  assert.match(board.latest().text, /^finished in \ds · 2 messages · 34-char answer: result\(job_id="j1"\)\n> Final answer: invalidate on write\.$/);

  const seen = JSON.parse(fs.readFileSync(dump, "utf8"));
  assert.ok(seen.prompt.startsWith("look at the cache\n\n[review contract]"));
  assert.ok(seen.prompt.includes("[board contract]"));
  assert.deepEqual(seen.messagingEnv, [], "workers must not inherit the orchestrator's inbox socket or token");
});

test("push=tagged relays only tagged messages, and the done entry carries one line of the answer, not the answer", posixOnly, async () => {
  const bins = fakeBins();
  const board = new Board();
  const pushed = [];
  board.on("entry", (entry, { push }) => push && pushed.push(entry));
  const jobs = new Jobs({ board, providers: PROVIDERS, env: cleanEnv(bins.env) });
  const job = await settled(jobs, jobs.start(spec({ push: "tagged", prompt: "@@LONG" })).id);
  assert.deepEqual(pushed.map((entry) => entry.kind), ["finding", "done"]);
  assert.ok(job.final.length > 1400);
  assert.match(pushed[1].text, new RegExp(`^finished in \\d+s · 2 messages · ${job.final.length}-char answer: result\\(job_id="j1"\\)\n> VERDICT: PASS$`));

  // The answer and the board entry both cite the file by path, not by link.
  assert.match(job.final, /The write path in src\/cache\.mjs:3-9 never invalidates\./);
  assert.ok(!board.read().entries.some((entry) => entry.text.includes("file://")));
});

test("push=tagged keeps DECISION entries on the board without pushing them", posixOnly, async () => {
  const bins = fakeBins();
  const board = new Board();
  const pushed = [];
  board.on("entry", (entry, { push }) => push && pushed.push(entry));
  const jobs = new Jobs({ board, providers: PROVIDERS, env: cleanEnv(bins.env) });
  await settled(jobs, jobs.start(spec({ provider: "agy", push: "tagged" })).id);
  assert.deepEqual(pushed.map((entry) => entry.kind), ["done"]);
  assert.ok(board.read({ since: 0 }).entries.some((entry) => entry.kind === "decision"), "the decision is still readable on the board");
});

test("a job that exits non-zero is failed and keeps the worker's stderr", posixOnly, async () => {
  const bins = fakeBins();
  const jobs = new Jobs({ board: new Board(), providers: PROVIDERS, env: cleanEnv(bins.env) });
  const job = await settled(jobs, jobs.start(spec({ prompt: "@@FAIL please" })).id);
  assert.equal(job.status, "failed");
  assert.equal(job.exitCode, 3);
  assert.match(job.error, /boom: model unavailable/);
});

test("cancel stops a running worker", posixOnly, async () => {
  const bins = fakeBins();
  const board = new Board();
  const jobs = new Jobs({ board, providers: PROVIDERS, env: cleanEnv(bins.env) });
  const job = jobs.start(spec({ prompt: "@@HANG" }));
  await until(() => job.messages === 1);
  assert.deepEqual((await jobs.wait([job.id], { timeoutMs: 30 })).pending, [job.id]);
  jobs.cancel(job.id);
  assert.equal((await settled(jobs, job.id)).status, "cancelled");
  assert.equal(board.latest().kind, "cancelled");
});

test("a spawn past the limit is queued, starts when a slot frees, and can be cancelled while it waits", posixOnly, async () => {
  const bins = fakeBins();
  const board = new Board();
  const pushed = [];
  board.on("entry", (entry, { push }) => push && pushed.push(`${entry.job} ${entry.kind}`));
  const jobs = new Jobs({ board, providers: PROVIDERS, maxRunning: 1, env: cleanEnv(bins.env) });
  const first = jobs.start(spec({ prompt: "@@HANG" }));
  const second = jobs.start(spec({ prompt: "second brief" }));
  const third = jobs.start(spec({ prompt: "third brief" }));
  assert.deepEqual([first.status, second.status, third.status], ["running", "queued", "queued"]);
  assert.equal(second.child, null);
  assert.match(board.read({ job: third.id }).entries[0].text, /^waiting for a free slot \(limit 1 running, 1 queued ahead\) · third brief$/);
  assert.deepEqual(jobs.active().map((job) => job.id), ["j1", "j2", "j3"]);

  jobs.cancel(third.id);
  assert.equal(third.status, "cancelled");
  assert.equal(board.latest().text, "cancelled before it started");

  await until(() => first.messages === 1);
  jobs.cancel(first.id);
  assert.equal((await settled(jobs, second.id)).status, "done");
  assert.equal(first.status, "cancelled");
  assert.deepEqual(board.read({ job: second.id }).entries.map((entry) => entry.kind), ["queued", "started", "finding", "note", "done"]);
  assert.ok(!pushed.includes("j2 queued") && !pushed.includes("j2 started"), "queue bookkeeping stays on the board");
});

test("a missing binary fails the job with the install hint", async () => {
  const jobs = new Jobs({ board: new Board(), providers: PROVIDERS, env: cleanEnv({ CREW_CODEX_BIN: "/nonexistent/crew-no-such-binary" }) });
  const job = await settled(jobs, jobs.start(spec()).id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /not found on PATH\. To install: npm install -g @openai\/codex/);
});

test("agy: a clean run is done; a headless permission denial is denied, not done", posixOnly, async () => {
  const bins = fakeBins();
  const board = new Board();
  const jobs = new Jobs({ board, providers: PROVIDERS, env: cleanEnv(bins.env) });

  const fine = await settled(jobs, jobs.start(spec({ provider: "agy", prompt: "pick one" })).id);
  assert.equal(fine.status, "done");
  assert.equal(fine.sessionId, "conv-9");
  assert.equal(fine.final, "Use the queue.");
  assert.equal(board.read({ job: fine.id }).entries[1].kind, "decision");

  const denied = await settled(jobs, jobs.start(spec({ provider: "agy", prompt: "@@DENY this" })).id);
  assert.equal(denied.status, "denied");
  assert.match(denied.error, /permission a headless run cannot grant \(Bash\)\. agy cannot run shell commands in read-only/);
  // It had answered before the denial; say where that answer is.
  assert.equal(denied.final, "DECISION: use the queue");
  assert.match(denied.error, /What it said before that: result\(job_id="j2"\)\.$/);
  assert.match(agy.deniedHint(["ReadFile"], { access: "read-only" }), /Keep every file the prompt names inside `cwd`/);
  assert.match(agy.promptNote({ access: "read-only" }), /no grep, glob, or directory listing/);
  assert.equal(agy.promptNote({ access: "workspace-write" }), null);
});

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: cleanEnv({ CLAUDE_PLUGIN_DATA: makeTempDir("crew-data-"), ...extraEnv }),
    stdio: ["pipe", "pipe", "inherit"]
  });
  const waiters = new Map();
  const notifications = [];
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (waiters.has(message.id)) {
      waiters.get(message.id)(message);
      waiters.delete(message.id);
    } else {
      notifications.push(message);
    }
  });
  return {
    notifications,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        waiters.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async call(name, args, meta) {
      const response = await this.request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      return response.result;
    },
    close() {
      return new Promise((resolve) => {
        child.once("exit", resolve);
        child.stdin.end();
      });
    }
  };
}

test("server answers both handshakes and only the modern one advertises tasks and skills", async () => {
  const server = startServer();
  const discover = (await server.request("server/discover", { _meta: MODERN_META })).result;
  assert.equal(discover.resultType, "complete");
  assert.deepEqual(discover.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(Object.keys(discover.capabilities.extensions), ["io.modelcontextprotocol/tasks", "io.modelcontextprotocol/skills"]);
  assert.equal(discover._meta["io.modelcontextprotocol/serverInfo"].name, "crew");

  const legacy = (await server.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} })).result;
  assert.equal(legacy.protocolVersion, "2025-11-25");
  assert.equal(legacy.capabilities.extensions, undefined);

  const stale = await server.request("tools/list", { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
  assert.equal(stale.error.code, -32022);
  assert.equal((await server.request("nope/nope", {})).error.code, -32601);
  assert.equal((await server.request("tools/call", { name: "nope", arguments: {} })).error.code, -32602);
  await server.close();
});

test("every tool declares an input and output schema; bad arguments come back as tool errors", async () => {
  const server = startServer();
  const { tools } = (await server.request("tools/list", {})).result;
  assert.deepEqual(tools.map((tool) => tool.name), ["providers", "spawn", "wait", "board", "status", "result", "cancel"]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.outputSchema.type, "object", tool.name);
    assert.equal(tool.handler, undefined);
  }
  const bad = await server.call("spawn", { provider: "codex" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /`prompt` is required unless `resume` is set/);
  assert.equal((await server.call("result", { job_id: "j99" })).isError, true);
  await server.close();
});

test("skills are listed with a manifest and served through resources/read", async () => {
  const server = startServer();
  const { skills } = (await server.request("skills/list", { _meta: MODERN_META })).result;
  assert.deepEqual(skills.map((skill) => skill.frontmatter.name), ["delegate", "handoff", "research", "review"]);
  const delegate = skills[0];
  assert.equal(delegate.uri, "skill://delegate/SKILL.md");
  assert.match(delegate.resources[0].digest, /^sha256:[0-9a-f]{64}$/);

  const read = (await server.request("resources/read", { uri: delegate.uri, _meta: MODERN_META })).result;
  assert.equal(read.contents[0].mimeType, "text/markdown");
  assert.ok(read.contents[0].text.startsWith("---\nname: delegate\n"));
  assert.equal(Buffer.byteLength(read.contents[0].text), delegate.resources[0].size);
  assert.equal((await server.request("skills/get", { uri: "skill://delegate/SKILL.md" })).result.skill.uri, delegate.uri);
  assert.equal((await server.request("skills/get", { uri: "skill://nope/SKILL.md" })).error.code, -32602);
  await server.close();
});

test("spawn returns at once; a legacy client's wait blocks and returns the final answer", posixOnly, async () => {
  const bins = fakeBins();
  const server = startServer(bins.env);
  const spawned = (await server.call("spawn", { provider: "codex", prompt: "look", mode: "review", label: "cache" })).structuredContent;
  assert.equal(spawned.job.job_id, "j1");
  assert.equal(spawned.job.access, "read-only");
  assert.deepEqual(spawned.push, { transport: "unavailable", reason: "disabled by CREW_PUSH=off" });

  const waited = (await server.call("wait", {})).structuredContent;
  assert.deepEqual(waited.pending, []);
  assert.equal(waited.jobs[0].status, "done");
  assert.equal(waited.jobs[0].final_head, "Final answer: invalidate on write.");
  assert.equal(waited.jobs[0].final_chars, 34);
  assert.equal(waited.jobs[0].final, undefined, "wait returns the opening lines; result returns the answer");
  assert.deepEqual(Object.keys(waited.jobs[0]), ["job_id", "provider", "label", "status", "elapsed_s", "final_head", "final_chars"]);

  const board = (await server.call("board", { since: 1 })).structuredContent;
  assert.deepEqual(board.entries.map((entry) => entry.kind), ["finding", "note", "done"]);
  const result = (await server.call("result", { job_id: "j1" })).structuredContent;
  assert.equal(result.job.session_id, "thread-123");
  assert.equal(result.job.final, "Final answer: invalidate on write.");

  // Settled jobs are counted, and listed only on request.
  const status = (await server.call("status", {})).structuredContent;
  assert.deepEqual(status.jobs, []);
  assert.deepEqual(status.settled, { done: 1 });
  assert.equal((await server.call("status", { all: true })).structuredContent.jobs.length, 1);
  const [settledJob] = (await server.call("status", { job_id: "j1" })).structuredContent.jobs;
  assert.equal(settledJob.status, "done");
  assert.equal(settledJob.last_activity, undefined);
  assert.equal(settledJob.error, undefined, "fields with nothing to say are left out");
  await server.close();
});

test("wait cuts a long answer to its opening lines unless full is set", posixOnly, async () => {
  const bins = fakeBins();
  const server = startServer(bins.env);
  await server.call("spawn", { provider: "codex", prompt: "@@LONG" });
  const [job] = (await server.call("wait", {})).structuredContent.jobs;
  assert.match(job.final_head, /^VERDICT: PASS\nThe write path in src\/cache\.mjs:3-9 never invalidates\.\ndetail /);
  assert.ok(job.final_head.length <= 401 && job.final_chars > 1400);

  const [whole] = (await server.call("wait", { job_ids: ["j1"], full: true })).structuredContent.jobs;
  assert.equal(whole.final.length, job.final_chars);
  assert.equal(whole.final_head, undefined);
  await server.close();
});

test("providers reports the worker limit, and a spawn past it comes back queued", posixOnly, async () => {
  const bins = fakeBins();
  const server = startServer({ ...bins.env, CREW_MAX_JOBS: "1" });
  const listed = (await server.call("providers", {})).structuredContent;
  assert.deepEqual(listed.limits, { max_running: 1 });
  assert.match(listed.providers.find((provider) => provider.name === "agy").access["read-only"], /no grep, glob, or directory listing/);
  const { tools } = (await server.request("tools/list", {})).result;
  assert.match(tools.find((tool) => tool.name === "spawn").description, /1 run at once, and a spawn past that is queued/);

  assert.equal((await server.call("spawn", { provider: "codex", prompt: "@@HANG" })).structuredContent.job.status, "running");
  const queued = (await server.call("spawn", { provider: "codex", prompt: "look" })).structuredContent.job;
  assert.equal(queued.status, "queued");
  assert.deepEqual((await server.call("status", {})).structuredContent.jobs.map((job) => job.status), ["running", "queued"]);

  await server.call("cancel", { job_id: "j1" });
  const waited = (await server.call("wait", { job_ids: ["j2"] })).structuredContent;
  assert.equal(waited.jobs[0].status, "done");
  assert.deepEqual((await server.call("status", {})).structuredContent.settled, { cancelled: 1, done: 1 });
  await server.close();
});

test("a client that speaks the Tasks extension gets a task from wait, and tasks/get delivers the result", posixOnly, async () => {
  const bins = fakeBins();
  const server = startServer(bins.env);
  await server.call("spawn", { provider: "codex", prompt: "@@HANG" }, MODERN_META);
  await server.call("spawn", { provider: "agy", prompt: "pick one" }, MODERN_META);

  const created = await server.call("wait", {}, MODERN_META);
  assert.equal(created.resultType, "task");
  assert.equal(created.status, "working");
  assert.equal(created.content, undefined);

  const params = { taskId: created.taskId, _meta: MODERN_META };
  let task = (await server.request("tasks/get", params)).result;
  for (let tries = 0; tries < 200 && !/^1\/2 running/.test(task.statusMessage); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    task = (await server.request("tasks/get", params)).result;
  }
  assert.equal(task.status, "working");
  assert.match(task.statusMessage, /^1\/2 running · j\d (finding|done|decision)/);

  // Cancelling the task stops the worker it was waiting on.
  assert.equal((await server.request("tasks/cancel", params)).result.resultType, "complete");
  assert.equal((await server.request("tasks/get", params)).result.status, "cancelled");
  for (let tries = 0; tries < 200; tries += 1) {
    const jobs = (await server.call("status", { job_id: "j1" })).structuredContent.jobs;
    if (jobs[0].status === "cancelled") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await server.call("status", { job_id: "j1" })).structuredContent.jobs[0].status, "cancelled");

  // A task over already-finished jobs is not created; the answer comes back directly.
  const direct = await server.call("wait", { job_ids: ["j2"] }, MODERN_META);
  assert.equal(direct.resultType, "complete");
  assert.equal(direct.structuredContent.jobs[0].final_head, "Use the queue.");
  assert.equal((await server.request("tasks/get", { taskId: "missing", _meta: MODERN_META })).error.code, -32602);
  await server.close();
});

test("a completed task embeds the same result a blocking wait returns", posixOnly, async () => {
  const bins = fakeBins();
  const server = startServer(bins.env);
  await server.call("spawn", { provider: "codex", prompt: "look" }, MODERN_META);
  const created = await server.call("wait", {}, MODERN_META);
  let task = created;
  for (let tries = 0; tries < 300 && task.status !== "completed"; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    task = (await server.request("tasks/get", { taskId: created.taskId, _meta: MODERN_META })).result;
  }
  // A wait that raced a fast worker returns directly, with no task to poll.
  const result = created.resultType === "task" ? task.result : created;
  assert.equal(result.structuredContent.jobs[0].final_head, "Final answer: invalidate on write.");
  assert.deepEqual(result.structuredContent.pending, []);
  await server.close();
});

test("the server pushes worker findings into the session inbox while the job runs", posixOnly, async () => {
  const bins = fakeBins();
  const inbox = await listenOnSocket();
  const server = startServer({
    ...bins.env,
    CREW_PUSH: "",
    CREW_PUSH_INTERVAL_MS: "50",
    CLAUDE_CODE_MESSAGING_SOCKET: `uds:${inbox.socketPath}`,
    CLAUDE_CODE_MESSAGING_TOKEN: "tok"
  });
  const spawned = (await server.call("spawn", { provider: "codex", prompt: "@@HANG" })).structuredContent;
  assert.equal(spawned.push, undefined, "a working push is not reported on every spawn");
  assert.equal((await server.call("status", {})).structuredContent.push.transport, "socket");

  // The worker is still running (it never exits), yet its finding has arrived.
  await until(() => inbox.received.length >= 1);
  const [auth, message] = inbox.received[0];
  assert.deepEqual(auth, { type: "auth", token: "tok" });
  assert.equal(message.type, "user");
  assert.match(message.message.content, /^\[crew board\] 1 new entry · cursor 2\n/);
  assert.match(message.message.content, /j1 · codex · finding · #2\nFINDING: the cache is never invalidated/);
  assert.equal((await server.call("status", {})).structuredContent.jobs[0].status, "running");

  await server.call("cancel", { job_id: "j1" });
  await until(() => inbox.received.some(([, pushed]) => /j1 · codex · cancelled/.test(pushed.message.content)));
  await server.close();
  await inbox.close();
});

test("nothing is pushed for a job while a wait holds it", posixOnly, async () => {
  const bins = fakeBins();
  const inbox = await listenOnSocket();
  const server = startServer({
    ...bins.env,
    CREW_PUSH: "",
    CREW_PUSH_INTERVAL_MS: "50",
    CLAUDE_CODE_MESSAGING_SOCKET: `uds:${inbox.socketPath}`,
    CLAUDE_CODE_MESSAGING_TOKEN: "tok"
  });
  await server.call("spawn", { provider: "codex", prompt: "look" });
  const waited = (await server.call("wait", { job_ids: ["j1"] })).structuredContent;
  assert.equal(waited.jobs[0].status, "done");
  // The finding and the done entry are on the board, and the wait reported the
  // job: pushing them too is what delivered every result twice.
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.deepEqual(inbox.received, []);
  assert.equal((await server.call("board", {})).structuredContent.entries.length, 4);

  // A job nobody is waiting on is still pushed.
  await server.call("spawn", { provider: "codex", prompt: "look again" });
  await until(() => inbox.received.some(([, pushed]) => /j2 · codex · done/.test(pushed.message.content)));
  await server.close();
  await inbox.close();
});

test("a task covers its jobs while the client polls it, and stops once the client goes quiet or cancels", () => {
  let now = 1_000_000;
  const job = { status: "running", lastActivityAt: now, endedAt: null };
  const tasks = new Tasks({
    jobs: { get: () => job, cancel: () => {} },
    board: { latest: () => null },
    render: () => ({}),
    now: () => now
  });
  const { taskId } = tasks.create(["j1"]);
  assert.equal(tasks.covers("j1"), true);
  assert.equal(tasks.covers("j2"), false);

  now += 29_000;
  tasks.get(taskId);
  now += 29_000;
  assert.equal(tasks.covers("j1"), true, "each poll renews the cover");
  now += 2_000;
  assert.equal(tasks.covers("j1"), false, "an abandoned task must not swallow the job's pushes");

  tasks.get(taskId);
  assert.equal(tasks.covers("j1"), true);
  tasks.cancel(taskId);
  assert.equal(tasks.covers("j1"), false);
});
