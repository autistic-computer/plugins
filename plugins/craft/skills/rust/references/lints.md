# Lints and profiles

Ready to paste. Checked against the pinned toolchain.

## House table

In the workspace `Cargo.toml`. A single-crate repo uses `[lints.rust]` and
`[lints.clippy]` instead.

```toml
[workspace.lints.rust]
unsafe_code = "deny"

[workspace.lints.clippy]
all = { level = "warn", priority = -1 }
pedantic = { level = "warn", priority = -1 }
missing_panics_doc = "allow"
missing_errors_doc = "allow"
must_use_candidate = "allow"
wildcard_imports = "allow"
enum_glob_use = "allow"
struct_field_names = "allow"
items_after_statements = "allow"
too_many_arguments = "allow"
too_many_lines = "allow"
result_large_err = "allow"
assert_is_empty = "allow"
unused_async_trait_impl = "allow"
cast_possible_truncation = "allow"
cast_possible_wrap = "allow"
cast_precision_loss = "allow"
cast_sign_loss = "allow"
float_cmp = "allow"
struct_excessive_bools = "allow"
type_complexity = "allow"
used_underscore_binding = "allow"
unused_self = "allow"
```

Each member crate opts in:

```toml
[lints]
workspace = true
```

The gate runs clippy with `-D warnings`, so every warning here is an error at
hand-back.

## Core block

At the top of a core crate's `lib.rs` or `main.rs`:

```rust
#![warn(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::too_many_lines,
    clippy::let_underscore_must_use,
    clippy::unwrap_used,
    clippy::undocumented_unsafe_blocks
)]
```

It is an attribute because a crate that inherits `[lints] workspace = true`
cannot add entries of its own in `Cargo.toml`. A crate-root attribute overrides
the workspace `allow`.

| Lint | Catches |
|---|---|
| `cast_possible_truncation`, `cast_possible_wrap`, `cast_sign_loss` | an `as` that drops bits or flips sign. `u32 as usize` passes. |
| `too_many_lines` | a function over the threshold in `clippy.toml` |
| `let_underscore_must_use` | `let _ = fallible();` |
| `unwrap_used` | `unwrap()` outside tests |
| `undocumented_unsafe_blocks` | an `unsafe` block or impl with no `// SAFETY:` comment directly above |

`indexing_slicing` is left out on purpose: it fires on every `slice[i]`,
including the ones an assert or a loop bound already covers.

## clippy.toml

Add to the workspace's `clippy.toml`. The threshold does nothing in crates
where `too_many_lines` is allowed.

```toml
too-many-lines-threshold = 70
allow-unwrap-in-tests = true
```

## Profiles

Overflow wraps silently in release unless checks are on. Turn them on for core
crates, or for the whole workspace:

```toml
[profile.release.package.my-core-crate]
overflow-checks = true
```

```toml
[profile.release]
overflow-checks = true
```

`panic` cannot be set per package, and the binary chooses it. `panic = "abort"`
turns every panic into an immediate exit, which suits a process that restarts
from durable state. It is wrong for a library loaded into a host that has to
turn a callback's panic into an error: `catch_unwind` never runs under it.

## What no lint here catches

Review for these by reading.

- `.ok();` on a line of its own, discarding an error.
- `_ =>` over your own enum when it hides more than one variant.
- Allocation on a steady-state path.
- `usize` in a data model.
- A missing `else` whose negative space is neither handled nor asserted.
  `else_if_without_else` only looks at `else if` chains.

Baseline lints that reject patterns people write on purpose: `redundant_else`
and `needless_return` (an `else` after a `return`), `needless_continue`
(`else { continue }`), `pub_underscore_fields` (a public `_pad`), and
`chunks_exact_to_as_chunks` (`chunks_exact` with a constant size).
