# Review

One method for reviewing code in any language. The output is a report. The
reader decides what to change; rewrite only when asked.

## 1. Scope

- **What to read.** Exactly what was pointed at: a file, a module, a crate, a
  diff. For a diff, the changed lines and the callers they affect, not the
  whole file.
- **Register.** Say whether the code is core, and why, at the top of the
  report. Core rules are not findings against glue code.
- **Library or application.** A library's interface is held to the strict
  rules. Application code is held to directness instead.
- **Limits.** The language edition and toolchain the project pins, so no
  finding recommends something the project cannot use.

## 2. Tools

Run the project's formatter, linter and tests in check mode and fold the
results in. Never run a formatter that rewrites files during a review. Don't
paste raw tool output: group repeated warnings into one finding and skip the
ones that do not matter here. If the tools are unavailable, say so and review
by reading.

## 3. Reading order

The first two are where real bugs live. Work through all of the first before
starting the second.

1. **Correctness.** Undefined or unsound behavior. A crash reachable from
   outside input. Unbounded work driven by outside input. A broken contract
   between two pieces of code. Lock and ordering hazards. In core code, any
   core rule whose breach can corrupt state.
2. **Failures.** A failure swallowed. An error that lost its cause or the value
   that failed. A crash used for an expected case, or a bug reported as an
   error.
3. **Interface.** Types that allow invalid states. Boolean and swappable
   parameters. Things public that should not be. Names that mislead. For a
   library, anything that becomes a breaking change once published.
4. **Idiom and clarity.** What the language skill lists. Naming, layout,
   leftover generality.
5. **Tests.** Logic that matters with no test. Tests that restate constants or
   depend on time, order or the network.

## 4. Findings

- **Location** for every finding, as `file:line`. Use `whole file` when there
  is no single place.
- **Rule**, by skill and section: `craft: failures`, `rust: ownership`.
- **Consequence**, concretely: what input or sequence goes wrong and how.
  A finding without a consequence is a preference.
- **Fix** as code, limited to the lines that change. Not a rewritten function.
- **Group repeats.** One finding for eight discarded results, listing the
  lines.
- **Respect intent.** Something that looks deliberate goes under Consider with
  the trade-off, never under Must fix.
- **Stay proportionate.** Five to ten findings for a short file. Don't pad the
  list, and don't bury a real bug among style notes.

## 5. Severity

| Level | Meaning |
|---|---|
| Must fix | A bug, unsound code, a reachable crash, unbounded work from outside input, a swallowed failure, or an interface mistake that turns into a breaking change. In core code, a breached core rule that can corrupt state. |
| Should fix | It works, and it breaks a rule at a real cost: a worse error, harder testing, a confusing interface, a core rule breached without corruption risk. |
| Consider | Naming, layout, polish, and deliberate choices worth a second look. |

Rank by demonstrated consequence, not by which rule was broken.

## 6. Report

```markdown
# Review: <what was reviewed>

<One paragraph: what the code does, core or not, library or application, the
verdict, the single most important thing to fix, and which tools ran.>

## Must fix
### 1. <Short title> (`path/file:42`)
**Rule:** <skill: section>
**Problem:** <what goes wrong, for which input, in one or two sentences>
**Fix:**
<the smallest change, as code>

## Should fix
### 2. ...

## Consider
### 3. ...

## Already good
- <two to four specific things worth keeping>
```

"Already good" is required. It tells the author what to keep and makes the rest
credible.

## 7. Check mode

`check` runs the same pass over the active file or the current diff and prints
findings only, most severe first, one line each:

```text
must | src/queue.rs:88 | craft: bounds | queue grows with input, no maximum
should | src/queue.rs:41 | rust: errors | map_err drops the io error
```

No summary, no "already good", no fixes.
