---
name: review
description: Get a read-only second opinion from another model on a plan, idea, or proposal, using crew spawn with mode review. Use only when the user asks Codex, Gemini, or agy by name for a review, a sanity check, or a second opinion; a review request that names none of them is yours to do.
---

# Review: a second opinion on a plan

`spawn` with `mode: "review"`. The worker runs read-only: it can inspect the repo to check the proposal against reality, and it changes nothing.

This is an opinion, not an implementation. Do not fix, patch, or edit anything in the same turn.

The mode is built for a plan or proposal. To have a diff reviewed against your own checklist, with your own verdict line and sections, spawn with `mode: "ask"` and put the format in the prompt: the review contract brings its own verdict words and closing sections, and a worker given both formats answers both.

## What to send

- The proposal itself, in full. The worker cannot see this conversation.
- The constraints that matter: what it must not break, what already exists, what was ruled out and why.
- If the plan lives in a file, the path.
- For `agy`, every file it should check the plan against. Read-only agy cannot search the repo.
- How long the answer should be.

The mode appends a review contract: lead with a verdict (SOUND, SOUND WITH CHANGES, or DON'T DO THIS), check the proposal's claims against HEAD, label unverified claims as assumptions, order problems by severity with a concrete failure each, name the simplest alternative including doing nothing, and state what would change its mind.

## Two reviewers

For a decision that matters, spawn the same brief to `codex` and `agy` in one turn. Where they agree, you have a stronger signal. Where they disagree, show the user both positions rather than averaging them.

## Reporting

- Give the user each reviewer's verdict and problems as written, verdict first. Do not soften or summarize a disagreement away.
- Then stop. Ask what the user wants to do with the verdict before touching a file, including when the reviewer disagrees with a plan you wrote.
