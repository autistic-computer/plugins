# okf

A skill, and the CLI it drives, for [Open Knowledge Format](https://github.com/open-knowledge-format/open-knowledge-format) v0.3 knowledge bundles. A bundle is a directory of markdown files with YAML frontmatter, usually `knowledge/` at the project root and versioned with the code. Each file is one concept: a table, an API, a metric, a playbook.

With the skill loaded, an agent writes concepts in a consistent shape, keeps indexes and logs current, checks the bundle against the spec, and reads the bundle before it rebuilds context from source.

## Requirements

- **Python 3.9 or later with PyYAML**, or **uv**, which installs PyYAML on the fly from the script's inline metadata.
- **Git**, optional. `validate --check-sources` compares sources with their last commit, and `migrate` uses it to find the repo root.
- **Network**, only for Mermaid diagrams in a rendered site. Offline they fall back to source text.

## Install

As a Claude Code plugin:

```bash
claude plugin marketplace add autistic-computer/plugins
```

```bash
claude plugin install okf@autistic-computer
```

The marketplace is named `autistic-computer`. The skill loads as `okf:okf`.

As a plain skill, in any agent that reads `SKILL.md`:

```bash
git clone https://github.com/autistic-computer/plugins
```

```bash
ln -s "$PWD/plugins/plugins/okf/skills/okf" ~/.claude/skills/okf
```

Point the link at your agent's own skills directory if it is not Claude Code.

## Use

Ask for what you want: "start a knowledge bundle for this repo", "document the orders table", "what does the bundle say about revenue?". The skill triggers when the project has a `knowledge/` folder or when you name OKF or a knowledge bundle.

The CLI also works by hand:

```bash
python3 plugins/okf/skills/okf/scripts/okf.py init knowledge --title "Shop Knowledge"
```

| command | what it does |
| --- | --- |
| `init` | Scaffold a bundle with a root `index.md` that declares the spec version |
| `new` | Create a concept with frontmatter and conventional headings |
| `index` | Regenerate every `index.md` listing, leaving the prose around it alone |
| `log` | Append a dated entry to `log.md` |
| `validate` | Check conformance and conventions; `--check-sources` flags concepts whose sources changed after them |
| `migrate` | Rewrite a v0.1 or v0.2 bundle to v0.3, dry run by default |
| `due` | List dated directories that are over budget, with fold candidates |
| `list` | Survey concepts with status, trust tier and freshness |
| `search` | Rank concepts by text match |
| `show` | Print one concept, with its links and backlinks on request |
| `context` | Build a capped context pack: a seed concept and its linked neighbors |
| `render` | Pack the bundle into one self-contained HTML site |

Run any command with `-h` for its options. [SKILL.md](../plugins/okf/skills/okf/SKILL.md) has the authoring conventions, and [spec.md](../plugins/okf/skills/okf/references/spec.md) is a condensed reference of the format.

## Layout

| path | what it is |
| --- | --- |
| `plugins/okf/.claude-plugin/plugin.json` | the plugin manifest |
| `plugins/okf/skills/okf/SKILL.md` | the skill |
| `plugins/okf/skills/okf/scripts/okf.py` | the CLI |
| `plugins/okf/skills/okf/scripts/upstream/` | the spec's own validator and scanner, unchanged |
| `plugins/okf/skills/okf/references/spec.md` | condensed reference of the spec |
| `plugins/okf/skills/okf/assets/concept.template.md` | the shape a hand-written concept follows |
| `tests/test_okf.py` | end-to-end tests that run the real CLI |

## Developing

```bash
python3 tests/test_okf.py
```

```bash
claude plugin validate plugins/okf
```

```bash
claude --plugin-dir plugins/okf
```

- `scripts/upstream/` is never edited. When the spec moves, replace both files together and update the commit in [NOTICE.md](../NOTICE.md).
- `SKILL.md` finds the CLI through `${CLAUDE_SKILL_DIR}`, so nothing in it names an install path.
- An installed plugin updates only when `version` changes. Bump it in `plugins/okf/.claude-plugin/plugin.json`.

## License

Apache-2.0. Third-party code and its notices are in [NOTICE.md](../NOTICE.md).
