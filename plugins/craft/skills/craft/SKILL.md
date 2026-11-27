---
name: craft
description: >-
  House engineering rules for code in any language: modeling with types,
  failures, assertions, control flow, effects, naming, dependencies, changing
  existing code and tests, plus a stricter register for core code (state
  machines, parsers of untrusted input, wire and disk formats, daemons, hot
  paths) covering bounds, allocation, determinism, performance and data
  layout. Use whenever writing, refactoring or reviewing code, and for
  `/craft review <target>` or `/craft check`. Language skills such as `rust`
  build on it.
argument-hint: "[review <target> | check]"
---

# Craft

Rules for writing and changing code in any language. Three goals are ranked,
and the rank settles a conflict between two rules: **safety, then performance,
then developer experience.**

- The repo's AGENTS.md outranks this skill.
- This skill states principles. A language skill (`rust`) gives the spelling:
  the API, the lint, the library. Where it says a rule is spelled differently
  or does not apply in that language, it wins.
- Application code is not library code. A library has users outside its repo
  and earns a careful interface. Application code stays direct: concrete types,
  no extension points nobody asked for, nothing general on speculation.

## Two registers

**Always** rules apply to all code. **Core** rules apply on top of them to code
where a failure corrupts state or where the cost is paid per item:

- a state machine other code depends on
- a parser of input the program does not control
- a wire or disk format
- a daemon, or any loop that runs for the life of the process
- a hot path that was measured or budgeted as one

If the repo's AGENTS.md names its core crates or modules, that list is the
answer. Otherwise judge by the list above, per module, not per file. UI, glue,
scripts and tooling are not core. Core rules cost more than they buy there;
skipping them in core code is a defect.

## Always

### Model with types

- Make invalid states unrepresentable. Fields that are only valid together, or
  one that only means something when another is set, are one sum type, not two
  fields and a convention.
- Validate once, at the boundary, in a constructor that can fail. Past it the
  type is the proof and nothing checks again.
- Private by default, widened only as far as a caller needs. A field that
  takes part in an invariant is never public.
- Absence uses the language's absence type, never a sentinel (`-1`, `""`, `0`).
- Give distinct types to values that must not mix: units, ids, and the trio of
  index (a position from zero), count (how many) and size (bytes). An alias
  does not stop them mixing.
- No boolean parameters. A two-case enum reads at the call site and can grow a
  third case. Two parameters of the same type go in a struct with named
  fields, so they cannot be swapped. Named fields over positional ones.
- Converting to a narrower or differently signed representation is checked.
  No cast that can drop bits silently.
- Division says how it rounds (exact, floor, ceiling). Arithmetic that can
  overflow says what happens then (checked, wrapping, saturating).
- Options that decide safety, durability or ordering have no defaults: every
  field is written where the options are built, so a new field breaks the
  build instead of taking a value nobody chose. Convenience options may
  default.
- Return the simplest type that works: nothing, a boolean, a value, a
  maybe-value, a value-or-error. Every caller pays for each step up.

### Failures

- Three kinds, kept apart. **Absence** is normal and uses the absence type.
  A **recoverable failure** comes from outside the program (I/O, malformed
  input, a peer) and goes to a caller that can act on it. A **broken
  invariant** is a bug, and the program stops.
- Don't return an error for a bug: no caller can act on it and it hides the
  defect. Don't crash on bad input: anyone who can send input can then stop
  the program.
- Handle every failure. No discarded result, no empty catch, no default
  substituted quietly, no log-and-carry-on unless carrying on is correct.
- An error says what failed and why: the operation, the value involved (path,
  line, id) and the underlying cause. Never a secret.
- Crashing is not control flow. Don't raise and catch to leave a loop or to
  signal an expected case, and don't catch a crash in order to continue. The
  one place to catch is a host boundary (FFI, a plugin host, one request of a
  server), to translate the crash and then stop or restart cleanly.
- A library returns typed errors its caller can match on and exposes no
  failure detail the caller cannot use. An application has one error type and
  adds context at each level.
- Cleanup is paired with acquisition, runs on every exit path, never fails
  and never blocks. Teardown that can fail (flush, close, commit) is an
  explicit call that returns the failure.

