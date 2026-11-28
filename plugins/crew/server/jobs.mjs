// Job manager: one job is one worker process. It spawns the provider's CLI,
// turns its event stream into board entries as they arrive, and settles the job
// with a final status when the process exits.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

import { classify, TERMINAL_KINDS } from "./board.mjs";
import { composePrompt } from "./contracts.mjs";
import { tidyLinks } from "./links.mjs";

// `push: "tagged"` interrupts the orchestrator only for what it may have to act on
// now. Notes and DECISION entries stay on the board, where `board` reads them.
const PUSHED_WHEN_TAGGED = new Set(["finding", "blocked", "question"]);

const KILL_GRACE_MS = 3000;

export const RUNNING_LIMIT_DEFAULT = 6;
export const RUNNING_LIMIT_MAX = 64;

function firstLine(text, max = 160) {
  const line = String(text ?? "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function tail(text, max = 4000) {
  return text.length > max ? text.slice(-max) : text;
}

// Workers must not reach the orchestrator's inbox on their own: the server is
// the only relay, and it labels what it relays. Drop the socket and its token.
function workerEnv(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("CLAUDE_CODE_MESSAGING_")) {
      delete clean[key];
    }
  }
  return clean;
}

export function isTerminal(job) {
  return TERMINAL_KINDS.has(job.status);
}

function runSeconds(job, now = Date.now()) {
  return job.startedAt ? Math.round(((job.endedAt ?? now) - job.startedAt) / 1000) : 0;
}

/**
 * The public, JSON-safe view of a job. Fields with nothing to say are left
 * out: the orchestrator pays for every key of every job it lists.
 */
export function summarize(job, now = Date.now()) {
  const view = {
    job_id: job.id,
    provider: job.provider,
    mode: job.mode,
    label: job.label,
    status: job.status,
    access: job.access,
    model: job.model,
    effort: job.effort,
    speed: job.speed,
    cwd: job.cwd,
    session_id: job.sessionId,
    started_at: new Date(job.startedAt ?? job.createdAt).toISOString(),
    elapsed_s: runSeconds(job, now),
    messages: job.messages,
    last_activity: job.lastActivity,
    usage: job.usage,
    exit_code: job.exitCode,
    error: job.error
  };
  // What a settled job was last doing is its answer, which has its own field.
  if (isTerminal(job)) {
    delete view.last_activity;
  }
  for (const key of Object.keys(view)) {
    if (view[key] === null || view[key] === undefined) {
      delete view[key];
    }
  }
  return view;
}

/** The few fields that say how a job ended, for a result that lists several jobs. */
export function outcome(job) {
  const view = { job_id: job.id, provider: job.provider, label: job.label, status: job.status, elapsed_s: runSeconds(job), error: job.error };
  for (const key of Object.keys(view)) {
    if (view[key] === null) {
      delete view[key];
    }
  }
  return view;
}

/** The opening lines of a final answer: enough to read a verdict, not the review. */
export function finalHead(text, { maxLines = 3, maxChars = 400 } = {}) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, maxLines);
  const head = lines.join("\n");
  return head.length > maxChars ? `${head.slice(0, maxChars)}…` : head;
}

export class Jobs extends EventEmitter {
  #jobs = new Map();
  #counter = 0;
  #board;
  #providers;
  #maxRunning;
  #spawn;
  #env;
  #closing = false;

  constructor({ board, providers, maxRunning = RUNNING_LIMIT_DEFAULT, spawnImpl = spawn, env = process.env }) {
    super();
    this.setMaxListeners(0);
    this.#board = board;
    this.#providers = providers;
    this.#maxRunning = maxRunning;
    this.#spawn = spawnImpl;
    this.#env = env;
  }

  get(id) {
    return this.#jobs.get(id) ?? null;
  }

  list() {
    return [...this.#jobs.values()];
  }

  get maxRunning() {
    return this.#maxRunning;
  }

  setMaxRunning(limit) {
    assert.ok(Number.isInteger(limit), `running limit must be an integer, got ${limit}`);
    assert.ok(limit >= 1, `running limit must be at least 1, got ${limit}`);
    assert.ok(limit <= RUNNING_LIMIT_MAX, `running limit must be at most ${RUNNING_LIMIT_MAX}, got ${limit}`);
    this.#maxRunning = limit;
    this.#drain();
  }

  counts() {
    const jobs = this.list();
    return {
      running: jobs.filter((job) => job.status === "running").length,
      queued: jobs.filter((job) => job.status === "queued").length
    };
  }

  /** Jobs that have not settled: running, or queued behind the limit. */
  active() {
    return this.list().filter((job) => !isTerminal(job));
  }

  #runningCount() {
    return this.list().filter((job) => job.status === "running").length;
  }

