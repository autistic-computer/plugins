// Prompt contracts. Each one trails the worker's prompt: it governs how the
// worker reports, which is the last thing it does, and it must not push the
// actual request out of the lead.

// Each rule exists because a worker broke it in a real run and a clean "all
// gates green" report hid the damage: a ClickHouse syntax error behind an
// env-gated test that self-skipped in 0.00s; a `cargo check` that passed
// against a vendored submodule the build doesn't consume; a fix compiled only
// with its test feature on, breaking the production build; and two retired SQL
// views faithfully recreated from a spec that had gone stale. A worker cannot
// be trusted to self-certify, so make it show its work instead.
const HANDOFF_CONTRACT = [
  "[verification contract]",
  "- A gate you did not run is not a gate. For every build, lint, or test you claim passed, give the exact command and its exit code. If you did not run it, write \"not run\".",
  "- A test that did not execute is not a pass. Report env-gated, filtered, or skipped tests as SKIPPED even when the suite is green; a near-zero runtime means it never ran. A gate that needs a service, credential, or env var you do not have is BLOCKED: say which one.",
  "- Name what you compiled: the exact package/target and the feature flags. If the code has feature-gated paths, also build the configuration that ships to production, not only the one your change compiles under.",
  "- If the task references a file, symbol, table, or migration that is missing from the working tree (unless the task asks to create it), stop and report the discrepancy. Do not recreate retired objects to satisfy a stale spec.",
  "- Report every deviation from the task. Do not widen scope, and do not edit files the task did not name."
].join("\n");

// A brief that sets its own output format used to get both: reviewers handed a
// PASS/FAIL template answered "**SOUND** (`VERDICT: PASS`)" and appended the
// contract's alternative and change-my-mind sections to it. The brief wins.
const FORMAT_YIELDS =
  "- The request above wins on format. If it sets its own verdict words, sections, or layout, use those and add none from this contract; the rules below then govern only how you check and argue.";

// Review is a second opinion on a plan, idea, or proposal, not a diff walk.
// The failure mode of an LLM reviewer is polite agreement: it restates the
// proposal back with adjectives and calls it sound. So demand a verdict, a
// severity-ordered list of concrete breakages, and a stated condition that
// would change its mind.
const REVIEW_CONTRACT = [
  "[review contract]",
  FORMAT_YIELDS,
  "- Open with a verdict: SOUND, SOUND WITH CHANGES, or DON'T DO THIS. Then justify it. Do not restate the proposal back.",
  "- Ground it in this repo. If the proposal names a file, symbol, table, dependency, or command, check it exists at HEAD and say so when it does not.",
  "- Separate what you verified from what you assumed. Label every unverified claim as an assumption.",
  "- Order problems by severity, and give each a concrete failure: the input, state, or sequence that makes it break. Cut anything you cannot make concrete.",
  "- Name the simplest alternative that reaches the same outcome, including doing nothing, and say why the proposal beats it or does not.",
  "- End with what would change your mind. Agreement with no stated reason is not a review."
].join("\n");

// Research is the deep web pass: what approaches exist, what they cost, which
// one fits. Left unconstrained the model answers from memory and calls it
// research, so make the web pass and the tradeoff comparison explicit, and
// force it to date what it found.
const RESEARCH_CONTRACT = [
  "[research contract]",
  FORMAT_YIELDS,
  "- Actually search the web. Prefer primary sources (docs, specs, changelogs, issue threads, benchmarks) over blog summaries, and cite each claim with a URL.",
  "- Surface at least three genuinely distinct approaches, including the boring one and doing nothing. If fewer than three exist, say why.",
  "- Compare them in a table on the axes that decide this call: complexity, failure modes, operational burden, cost, and how reversible each is.",
  "- Date your evidence. Libraries and APIs move; give the version or date you checked and flag anything you could not confirm is current.",
  "- Separate observed facts from inference, and list the open questions you could not close.",
  "- End with one recommendation and the condition that would flip it."
].join("\n");

// The orchestrator reads worker messages as they arrive, not only the final
// answer. Without this a worker saves everything for the end and the board is
// empty until the run is over; with it unconstrained, the board fills with
// "now I will read the file" narration. Ask for the first, forbid the second.
//
// Measured over 19 jobs: every Codex run opened with "DECISION: I'll use the
// pr-review skill", and used DECISION for each check that found nothing. So a
// mid-run message is for what the orchestrator can act on, in a sentence or
// two; everything else waits for the final answer, which is read once.
const BOARD_CONTRACT = [
  "[board contract]",
  "- An orchestrator reads each message you send as you send it, not only your final answer.",
  "- The moment you establish something it can act on, say so in one or two sentences, then keep working: the claim and where it is. Lead that message with FINDING:, BLOCKED:, or QUESTION:. The detail belongs in the final answer.",
  "- One message per real result. Do not narrate routine steps, report a check that found nothing, or announce your plan, your approach, or which tool or skill you will use.",
  "- Lead with DECISION: only when you pick between real alternatives in a way the orchestrator might overrule.",
  "- Cite files as `path:line` relative to the working directory, never as file:// links or absolute paths.",
  "- Your last message is the complete final answer and must stand on its own; do not assume earlier messages were read."
].join("\n");

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

export const MODES = {
  ask: { contract: null, access: "read-only", summary: "free-form question, no reporting contract" },
  review: { contract: REVIEW_CONTRACT, access: "read-only", summary: "second opinion on a plan, idea, or proposal" },
  research: { contract: RESEARCH_CONTRACT, access: "read-only", summary: "deep web pass comparing approaches" },
  handoff: { contract: HANDOFF_CONTRACT, access: "workspace-write", summary: "implement a task in the repo" }
};

export const ACCESS_LEVELS = ["read-only", "workspace-write", "full"];

export const SPEEDS = ["fast", "ultrafast"];

/** Assemble what the worker actually receives: request, mode contract, provider note, board contract. */
export function composePrompt({ prompt, mode, providerNote = null }) {
  const parts = [String(prompt ?? "").trim()];
  if (MODES[mode]?.contract) {
    parts.push(MODES[mode].contract);
  }
  if (providerNote) {
    parts.push(providerNote);
  }
  parts.push(BOARD_CONTRACT);
  return parts.join("\n\n");
}
