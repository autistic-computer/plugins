// The message board: an append-only, sequence-numbered log of what workers
// said while they worked. Everything else reads from it: the notifier pushes
// new entries into the orchestrator's session, the `board` tool pages through
// it by cursor, and task status lines quote its latest entry.

import { EventEmitter } from "node:events";
import { appendFile } from "node:fs";

const TAGS = { FINDING: "finding", BLOCKED: "blocked", QUESTION: "question", DECISION: "decision" };
const TAG_PATTERN = /^\s*[*_]{0,2}(FINDING|BLOCKED|QUESTION|DECISION)[*_]{0,2}\s*:/i;

// Entry kinds that close a job. They double as the job's final status.
export const TERMINAL_KINDS = new Set(["done", "failed", "denied", "cancelled"]);

/** Workers are asked to lead a message with a tag; anything else is a plain note. */
export function classify(text) {
  const match = TAG_PATTERN.exec(String(text ?? ""));
  return match ? TAGS[match[1].toUpperCase()] : "note";
}

export function clip(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}… [+${value.length - max} chars]`;
}

export class Board extends EventEmitter {
  #entries = [];
  #seq = 0;
  #logFile;
  #capacity;

  constructor({ logFile = null, capacity = 2000 } = {}) {
    super();
    this.#logFile = logFile;
    this.#capacity = capacity;
  }

  get cursor() {
    return this.#seq;
  }

  /**
   * @param {{job: string, provider: string, kind: string, text: string, push?: boolean}} input
   * `push` asks the notifier to relay this entry; the board itself records every entry.
   */
  post({ job, provider, kind, text, push = true }) {
    const entry = {
      seq: ++this.#seq,
      ts: new Date().toISOString(),
      job,
      provider,
      kind,
      text: clip(text, 20_000)
    };
    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) {
      this.#entries.splice(0, this.#entries.length - this.#capacity);
    }
    if (this.#logFile) {
      // Best effort: the on-disk log is for post-mortems, not for correctness.
      appendFile(this.#logFile, `${JSON.stringify(entry)}\n`, () => {});
    }
    this.emit("entry", entry, { push });
    return entry;
  }

  read({ since = 0, job = null, limit = 50 } = {}) {
    const matching = this.#entries.filter((entry) => entry.seq > since && (!job || entry.job === job));
    const entries = matching.slice(0, limit);
    return {
      entries,
      cursor: entries.length ? entries.at(-1).seq : since,
      more: matching.length > entries.length
    };
  }

  latest(jobIds = null) {
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index];
      if (!jobIds || jobIds.includes(entry.job)) {
        return entry;
      }
    }
    return null;
  }
}