  /**
   * @param {object} spec
   * @param {string} spec.provider  @param {string} spec.prompt  @param {string} spec.mode
   * @param {string} spec.access  @param {string} spec.cwd  @param {"all"|"tagged"|"off"} spec.push
   * @param {string} [spec.model]  @param {string} [spec.effort]  @param {"fast"|"ultrafast"} [spec.speed]
   * @param {boolean} [spec.network]
   * @param {boolean} [spec.webSearch]  @param {string} [spec.resume]  @param {string} [spec.label]
   */
  start(spec) {
    const provider = this.#providers[spec.provider];
    const prompt = composePrompt({
      prompt: spec.prompt,
      mode: spec.mode,
      providerNote: provider.promptNote({ access: spec.access })
    });
    const now = Date.now();
    const job = {
      id: `j${++this.#counter}`,
      provider: provider.name,
      mode: spec.mode,
      label: spec.label ?? null,
      access: spec.access,
      model: spec.model ?? null,
      effort: spec.effort ?? null,
      speed: spec.speed ?? null,
      cwd: spec.cwd,
      push: spec.push,
      status: "queued",
      createdAt: now,
      startedAt: null,
      endedAt: null,
      sessionId: spec.resume ?? null,
      final: null,
      error: null,
      exitCode: null,
      usage: null,
      messages: 0,
      lastActivity: "queued",
      lastActivityAt: now,
      lastMessage: null,
      result: null,
      errors: [],
      logTail: "",
      cancelRequested: false,
      spawnError: null,
      child: null,
      killTimer: null,
      parseState: {},
      // Built now so a bad spec fails the `spawn` call, not a queued job later.
      invocation: provider.build({ ...spec, prompt }),
      promptHead: firstLine(spec.prompt)
    };
    this.#jobs.set(job.id, job);

    // Over the limit, the job waits its turn. Rejecting it instead made the
    // orchestrator resend the whole prompt: seven long briefs in one session.
    if (this.#runningCount() >= this.#maxRunning) {
      const ahead = this.list().filter((other) => other.status === "queued").length - 1;
      this.#board.post({
        job: job.id,
        provider: job.provider,
        kind: "queued",
        text: `waiting for a free slot (limit ${this.#maxRunning} running, ${ahead} queued ahead) · ${job.promptHead}`,
        push: false
      });
    } else {
      this.#launch(job);
    }
    return job;
  }

  #launch(job) {
    const provider = this.#providers[job.provider];
    const invocation = job.invocation;
    job.invocation = null;
    job.status = "running";
    job.startedAt = Date.now();
    job.lastActivity = "starting";
    job.lastActivityAt = job.startedAt;

    const hasStdin = invocation.stdin != null;
    let child;
    try {
      child = this.#spawn(provider.bin(this.#env), invocation.args, {
        cwd: job.cwd,
        env: workerEnv(this.#env),
        stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
        // Own process group, so cancelling takes the worker's shells down with it.
        detached: process.platform !== "win32",
        shell: provider.shell,
        windowsHide: true
      });
    } catch (error) {
      job.spawnError = error;
      this.#finish(job, null, null);
      return;
    }
    job.child = child;

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const drained = new Promise((resolve) => lines.once("close", resolve));
    lines.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      let events;
      try {
        events = provider.parse(line, job.parseState);
      } catch (error) {
        events = [{ type: "log", text: `unparsed event: ${error.message}` }];
      }
      for (const event of events) {
        this.#onEvent(job, event);
      }
    });
    child.stderr.on("data", (chunk) => {
      job.logTail = tail(job.logTail + chunk);
    });
    if (hasStdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(invocation.stdin, "utf8");
    }
    child.once("error", (error) => {
      job.spawnError = error;
      this.#finish(job, null, null);
    });
    child.once("close", (code, signal) => {
      drained.then(() => this.#finish(job, code, signal));
    });

    this.#board.post({ job: job.id, provider: job.provider, kind: "started", text: job.promptHead, push: false });
  }

  /** Start queued jobs, oldest first, while there is room under the limit. */
  #drain() {
    if (this.#closing) {
      return;
    }
    for (const job of this.list()) {
      if (this.#runningCount() >= this.#maxRunning) {
        return;
      }
      if (job.status === "queued") {
        this.#launch(job);
      }
    }
  }

  #onEvent(job, event) {
    job.lastActivityAt = Date.now();
    switch (event.type) {
      case "session":
        job.sessionId = event.id;
        break;
      case "message": {
        const text = tidyLinks(String(event.text ?? "").trim(), job.cwd);
        if (!text) {
          break;
        }
        const kind = classify(text);
        const push = job.push === "all" || (job.push === "tagged" && PUSHED_WHEN_TAGGED.has(kind));
        job.messages += 1;
        job.lastMessage = text;
        job.lastActivity = firstLine(text);
        this.#board.post({ job: job.id, provider: job.provider, kind, text, push });
        break;
      }
      case "activity":
        job.lastActivity = event.text;
        break;
      case "usage":
        job.usage = event.usage;
        break;
      case "result":
        job.result = event;
        break;
      case "error":
        job.errors.push(event.text);
        break;
      case "log":
        job.logTail = tail(`${job.logTail}${event.text}\n`);
        break;
      default:
        break;
    }
  }

  #finish(job, code, signal) {
    if (isTerminal(job)) {
      return;
    }
    clearTimeout(job.killTimer);
    const provider = this.#providers[job.provider];
    const neverRan = job.status === "queued";
    job.endedAt = Date.now();
    job.exitCode = code;
    job.child = null;
    job.invocation = null;
    job.final = tidyLinks((job.result?.text ?? "").trim(), job.cwd) || job.lastMessage || null;
    const seconds = runSeconds(job);
    const logs = job.logTail.trim().split("\n").slice(-6).join("\n");
    const kept = job.final ? ` What it said before that: result(job_id="${job.id}").` : "";

    let text;
    if (job.cancelRequested) {
      job.status = "cancelled";
      text = neverRan ? "cancelled before it started" : `cancelled after ${seconds}s`;
    } else if (job.spawnError) {
      job.status = "failed";
      job.error =
        job.spawnError.code === "ENOENT"
          ? `${provider.bin(this.#env)} not found on PATH. To install: ${provider.install}.`
          : job.spawnError.message;
      text = `failed to start: ${job.error}`;
    } else if (job.result?.denied?.length) {
      // The worker hit a permission prompt nobody could answer. Whatever it
      // said before that is partial, so do not let it pass as a finished run.
      job.status = "denied";
      const hint =
        provider.deniedHint?.(job.result.denied, { access: job.access }) ??
        'Retry with access="workspace-write", or narrow the task to reading files.';
      job.error = `${job.provider} needed a permission a headless run cannot grant (${job.result.denied.join(", ")}). ${hint}${kept}`;
      text = `stopped after ${seconds}s: ${job.error}`;
    } else if (code !== 0 || signal || job.result?.ok === false || !job.final) {
      job.status = "failed";
      job.error =
        job.errors.join("; ") ||
        logs ||
        (code === 0 ? "exited cleanly without an answer" : `exited with ${signal ?? `code ${code}`}`);
      text = `failed after ${seconds}s: ${job.error}`;
    } else {
      job.status = "done";
      // The answer itself stays out of this entry. It used to ride along, so
      // one review reached the orchestrator three times: as mid-run findings,
      // clipped in this push, and whole from `wait` or `result`. Now it is
      // read once, from `result`; this entry carries only its opening line.
      text = [
        `finished in ${seconds}s · ${job.messages} message${job.messages === 1 ? "" : "s"} · ${job.final.length}-char answer: result(job_id="${job.id}")`,
        `> ${firstLine(job.final)}`
      ].join("\n");
    }

    this.#board.post({ job: job.id, provider: job.provider, kind: job.status, text, push: job.push !== "off" });
    this.emit("settled", job);
    this.#drain();
  }

  #kill(job, signal) {
    const child = job.child;
    if (!child?.pid) {
      return;
    }
    try {
      if (process.platform === "win32") {
        // Windows has no process groups to signal; taskkill /T takes the tree.
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill(signal));
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  cancel(id) {
    const job = this.#jobs.get(id);
    if (!job || isTerminal(job)) {
      return job ?? null;
    }
    job.cancelRequested = true;
    if (job.status === "queued") {
      this.#finish(job, null, null);
      return job;
    }
    this.#kill(job, "SIGTERM");
    job.killTimer = setTimeout(() => this.#kill(job, "SIGKILL"), KILL_GRACE_MS);
    job.killTimer.unref?.();
    return job;
  }

  /** Resolve once every listed job has settled, or on timeout or abort. */
  wait(ids, { signal = null, timeoutMs = 0 } = {}) {
    const pending = () => ids.filter((id) => !isTerminal(this.#jobs.get(id)));
    return new Promise((resolve) => {
      if (!pending().length || signal?.aborted) {
        resolve({ pending: pending() });
        return;
      }
      let timer = null;
      const finish = () => {
        this.off("settled", onSettled);
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve({ pending: pending() });
      };
      const onSettled = () => {
        if (!pending().length) {
          finish();
        }
      };
      this.on("settled", onSettled);
      if (timeoutMs > 0) {
        timer = setTimeout(finish, timeoutMs);
      }
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /** Stop every worker. The client gives a stdio server about half a second to exit. */
  shutdown({ graceMs = 250 } = {}) {
    this.#closing = true;
    const running = this.active().filter((job) => job.status === "running");
    for (const job of running) {
      job.cancelRequested = true;
      this.#kill(job, "SIGTERM");
    }
    if (!running.length) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        for (const job of running) {
          this.#kill(job, "SIGKILL");
        }
        resolve();
      }, graceMs);
    });
  }
}
