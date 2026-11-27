---
name: okf
description: Author, maintain, and read Open Knowledge Format (OKF v0.3) knowledge bundles. Use when the project has a 'knowledge' folder, or when asked for OKF or a knowledge bundle; disregard otherwise.
---

# OKF toolkit

A bundle is a directory tree of markdown files with YAML frontmatter. A `.md` file is a concept
when its frontmatter has a non-empty `type`; a file without one is skipped, not an error. The only
conformance failures are frontmatter that does not parse and a malformed `index.md` or `log.md`.
Everything else is convention. Full rules: `references/spec.md` (not needed for routine authoring).

## The script

Use `scripts/okf.py` for the mechanical work instead of hand-rolling. It needs PyYAML: `python3`
works where PyYAML is installed, and `uv run` installs it on the fly.

The skill is installed apart from the user's project, so point `OKF` at the script in the skill's
own directory:

```
OKF="${CLAUDE_SKILL_DIR}/scripts/okf.py"
python3 "$OKF" validate                          # or: uv run "$OKF" validate
```

If that path still reads as a `${...}` placeholder, use the skill's base directory instead (the
harness gives it when the skill loads).

| Command | What it does |
|---------|--------------|
| `okf.py init [dir] --title T [--description D]` | Scaffold a bundle (default dir: `knowledge/`) with a root `index.md` that declares `okf_version: "0.3"`. |
| `okf.py new <path> --type "..." [--title --description --resource --tags --by]` | Create a concept with frontmatter and conventional headings. `--type` is required. In a dated dir (`learnings/`, `research/`, `plans/`, `specs/`) it also prints the closest existing concepts: a strong match means update that one instead. |
| `okf.py index [dir]` | Regenerate every `index.md` listing. Idempotent; only rewrites the sentinel-fenced block and keeps the root frontmatter as written. |
| `okf.py log "message" [--kind Update\|Creation\|Deprecation] [--dir scope]` | Append a dated entry to `log.md`, newest first. |
| `okf.py validate [dir] [--check-sources]` | Check conformance. Exit 1 with `ERROR` lines; `WARN` lines carry the upstream finding code (`W105`, `W116`, ...) plus this skill's conventions and dated-dir budgets. `--check-sources` warns when a `resource` or `sources` path is missing or changed in git after the concept. |
| `okf.py migrate [dir] [--write] [--by ACTOR]` | Rewrite a v0.1 or v0.2 bundle to v0.3. Dry run unless `--write`. See Migrating. |
| `okf.py due [dir]` | List dated dirs over budget with the oldest fold candidates (date, id, backlink count). Exit 1 when folding is due. |
| `okf.py render [dir] [-o OUT]` | Pack the bundle into one HTML file (default `<root>/site.html`). Mermaid fences render via a pinned CDN `mermaid.min.js` with SHA-384 SRI, falling back to source text offline. |

Commands find the bundle root by climbing to the topmost `index.md` (preferring one that declares
`okf_version`) and descend into a `knowledge/` child when run from the project root. Pass
`--bundle`/`[dir]` when the repo has unrelated `index.md` files.

## Authoring

### 1. New bundle

Default location is `knowledge/` at the project root, versioned with the code.

```
python3 "$OKF" init knowledge --title "<Project> Knowledge" \
  --description "<What the bundle covers and when to use it, in one sentence.>"
```

Group subdirectories by what makes the knowledge navigable (`tables/`, `metrics/`, `playbooks/`,
`references/`, `services/`). The tree is only grouping; links carry the real relationships.

### 2. Concepts

One concept is one `.md` file about one thing (a table, an API, a metric, a process). Prefer
headings, tables, and code fences over prose.

```
python3 "$OKF" new tables/orders \
  --type "BigQuery Table" \
  --title "Orders" \
  --description "One row per completed customer order." \
  --resource "https://console.cloud.google.com/bigquery?...&t=orders" \
  --tags "sales,orders,revenue"
```

`type` is a free string (`BigQuery Table`, `API Endpoint`, `Metric`, `Playbook`, `Reference`).
Keep it consistent within the bundle. Hand-written concepts should mirror
`assets/concept.template.md`.

