---
name: research
description: Send another model on a deep web pass to compare approaches and tradeoffs for a problem, using crew spawn with mode research. Use only when the user asks Codex, Gemini, or agy by name to survey options, gather sources, or bring external context; a research request that names none of them is yours to do.
---

# Research: a cited comparison of approaches

`spawn` with `mode: "research"`. The worker runs read-only with web search: it searches, reads the repo for context, and reports what approaches exist and what each one costs. It changes nothing.

## What to send

State the problem, not a keyword. Include what narrows the answer:

- the stack and versions in play,
- what the solution has to interoperate with,
- what has already been ruled out and why.

The mode appends a research contract: actually search the web and cite primary sources with URLs, surface at least three distinct approaches including the boring one and doing nothing, compare them in a tradeoff table, date the evidence and flag what could not be confirmed as current, separate observed facts from inference, and close with one recommendation plus the condition that would flip it.

## While it runs

A research pass takes minutes. Findings arrive on the board as the worker establishes them. If an early finding settles the question, `cancel` the job instead of waiting for the full report.

## Reporting

- Keep the structure: approaches, tradeoff table, sources, open questions, recommendation.
- Keep every citation and every uncertainty marker. A tradeoff stripped of its source is an opinion.
- Do not implement anything from the research until the user asks.
