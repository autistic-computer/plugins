<picture>
<source media="(prefers-color-scheme: dark)" srcset=".github/bird-dark.svg">
<img align="left" src=".github/bird-light.svg" width="152" height="168" alt="">
</picture>

<table>
<tr>
<td>
<samp>
---<br>
name: plugins<br>
description: claude code plugins<br>
status: slopware<br>
license: apache-2.0<br>
version: 0.2.0<br>
---
</samp>
</td>
</tr>
</table>

<br clear="left">

Claude Code plugins for autistic.computer, served as one plugin marketplace: crew runs Codex and Gemini as background workers, okf keeps Open Knowledge Format knowledge bundles, craft holds the house rules for writing and reviewing code, with a Rust register on top, and narrow turns a half-formed idea into a settled one.

## <samp>install</samp>

```
/plugin marketplace add autistic-computer/plugins
/plugin install crew@autistic-computer
/plugin install okf@autistic-computer
/plugin install craft@autistic-computer
/plugin install narrow@autistic-computer
```

| plugin | what it holds | docs |
| --- | --- | --- |
| `crew` | an MCP server that runs Codex and Gemini as workers, and the `delegate`, `review`, `research` and `handoff` skills | [docs/crew.md](docs/crew.md) |
| `okf` | the `okf` skill and its CLI for knowledge bundles | [docs/okf.md](docs/okf.md) |
| `craft` | the `craft` skill for code in any language and the `rust` skill built on it | [craft](plugins/craft/skills/craft/SKILL.md), [rust](plugins/craft/skills/rust/SKILL.md) |
| `narrow` | the `narrow` skill, a conversation that goes wide on an idea and narrows it in at most three rounds | [narrow](plugins/narrow/skills/narrow/SKILL.md) |

## <samp>develop</samp>

```
node --test tests/*.test.mjs
python3 tests/test_okf.py
claude plugin validate .
```

An installed plugin updates only when its `version` changes, so bump it in the plugin's `.claude-plugin/plugin.json` with every change that ships.

<a href="https://autistic.computer"><kbd> /{&gt; autistic.computer </kbd></a>