### 3. Conventions (this skill's defaults)

- Fill `title` and `description`. `description` is one sentence and shows up in indexes and search
  snippets.
- `generated: { by, at }` records the last change to what the concept says. `new` stamps it. When
  you change the content, set `at` to now; leave it alone for typo, format, and link fixes.
- `by` is an actor. Use `agent/1` (the default) for anything an agent wrote, and `human:<id>` only
  when that person wrote or confirmed the text. Never put a model or product name in `by`.
- Lifecycle is `status: draft`, `stable` (the default when absent), or `deprecated`. Any other
  value reads as not current and drops out of `list --current`, so progress notes ("Built
  2026-10-28", "Shipped") go in `x-status-note`.
- To retire a concept keep the file, set `status: deprecated`, and point `superseded_by` at the
  replacement (`superseded_by: /metrics/gross-margin.md`). When you move or rename one, leave a
  short deprecated concept at the old path.
- Set `stale_after` to an absolute date only when a real review date is known. Stale means "check
  again", not "false".
- After checking a concept against its sources, append to `verified`:
  `- { by: "human:<id>", at: "<now>" }`. A check older than `generated.at` stops counting.
- Paths resolve the same way in links and in path fields (`resource`, `superseded_by`,
  `sources[].resource`): a leading `/` starts at the bundle root, anything else starts at the
  file's own directory. Both link forms are fine; relative links also render in GitHub and IDE
  previews. A leading `/` never means the repo root.
- Point at code outside the bundle with a path from the file: `resource: ../../crates/orders/src/repo.rs`.
- Put what a concept was derived from in `sources`, each with a short `id`, and cite a claim with
  a footnote that uses that id: `...sharded daily.[^ga4-schema]`. No `# Citations` list. Code the
  concept depends on goes there too, as a path from the file, so `--check-sources` can watch it.
- Name the relationship in the prose around a link ("joined with", "depends on").
- Your own frontmatter keys start with `x-`.
- Use `# Schema` and `# Examples` headings where they apply.
- Cite code by path plus a searchable symbol (`orders/repo.rs` `claim_next_order`), not line
  numbers. Line numbers only for immutable files (applied migrations, tagged snapshots).
- Stamp claims about progress ("pending", "shipped", "deployed") with a commit hash, date, or
  verify-by condition. Prefer describing observable behavior over implementation status.

### 4. Indexes and logs

After adding, moving, or renaming concepts:

```
python3 "$OKF" index
python3 "$OKF" log "Added orders, customers, revenue concepts." --kind Creation
```

`index` rewrites only the block between `<!-- okf:listing:start -->` and `<!-- okf:listing:end -->`;
prose above and below it is kept, and so is the root frontmatter (`okf_version`, `title`,
`description`, `license`).

### 5. Render (optional)

When someone wants to browse the bundle:

```
python3 "$OKF" render            # writes <bundle-root>/site.html
python3 "$OKF" render -o /tmp/knowledge.html
```

One self-contained file: searchable sidebar, rendered concepts with frontmatter chips and
links-to/linked-from footers, hash routing (`#/<concept-id>`), and a graph view. Re-run after
edits. Two things exist only in the site: a
Glossary page (`#/glossary`) built from the `- **Term**: definition` bullets (also `**Term:**`, or
`**Term**` followed by a dash) in each `type: Contract` concept's `## Vocabulary` section, and
`systems/start-here` and `systems/workspace-map` pinned first in every list.

### 6. Validate before finishing

```
python3 "$OKF" validate
```

Fix every `ERROR`. Treat `WARN`s as a checklist; each upstream one names its spec section. `INFO`
lines need no fix. A clean run prints `CONFORMANT (OKF v0.3)` and exits 0. Report the result.

## Migrating

A bundle whose root `index.md` declares `okf_version` below 0.3 still reads fine, and `validate`
says so. To move it:

```
python3 "$OKF" migrate            # dry run: what would change, and what needs a hand
python3 "$OKF" migrate --write
python3 "$OKF" index && python3 "$OKF" validate
```

It edits frontmatter line by line and touches nothing it does not change:

- `timestamp` becomes `generated: { by: agent/1, at: ... }` (`--by` picks another actor).
- A `status` outside the three values moves to `x-status-note`; one that starts with superseded,
  retired, or deprecated also sets `status: deprecated`, and one that starts with draft sets `draft`.
- A "(superseded)" title or "SUPERSEDED:" description sets `status: deprecated`, and `superseded_by`
  when the description or a short pointer body links exactly one concept.
- `resource` paths written from the repo root, or as an absolute path on one machine, become paths
  from the file. Body links that start at the repo root get the same fix.
- The root `index.md` gets `okf_version: "0.3"` and a `title`.

It lists what it leaves for you under "needs a hand": `# Citations` lists to turn into `sources`
with footnotes, deprecated concepts with no replacement named, and a root `index.md` with no
`description`.

## Compacting

`validate` warns when dated dirs exceed budget and `okf.py due` lists the backlog. When a pass is
due, or before trusting an old bundle:

1. **Pre-filter before reading.** Run `validate --check-sources`: a concept whose `resource` and
   `sources` paths have no commit after `generated.at` is almost certainly current; skip it.
2. **Verify before rewriting.** Live code beats the bundle. Each rewritten claim carries evidence
   derived at write time (symbol, commit hash). Don't copy old citations forward unchecked.
3. **Double-check destructive changes.** Before any fold, supersede, or delete, re-run
   `show <id> --links` and a repo-wide text search for the slug. At write time, skip any action
   whose evidence no longer holds.
4. **Promote before you drop.** Move surviving facts into the concept that owns them now. While
   backlinks exist, supersede to a 2-3 line pointer with `status: deprecated` and `superseded_by`.
   Delete only when backlinks and the text search are both empty.
5. **Split work safely.** Parallel workers need disjoint files, whole fold chains (source, target,
   every backlink holder) in one unit, and a `git status` check to avoid in-flight edits.
6. **Sweep external surfaces.** Retiring something concepts cite (changelog section, checklist
   item, ticket) orphans those citations; fix them in the same change.

Prefer small rolling passes triggered by `due` over big audits. The bundle's own compression
playbook, if any, overrides these defaults.

## Reading

When a project has a bundle, check it before rebuilding context from source. Survey, narrow, then
follow links. Don't load the whole bundle.

| Command | Use it to |
|---------|-----------|
| `okf.py list [--type T] [--tag X] [--current --stale --deprecated --unverified]` | Survey what exists (frontmatter only, cheap). Each line ends with the concept's state when it is not plain stable. |
| `okf.py search "<terms>"` | Find concepts by text; frontmatter matches rank above body, current concepts above deprecated ones. |
| `okf.py show <id> [--frontmatter] [--links]` | Read one concept; `--links` lists outbound links and backlinks. A deprecated or stale concept gets a `note:` on stderr. |
| `okf.py context "<id or terms>" [--depth N] [--budget C]` | Build a capped context pack: seed concept(s) plus linked neighbors. |

```
python3 "$OKF" search "orders revenue"
python3 "$OKF" show metrics/revenue --links
python3 "$OKF" context "revenue" --depth 1
```

`context` takes an id or search terms and returns the seed plus everything within `--depth` hops,
under `## <id>` headers, capped at `--budget` characters (default 20000). Clipping is reported on
stderr. A deprecated seed brings its `superseded_by` replacement along, and deprecated neighbors
are left out. `--backlinks` adds concepts that link to the seed; `--json` gives structured output.

How far to trust what you read:

- `deprecated`: use the replacement the line names.
- `stale`: the review date passed. Check it against its `resource` before relying on it.
- No trust tier shown means unverified: nobody recorded a check. `machine-confirmed` and
  `human-reviewed` appear only when a check is newer than the last content change.
- Before acting on a fact where being wrong is costly (limits, quotas, which library is in use,
  security and tenancy rules, column names), open the concept's `resource:` and confirm.
