# Changelog

## 0.2.1

- The marketplace moved to `autistic-computer/plugins`.

## 0.2.0

- Server instructions, the `providers` and `spawn` descriptions, and every
  skill now tell Claude to use crew only when the user asks for Codex, Gemini,
  or agy by name, never on its own initiative or for a generic review or
  research request.
- Fewer pushes: `spawn` now defaults to `push: "tagged"`, which relays only
  `FINDING`, `BLOCKED`, and `QUESTION` (notes and `DECISION` stay on the
  board), and `CREW_PUSH_INTERVAL_MS` defaults to 15000 so more entries share
  one push.
- A final answer reaches the orchestrator once. The completion entry is one
  line with the answer's first line, not the answer; a pushed entry is clipped
  to 600 characters (was 1500); and the note on every push is one line.
- `wait` returns each job's `final_head` (its opening lines) and `final_chars`
  instead of `final`. Pass `full: true` for the whole answers, or read one with
  `result`. Nothing is pushed for a job while a `wait` holds it.
- A spawn past `CREW_MAX_JOBS` is queued (status `queued`) and starts when a
  worker finishes, instead of failing after the prompt was sent. `providers`
  reports the limit as `limits.max_running`.
- `status` lists queued and running jobs and counts the settled ones in
  `settled`; `all: true` lists them. Job views leave out empty fields, and
  `spawn` returns `push` only when pushing is not working.
- `file://` links in worker messages and final answers are rewritten to
  `path:line` relative to the job's working directory.
- The `review` and `research` contracts yield to an output format the prompt
  sets. The board contract asks for one- or two-sentence findings, forbids
  announcing a plan or skill, and narrows `DECISION:`.
- agy `read-only`: the worker is told it can read files by path and cannot
  search or use the shell, `providers` says the same, and a `denied` job names
  the likely cause and where its partial answer is.

## 0.1.0

- First release: an MCP server with Claude Code as the orchestrator and other
  agents' CLIs as workers. Providers: `codex` (OpenAI Codex CLI) and `agy`
  (Google Antigravity CLI, Gemini).
- Tools: `providers`, `spawn`, `wait`, `board`, `status`, `result`, `cancel`.
  `spawn` modes `ask`, `review`, `research`, and `handoff` append a reporting
  contract to the worker's prompt.
- Message board: every message a worker sends while it runs becomes a board
  entry, and new entries are pushed into the Claude Code session over its inbox
  socket.
- MCP 2026-07-28 and 2025-11-25 on one process; the Tasks extension for `wait`;
  the Skills extension serving `delegate`, `review`, `research`, `handoff`;
  `outputSchema` and `structuredContent` on every tool.
