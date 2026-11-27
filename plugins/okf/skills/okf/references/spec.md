# OKF v0.3: condensed reference

Source: <https://github.com/open-knowledge-format/open-knowledge-format/blob/main/SPEC.md>, read at
`527e81aff559` (2026-11-18). This is the subset the skill relies on. Upstream wins on any conflict.
Section numbers below are upstream's.

## 1. What OKF is

A format for knowledge about data and systems: a directory tree of UTF-8 markdown files with YAML
frontmatter. No schema registry, central authority, or required tooling. Goals: readable without
tools, parseable without SDKs, diffable in version control, portable across tools and orgs. Since
agents write and maintain most concepts, frontmatter also answers where a concept came from
(provenance), how far to trust it, whether it is still true (freshness), and whether it is the
current version (lifecycle).

## 2. Terminology

| Term | Meaning |
|------|---------|
| Knowledge Bundle | Self-contained directory tree of knowledge docs. Unit of distribution (git repo, tarball, or subdir). |
| Bundle root | Top directory of a bundle. Paths that start with `/` resolve from it. |
| Concept | One markdown document = one unit of knowledge (a table, API, metric, process, idea). |
| Concept ID | The file path within the bundle minus `.md`. `tables/users.md` is `tables/users`. |
| Asset | A file whose name does not end in `.md` (image, code). Not a concept. |
| Link | A standard markdown link from one concept to another; an untyped, directed relationship. |
| Path field | A frontmatter field whose value is a path or URI. |
| Actor | A string that says who or what did something (§7). |
| Extension key | A frontmatter key the spec does not define. |

Only the directory tree gives parent/child structure. Links are the graph.

## 3. Which files are concepts

1. A non-reserved `.md` file whose frontmatter has a non-empty `type` is a concept.
2. A `.md` file with no frontmatter or no `type` is not a concept. Consumers skip it, validators
   warn, conformance is unaffected. This lets `README.md`, `AGENTS.md`, `SKILL.md` live in a bundle.
3. Any non-`.md` file is an asset. It may be a link or path-field target.
4. Files and directories whose names start with `.` are not part of the bundle.
5. Consumers read only under the bundle root and do not follow symlinks out of it.

Reserved at every level: `index.md` (§8) and `log.md` (§9). Never concepts.

## 4. Frontmatter

The file starts with a line that is exactly `---`; the block ends at the next such line. It parses
as a YAML 1.2 mapping. No duplicate keys. Quote values that look like numbers or booleans
(`okf_version: "0.3"`). When editing a file, do not re-serialize values you did not change.

````yaml
---
type: <Type name>                  # REQUIRED, the only always-required key
title: <display name>
description: <one sentence>        # used in indexes, search snippets, previews
resource: <URI or path of the one asset this describes>
tags: [<tag>, <tag>]
status: stable                     # draft | stable | deprecated (§5.4)
superseded_by: /path/to/replacement.md
generated: { by: <actor>, at: "<timestamp>" }
verified:
  - { by: <actor>, at: "<timestamp>" }
stale_after: "<timestamp>"
sources:
  - id: <stable key>
    resource: <URL, bundle path, or a scope description>
    title: <label>
    author: <actor>
    usage_count: <n>
    last_modified: "<timestamp>"
usage_window: { from: "<timestamp>", to: "<timestamp>" }
---
````

- `type` is a free string. No registry; consumers treat unknown types as generic concepts.
- Extension keys are allowed at any level, including inside `sources` entries, `generated`, and
  `verified` entries. Consumers never reject unknown keys; producers keep keys they do not know.
  Future versions define no key starting with `x-`, so name your own `x-<producer>-<name>`.
- Body is CommonMark with GFM tables and `[^label]` footnotes. Conventional headings: `# Schema`,
  `# Examples`, `# Computation`. No section is required.

## 5. Provenance, trust, lifecycle

**Timestamps** (`generated.at`, `verified[].at`, `stale_after`, `sources[].last_modified`,
`usage_window.*`) take two forms only: a date-time with an offset (`"2026-06-30T14:00:00Z"`) or a
date (`"2026-06-30"`, meaning 00:00 UTC that day). Use the date-time form for `generated.at` and
`verified[].at`, since consumers compare them.

**`sources` (§5.1).** What the concept derives from. `resource` is required per entry: a URL, a path
(§6), or a scope description that cannot be followed ("all queries in project X"). `id` is the
stable key for per-claim attribution: cite a claim with a footnote whose label is that id
(`...sharded daily.[^ga4-schema]`). Do not keep a citation list in the body. `author`,
`usage_count`, `last_modified` are objective signals; the spec stores no credibility score. A
source that points at another concept is a graph edge.

**`generated` (§5.2).** How the current content was made. `by` is required. `at` is the time of the
last meaningful change; a format, whitespace, or link fix does not move it.

**`verified` (§5.2).** A list of `{ by, at }` events, both required; one bare mapping counts as a
list of one. Each records that someone or something confirmed the content against its sources.