### Assertions

- Assert what the types cannot express: preconditions on arguments,
  postconditions on results, invariants between fields. An assertion is a
  contract that runs.
- Never assert what a type already guarantees, what the previous line just
  established, or a condition on outside input. Never add one to reach a
  count. An assertion that cannot fail hides the ones that can.
- One condition per assertion, so a failure names its cause.
- Assert the negative space too: what must not happen. For an implication,
  branch on the premise and assert the conclusion.
- A failure prints the values involved: use the form that shows both
  operands, or a message with them. Don't restate the condition as the
  message. Never print a secret.
- Assertions run in production builds. One measured as too slow for its path
  may be debug-only, and the commit message says so.

### Control flow

- Handle the negative space or assert it. A condition with no `else` must be
  one where doing nothing is correct. An early return in a guard counts as
  handling.
- Split a compound condition when its combinations lead to different places:
  nested branches, or a match over the pair, so each combination is visible.
- State conditions positively: `index < length`, not `!(index >= length)`.
- Match closed sets exhaustively, with no catch-all over your own enum: a new
  case should fail to compile, not fall through.
- Push `if`s up and `for`s down. A parent decides and owns the state change;
  helpers loop and compute, and don't branch on a mode passed in.
- Declare a variable where it is first used, in the smallest scope, and never
  reuse it for a second purpose. The further a check sits from the use it
  protects, the more can change in between.
- Bound all work that outside input drives: a length, a count, a stream, a
  retry. Past the bound, reject with an error, process a batch and keep the
  rest, or drop and count. Never truncate silently.

### Effects

- No hidden global state. What a function reads or changes arrives through
  its parameters.
- Code that needs the time, randomness or I/O takes them as inputs, so a test
  can supply fixed ones.
- Nothing observable depends on the iteration order of an unordered map. Sort,
  or use an ordered map, before output, hashing or serializing.
- A library does not print, read the environment, spawn threads or background
  tasks, or start a runtime. Its caller hands those in.
- Log structured events through the project's logging library, not print
  statements; a CLI's own output is the exception. Never log a secret.

### Names and layout

- Name things for the domain: nouns for things, verbs for actions. `Manager`,
  `Handler`, `Service`, `Factory`, `Helper` and `Util` name nothing; say what
  the thing is.
- No abbreviations beyond the names the standard library or the domain already
  uses (`len`, `iter`, `id`, `fd`): `message` not `msg`, `connection` not
  `conn`.
- Most significant word first, units and qualifiers last: `latency_ms_max`,
  `latency_ms_min`, `buffer_size_bytes`. Related names then sort together,
  and no quantity is missing its unit.
- A name says what a value is for, not its type: `frame_scratch`, not `buf`.
- A helper with a single caller carries the caller's name:
  `read_sector_validate` under `read_sector`.
- Don't repeat a module's name inside it.
- Callbacks go last. Otherwise call-specific parameters first and ubiquitous
  context (logger, allocator) last, in the same order everywhere.
- A file reads top-down: entry point or primary type first, callers above
  the helpers they call.
- A number or string with meaning becomes a named constant.
- Scripts and task-runner recipes spell flags long: `--force`, not `-f`.
- The formatter owns formatting.

### Tools and dependencies

- Before handing back: the formatter, the linter with warnings as errors, and
  the tests. Fix what they report.
- Fix a lint rather than silence it. When it is wrong for one item, suppress
  it on that item, with a reason, in the form that warns once the suppression
  is stale if the language has one.
- Warnings-as-errors belongs in the check command, not in source, where a new
  toolchain's new warning breaks the build.
- A dependency costs supply-chain exposure, build time and behavior nobody
  here read. Reach first for what the repo already depends on, and never add
  a second library for a job one already does.
- Applications commit their lockfile.
- Use the repo's task runner and scripts as they are.

### Changing existing code

- Behavior stays identical unless changing it is the task: the same
  operations, the same failure semantics, the same output bytes.
- Keep a quirk you don't understand and flag it. Don't fix it quietly.
- Fix every instance of the smell the task is about, not the cheap ones.
- A signature that has to change is called out, before and after.
- The why lives in the commit message: the reasoning and the invariant, not
  a restatement of the diff.

