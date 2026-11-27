---
type: <REQUIRED, e.g. BigQuery Table, API Endpoint, Metric, Playbook, Reference>
title: <human-readable display name>
description: <one sentence, appears in index listings and search snippets>
resource: <URL or path of the one asset this describes; omit for abstract concepts>
tags: [<tag>, <tag>]
generated: { by: agent/1, at: "2026-06-28T00:00:00Z" }
sources:
  - id: <short-key>
    resource: <URL, or a path from this file such as ../../src/orders.rs>
    title: <label>
---

# Overview

<What this is, in a few sentences. Attribute a claim to a source with its id.[^short-key]>

# Schema

<For data assets, a column/field table. Delete this section if not applicable.>

| Column | Type | Description |
|--------|------|-------------|
| `id`   | STRING | ... link a neighbor as [other](other.md) or from the bundle root as [other](/path/other.md) |

# Examples

<Concrete usage, often fenced code blocks. Delete if not applicable.>

[^short-key]: <label>