**Trust tier (§5.3).** A verification is current when its `at` is at or after `generated.at`, or
when `generated` is absent. From current events only: none gives unverified; only non-`human:`
actors gives machine-confirmed; any `human:<id>` actor gives human-reviewed. An agent rewrite after
a human review drops the concept back until a human confirms again. Tiers are advisory.

**`status` (§5.4).** `draft` (not reviewed, maybe incomplete), `stable` (default when absent),
`deprecated` (kept for links and history). Any other value is not stable: filters for current
knowledge exclude the concept. `superseded_by` is one path to the replacement and only means
something with `status: deprecated`. To retire, keep the file and deprecate it. To move or rename,
leave a short deprecated concept at the old path that points at the new one.

**`stale_after` (§5.5).** An absolute instant. The concept is stale when now is at or past it.
Stale means check again, not false. Omit it when no review date is known. A value that does not
parse is never fresh.

## 6. Links and paths

One rule for link targets and path fields (`resource`, `sources[].resource`, `superseded_by`,
`computation`, `executor.resource`, `attester.resource`):

1. A value with a URI scheme (`https:`) is an absolute URL.
2. A value that starts with `/` resolves from the bundle root.
3. Any other value resolves from the directory of the file that contains it.

Both in-bundle forms are valid and neither is preferred. A value that resolves outside the bundle
root is external; consumers must not read it from the local file system. Percent-encode spaces.
Paths are case-sensitive. Broken links are tolerated: the target may be knowledge not yet written.
Only `[text](target)` and reference-style links count; `[[wikilinks]]` are not links.

The bundle graph has two kinds of directed edges: a link from concept to concept, and a path field
that resolves to a concept.

## 7. Actors

`generated.by`, `verified[].by`, and `sources[].author` hold an actor in one of two forms:

- `<producer>/<version>` for agents and tools.
- `<scheme>:<id>` for everything else: `human:<id>`, `team:<id>`, `process:<id>`. Other schemes are
  allowed and count as non-human.

Only `human:` earns the human-reviewed tier, so use it only for content a person wrote or confirmed.

## 8. index.md

A directory listing for progressive disclosure. May appear in any directory. Body is one or more
headed sections of `* [Title](relative-url) - description` entries; entries should carry the linked
concept's `description`. An index below the root has no frontmatter. The root index may carry bundle
metadata, and a tool that regenerates it must keep that frontmatter:

````yaml
---
okf_version: "0.3"
title: Acme retail analytics
description: Tables, metrics, and sanctioned computations for Acme retail. Use it for sales and margin questions.
license: CC-BY-4.0
---
````

`description` is what an agent with many bundles reads to pick one.

## 9. log.md

History of changes in its scope. May appear at any level. No frontmatter. A flat list of
date-grouped entries, newest date first. Date headings must be `## YYYY-MM-DD`. The leading bold
word (`**Update**`, `**Creation**`, `**Deprecation**`) is convention.

## 10. Attested computations

A concept with `type: Attested Computation` holds a sanctioned way to compute a value: `runtime`
(required), `parameters` (`{ name, type, required }`), the computation itself (one fenced block
under a `Computation` heading, or a `computation` path), an `executor` (`resource`, `receipt`
fields) and an `attester` (`resource`, deterministic code, no LLM). An agent supplies parameter
values only. Nothing is shown as attested without `runtime` and `attester`. The skill's validator
checks these fields; nothing else in the skill uses them yet.

## 11. Conformance

A bundle conforms when every frontmatter block under the root parses as a YAML mapping and each
reserved file follows §8 and §9. A `.md` file without `type` does not break conformance.

Consumers must resolve both link forms, never treat reserved files as concepts, never reject
unknown keys, never treat an unparseable `stale_after` as fresh, and compute trust tiers only from
current events. Null, empty string, and empty list all mean absent. Where a field is a list
(`tags`, `sources`, `verified`), one item counts as a list of one; a scalar `tags` value is one tag
and is not split at commas. Missing optional fields, unknown types, unknown keys, broken links, and
missing `index.md` files never fail a bundle.

## 12. Versioning and older bundles

`<major>.<minor>`. Before 1.0 a minor version may break things, with a documented fallback. A bundle
declares its version with `okf_version` in the root `index.md`. For a bundle that declares 0.2 or
earlier, or nothing, a consumer may:

- resolve a bare path field from the bundle root when it does not resolve from its file;
- read a legacy `timestamp` when `generated` is absent, and a legacy `# Citations` body list.

Deferred upstream: typed relationships, validity windows, a `refuted` verification event, and the
attestation runtime protocol.

## What this skill adds on top

Not part of the spec; `okf.py` and SKILL.md own these.

- Default actor `agent/1` for agent-written content. No model or product name in `by`.
- `x-status-note` for progress prose that used to sit in `status`.
- In a bundle that declares below 0.2, an unknown `status` value is left alone and the concept
  still counts as current, because `status` had no defined meaning there.
- Dated directories (`learnings/`, `research/`, `plans/`, `specs/`) with concept, line, and age
  budgets, reported by `validate` and `due`.
- `validate --check-sources`: `resource` and `sources` paths, including ones outside the bundle,
  checked against the last git commit that touched them. It is an author's check on their own
  repo, off by default.
- `search`, `context`, and `render`.