### Tests

- Few, each one assertive: exact expected values, for behavior that matters
  or a bug that happened.
- Test observable behavior and properties (round-trips, ordering,
  idempotence). Not restated constants, mirrored branches, wiring or what the
  compiler checks.
- A real bug gets a test that failed before the fix.
- Tests are deterministic: fixed time, seeded randomness, no network.
- Fuzz any parser of untrusted input.

### Concurrency

- Prefer passing messages to sharing state.
- When state is shared: data bound by one invariant sits under one lock, a
  lock is held for a few lines, no code you don't control runs while it is
  held, and a held lock is never returned to a caller.

## Core

On top of everything above, for core code only.

### Assertions

- Every function checks the preconditions it relies on and the postcondition
  it promises, wherever its types do not already carry them.
- Pair assertions: check a property that matters on two independent paths,
  such as before the write and after the read back, or at the sender and at
  the receiver.
- Assert at compile time what is known at compile time: relations between
  constants, and the size and alignment of anything with a fixed layout.

### Bounds

- No recursion on a depth the input controls: use an explicit stack with a
  named capacity. Recursion over a fixed, asserted depth is fine.
- Every loop has an upper bound a reader can point to. A loop meant to run
  for the life of the process is written as one, in one place.
- Every queue, buffer, collection, batch and level of concurrency has a named
  maximum. When one is full the producer waits or the drop is counted.
- Don't do unbounded work per external event, and don't start a task per
  event. Buffer events in a bounded queue and drain a bounded batch per tick:
  the program sets its own pace.
- A function is at most 70 lines. Split where control flow splits: the parent
  keeps the branching, helpers take the straight-line work.

### Memory

- Allocate at startup. Nothing allocates, grows or frees on the steady-state
  path. That takes allocation failure, fragmentation and allocator latency
  out of the running system and forces every size to be decided up front.
- Hot-path functions write into buffers their caller owns; they don't return
  fresh ones.
- A reused buffer is cleared past what was written. Stale bytes otherwise
  leak into output and make hashes differ.
- Data that is stored or sent has fixed-width integers and an explicit
  layout: no platform-sized fields, no implicit padding.

### Determinism

- Core logic is a state machine that performs no I/O itself, in one of two
  shapes. It takes events and the current time and returns commands for a
  shell to carry out, which replays from a log as is. Or it takes its I/O,
  clock and randomness as parameters on each call, which runs against
  simulated implementations.
- Either way those are never stored in core state, reached through a global,
  or read ambiently. Same inputs, same outputs, same order: that is what
  makes simulation, fuzzing and replay possible.

### Performance

- Performance is decided at design time: the design is worth about 1000x,
  the implementation 10x, tuning 2x.
- Before building, sketch the load against network, disk, memory and CPU, for
  bandwidth and latency. Order-of-magnitude numbers are enough to find the
  bottleneck before code exists.
- Optimize the slowest resource first (network, disk, memory, CPU), weighted
  by how often each is hit.
- Keep the control plane apart from the data plane. Setup validates hard and
  precomputes; the data path trusts that and works in batches.
- Batch to amortize: one syscall, one lock, one flush per batch, not per item.
- Lay data out for the hot loop: contiguous storage, index handles instead of
  pointers, nested containers flattened, cold fields split away.
- Extract a hot loop into a standalone function over plain values and arrays,
  so nothing aliases and a reader sees everything it touches.
- Design the layout up front. Micro-optimize only what a benchmark shows.

## Review and check

- `/craft review <target>`: follow [references/review.md](references/review.md)
  and produce its report. A review reports; it changes no code unless asked.
- `/craft check`: the same pass over the active file or the current diff,
  findings only, one line each: `severity | file:line | rule | issue`.

## References

- [references/safety.md](references/safety.md): assertions, failures, bounds
  and determinism in depth. Read before writing or reviewing core code.
- [references/performance.md](references/performance.md): the budget sketch,
  data layout patterns, batching, hot loops. Read before designing a data
  structure or a hot path.
- [references/review.md](references/review.md): the review method, severity
  and report format.
