---
name: rust
description: >-
  House rules for Rust: ownership and borrowing, types and std traits, errors
  and panics, control flow, memory and layout, effects, async, unsafe, crates,
  dependencies and lints. Use whenever writing, reviewing, refactoring,
  debugging or explaining Rust: any `.rs` file, `Cargo.toml`, clippy or
  rustfmt output, a borrow-checker or lifetime error, traits, async, unsafe or
  FFI. Builds on the `craft` skill. Also `/rust review <target>` and
  `/rust check`.
argument-hint: "[review <target> | check]"
---

# Rust

Read with `craft` ([../craft/SKILL.md](../craft/SKILL.md)). It states the
principles and the two registers, always and core. This skill gives the Rust
spelling and adds what only exists in Rust. The repo's AGENTS.md outranks both.

- Write Rust-shaped code. Don't port C++, Java, C# or Python one construct at
  a time: errors are `Result`, resources are ownership and `Drop`,
  polymorphism is traits and enums, absence is `Option`. `Deref` to a "base"
  struct, a `Manager` type or a null-check helper marks a port.
- Application code takes concrete types, `&str` rather than
  `impl Into<String>`, returns `Vec`, and uses `anyhow`. A library, meaning a
  crate with users outside its repo, also follows
  [references/api.md](references/api.md).
- No comments and no doc comments (AGENTS.md). Two forms stay because clippy
  reads them: `// SAFETY:` above an `unsafe` block or impl, and `/// # Safety`
  on a `pub unsafe fn`.

## Gate

```bash
cargo fmt
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

- When reviewing, `cargo fmt --check`: a review rewrites nothing.
- Lints live in `[lints]` or `[workspace.lints]` in `Cargo.toml`. A new crate
  takes the house table, and a core crate adds the core block; both are in
  [references/lints.md](references/lints.md).
- Override one item with `#[expect(clippy::name, reason = "...")]`. It warns
  once the lint stops firing, so stale overrides get removed. `#[allow]` is
  for generated code and macro output.
- Never `#![deny(warnings)]` in source.
- `#[rustfmt::skip]` only on generated code or a deliberately aligned table.
- Read `rust-toolchain.toml` and `rust-version` before using a recent API.

## Ownership and borrowing

- Unique ownership first. `Rc` and `Arc` when shared ownership is the design,
  `RefCell` and `Mutex` when interior mutability is. They move a compile-time
  check to run time, so reach for them on purpose.
- Never clone to quiet the borrow checker; the copy silently diverges from the
  original. Try, in order: a named `let` to extend a temporary, or a block to
  end a borrow; typed intermediates so the failing step shows; `mem::take`,
  `mem::replace` or `Option::take` to move a field out of `&mut self`;
  splitting the struct so its parts borrow separately (the compiler tracks
  disjoint fields inside one function, not across method calls); a deliberate
  clone of small immutable data; indices into an owning `Vec`. No
  self-referential structs.
- Parameters take the most general borrowed form: `&str` not `&String`,
  `&[T]` not `&Vec<T>`, `&T` not `&Box<T>`, `Option<&T>` not `&Option<T>`.
  `impl AsRef<Path>` is fine on a parameter and never on a field.
- `&T` to read, `&mut T` to change in place, `T` to store or consume. Never
  borrow and then `.clone()` inside.
- Return values instead of `&mut` out-parameters. A buffer the caller reuses
  is the exception.
- Structs own their data. A borrowed field puts a lifetime on every container
  above it. A lifetime on a type gets a descriptive name (`'src`, `'conn`).
- Freeze after setup: `let config = config;`.
- Keep `Rc`, `Arc`, `Box` and `RefCell` out of public signatures. A shared
  service is `Clone` over a private `Arc<Inner>`.
- `Copy` only on types of 16 bytes or less: the compiler copies silently.
- A closure that needs some captures cloned and others moved rebinds them in
  a block, then `move`s.

```rust
pub fn retire(slot: &mut Slot) {
    if let Slot::Named { name, .. } = slot {
        *slot = Slot::Retired {
            name: mem::take(name),
        };
    }
}

pub fn row_counter(limits: &Arc<Limits>, rows: Vec<u32>) -> impl FnOnce() -> usize {
    let limits = Arc::clone(limits);
    move || rows.len().min(limits.rows_max)
}
```

## Types

- **Newtypes** for units and ids: `struct Miles(f64)`, with
  `#[repr(transparent)]` when layout matters. A type that carries an invariant
  is built by `TryFrom`, `FromStr` or `try_new`, and never has an infallible
  `From` from the raw value.
- A `bool` parameter becomes a two-variant enum. Independent flags use
  `bitflags`. Absence is `Option`. Paths are `Path` and `PathBuf`, spans of
  time are `Duration`.
- **Conversions.** `From` and `TryFrom`, not `as`, which truncates and changes
  sign without a word. The one `as` allowed is `u32` to `usize` for indexing,
  under a crate-level
  `const _: () = assert!(size_of::<usize>() >= size_of::<u32>());`.
- **Arithmetic.** `div_ceil`, `div_euclid` (floor, for a positive divisor) or
  a `div_exact` helper that asserts a zero remainder, instead of a bare `/`
  whose rounding nobody chose. `checked_`, `wrapping_` or `saturating_` where
  overflow is possible. Atomics name their `Ordering`.
- **Derive eagerly**, since downstream crates cannot add std traits: `Debug`
  on every public type (hand-written to redact a secret), `Clone`, `PartialEq`
  and `Eq`, `PartialOrd` and `Ord`, `Hash`, `Default`. A hand-written `Ord`
  needs hand-written `PartialEq`, `PartialOrd` and `Hash` that agree with it.
- Implement `From` and `TryFrom`, never `Into`. `FromStr` instead of a
  `from_str` method. `Display` on anything meant to be read. `Deref` only on
  smart pointers and owning collections. Operators only with their
  mathematical meaning. No derivable bounds on a struct definition; put them
  on the `impl`.
- `#[must_use]` where discarding the value is a bug. `len()` comes with
  `is_empty()`.
- Option structs that decide safety, durability or ordering do not implement
  `Default`, so `..Default::default()` cannot hide a new field.
- **Naming.** Acronyms are one word (`HttpClient`, `Uuid`). No `get_` prefix:
  `name()`, `name_mut()`. `as_` is free and borrowed, `to_` does work, `into_`
  consumes. Constructors are `new`, `with_capacity`, `try_new`, `from_parts`.
  Errors read verb-object-error: `ParseAddrError`.
- Write the type where inference hides it, on `.into()`, `.parse()` and
  `.collect()`, as `let ids: Vec<u32> = ..` rather than a turbofish.

## Traits, generics, macros

- Define a trait only for generic code or as an extension trait (`FooExt`),
  never to organize code. Prefer a concrete type, then a generic, then
  `dyn Trait`.
- A function with a clear receiver is a method. One without is a free
  function, not `Database::check(params)`. Associated functions construct.
- A closure parameter takes the most general bound that works (`FnOnce`, then
  `FnMut`, then `Fn`) and goes last.
- A macro only when functions, generics and traits cannot do the job, and
  `macro_rules!` before a proc macro.

## Errors and panics

| Situation | Use |
|---|---|
| Absence is normal (`first()`, `checked_add`) | `Option<T>` |
| The caller may need to know what went wrong | `Result<T, E>` |
| A bug or broken invariant in this code | `assert!`, `expect("why it holds")`, `unreachable!` |

- `?` for operating errors. `expect("why it holds")` for invariants, giving
  the reason it cannot fail rather than restating the call. `unwrap()` in
  tests only.
- Pattern-match instead of check-then-unwrap: `if let Some(x) = opt`, or
  `let Some(x) = opt else { return .. };`.
- A panicking convenience comes with a fallible sibling: `new` and `try_new`,
  `v[i]` and `v.get(i)`.
- `assert!`, not `debug_assert!`, for invariants: release builds strip the
  debug form. `assert_eq!` and `assert_ne!` print both operands; any other
  `assert!` gets a message with the values.
- Compile time: `const _: () = assert!(..);` at module level, and
  `const { assert!(..) }` inside a generic function.
- Never discard a fallible result: no `let _ = fallible();`, no `.ok();` on a
  line of its own (no lint catches that one), no `map_err(|_| ..)` that drops
  a cause worth keeping.
- `catch_unwind` only at an FFI boundary, never to recover and continue. A
  poisoned lock is fatal: `.lock().expect("lock poisoned")`.
- **Library errors** implement `std::error::Error`, are
  `Send + Sync + 'static`, and return their cause from `source()`. `Display`
  is lowercase with no trailing punctuation, so messages chain. One enum
  variant per cause (`thiserror`), or a struct with a private kind and
  `is_xxx()` methods. Never `()`, `String`, `Box<dyn Error>` or
  `anyhow::Error` in a public signature, and never one enum for every failure
  in the crate. A function that consumes its argument and fails returns it
  inside the error.
- **Application errors** are `anyhow` with `.context(..)` at each level.
  `main` may return `anyhow::Result<()>`.
- `Drop` never fails, panics or blocks. Fallible teardown is
  `close(self) -> Result<..>`. Bind a guard to a name, `let _guard = ..`;
  `let _ = ..` drops it on that line.

```rust
#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("reading {}", .path.display())]
    Read { path: PathBuf, source: io::Error },
    #[error("{}:{line}: expected key=value", .path.display())]
    Syntax { path: PathBuf, line: usize },
}

const _: () = assert!(BUFFER_SIZE_BYTES >= MESSAGE_SIZE_BYTES_MAX);

pub fn sum_block<const N: usize>(block: &[u8; N]) -> u32 {
    const {
        assert!(N > 0);
        assert!(N <= BUFFER_SIZE_BYTES);
    };
    block.iter().map(|&byte| u32::from(byte)).sum()
}
```

## Control flow and idiom

- `match` on your own enum lists every variant, with no `_ =>`; no lint
  enforces this. A wildcard is right only after the handled variants of a
  foreign `#[non_exhaustive]` enum. A compound condition becomes a `match` on
  the tuple.
- Guard returns and `let .. else` are fine. Don't write an `else` after a
  `return`, or an `else { continue }`: clippy rejects both.
- Iterator chains when the pipeline is short and reads top-down; a `for` loop
  when the body is large or does several jobs. `for x in it`, not
  `.for_each(..)`. Bind a long chain to a name instead of putting it in the
  `for` header. Collect fallible steps into `Result<Vec<_>, E>`.
- Input past its bound is an `Err`, or a batch whose remainder stays queued.
  `.take(MAX)` alone silently drops the rest.
- `Option` and `Result` combinators when they read better than `match`, and
  `match` when they don't.
- `format!("{name}: {count}")` with inline arguments, not `+` or
  `str::replace`. `write!` into an existing buffer on a hot path.
- Imports: types and traits by name, free functions through their module
  (`mem::take`, `fs::read`). The house lints allow globs.
- `log` or `tracing` for events, not `println!` or `dbg!`, with values passed
  as fields rather than pre-formatted with `format!`.
- A file reads: the main type, its supporting types, then `impl` blocks with
  constructors first, public methods next and private helpers last.

```rust
pub fn import(lines: &[&str]) -> Result<Vec<u64>, ImportError> {
    if lines.len() > RECORDS_MAX {
        return Err(ImportError::TooManyRecords {
            count: lines.len(),
            max: RECORDS_MAX,
        });
    }
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            line.parse().map_err(|source| ImportError::NotANumber {
                line: index + 1,
                source,
            })
        })
        .collect()
}

pub fn drain_batch(queue: &mut VecDeque<u64>, mut handle: impl FnMut(u64)) -> usize {
    let batch = queue.len().min(EVENTS_PER_TICK_MAX);
    for event in queue.drain(..batch) {
        handle(event);
    }
    batch
}
```

## Core

For core code (see `craft`), on top of the rest. Patterns and examples are in
[references/memory.md](references/memory.md).

- **Hidden allocation.** `format!`, `to_string`, `to_vec`, `collect`, `clone`
  on a heap type, `Box::new`, `Arc::new`, and `push` or `insert` past capacity
  all allocate. On the steady-state path use storage built at startup
  (`Box<[T]>`, or `Vec::with_capacity` and a capacity check before each
  push), `&mut [u8]` scratch from the caller, and `write!` into a reused
  buffer.
- **Bounds.** A fixed-capacity explicit stack instead of recursion. Bounded
  channels only. No task or thread spawned per event.
- **Integers.** `u32` and `u64` in data models, never `usize`, which changes
  size with the target.
- **Layout.** `#[repr(C)]`, explicit zeroed padding fields, and const asserts
  on `size_of` and `align_of` for anything written to disk, a socket or FFI.
  Padding the compiler inserts is uninitialized, and reading it as bytes is
  undefined behavior. Never `#[repr(packed)]`.
- **Handles.** A `Vec<T>` and a `NonZeroU32` newtype id instead of a `Box`,
  `Rc` or `Arc` per node; `Option<Id>` stays four bytes. `NonZero` stays
  inside the newtype, never a bare parameter.
- **Effects.** Either
  `fn step(&mut self, event: &Event, now_ms: u64, commands: &mut Vec<Command>)`
  or `fn tick(&mut self, now_ms: u64, storage: &mut impl Storage)`. No
  `Instant::now()`, `SystemTime::now()`, `thread_rng()`, `TcpStream` or `File`
  inside a core struct. A `BTreeMap`, or a sort, before anything is output or
  hashed.
- **Hot loops** are free functions over slices and plain values, the one
  exception to "a clear receiver means a method". Establish lengths before
  the loop (`assert_eq!(a.len(), b.len())`, `zip`, `as_chunks`) so bounds
  checks go without `unsafe`.
- **Profile.** `overflow-checks = true` for core crates in release. The
  binary chooses its panic strategy.

## Concurrency and async

- Public types and the futures they return are `Send`. Pin it with
  `const _: () = { const fn assert_send<T: Send>() {} assert_send::<Client>(); };`
- An `Rc`, or a `RefCell` borrow, held across `.await` makes the future
  `!Send`.
- Never hold a `MutexGuard` across `.await`, and never return one from a
  public method.
- `async fn`, not `fn -> impl Future`, outside traits.
- Long CPU work inside async yields every 10 to 100 microseconds, or moves to
  `spawn_blocking`.
- A library spawns no threads and assumes no runtime. It takes a spawner, or
  `impl Read` / `impl AsyncRead`, from its caller.

## Unsafe

`unsafe_code = "deny"` is the house default. Where a crate allows it, read
[references/unsafe-ffi.md](references/unsafe-ffi.md) first. In short: only for
FFI, a measured performance need, or an abstraction safe code cannot express;
`// SAFETY:` on every block; the smallest module, behind a safe API. A safe
function that can cause undefined behavior is unsound, and unsound code is
never acceptable.

## Crates and dependencies

- Small single-purpose crates, siblings in a flat `crates/`, sharing versions
  and lints through `[workspace.dependencies]` and `[workspace.lints]`.
- A leaf module is named after its main item (`Foo` in `foo.rs`). Non-leaf
  modules hold `mod` lines and re-exports. Essential items sit at the crate
  root and the rest is grouped by use case (`account`, `network`), not by
  kind (`traits`, `errors`). No prelude of your own.
- House crates, one per job: `anyhow` (application errors), `thiserror`
  (library errors), `log` or `tracing` (whichever the repo uses), `bitflags`,
  `serde`, `slotmap` (generational handles), `foldhash` or `rustc-hash`
  (maps with trusted keys), `mimalloc` (a binary's allocator), `smol` or
  `tokio` (whichever the repo uses). Read the workspace `Cargo.toml` before
  adding anything else.
- Version ranges (`"1"`, `"1.4"`), never `"*"` or a needless `"="`. Binaries
  commit `Cargo.lock`. Look at what a new dependency pulls in with
  `cargo tree` before keeping it.
- Features are additive and bare-named: `std`, `serde`. Never `no-std` or
  `use-serde`, and never one that removes or changes a public item.
- Latest stable edition for a new crate. Nothing runs before `main`. No
  unstable features on a stable toolchain.

## Tests

- `#[cfg(test)] mod tests` at the bottom of the file for private internals;
  `tests/` for what is reachable through the public API.
- Types that do I/O, read the time or draw randomness take those as
  parameters, or offer a fake behind a `test-util` feature. No `Default` that
  performs I/O.
- `cargo fuzz` for parsers of untrusted input. `criterion` or `divan` with
  `std::hint::black_box` for benchmarks. Miri over any `unsafe`.

## Review and check

`/rust review <target>` and `/rust check` follow
[../craft/references/review.md](../craft/references/review.md), with these on
top of its reading order:

- **Correctness.** `unsafe` without a `// SAFETY:` comment; `transmute` to
  cast an enum or stretch a lifetime; `unsafe impl Send` to quiet the
  compiler; a safe function that can reach undefined behavior. A panic
  reachable from outside input: `unwrap`, `expect`, indexing, a wrapping `as`,
  overflow. A hand-written `Ord` beside a derived `PartialEq`, or a `Hash`
  that disagrees with `Eq`. A `MutexGuard` held across `.await` or returned;
  a callback run under a lock; a poisoned lock recovered with `into_inner`.
  A `Drop` that can panic, block or fail.
- **Failures.** `()`, `String`, `Box<dyn Error>` or `anyhow::Error` as a
  library's error; `map_err(|_| ..)`; no `source()`; a message without the
  path, line or value; `.ok();` or `let _ =` on a fallible call.
- **Interface.** `&String`, `&Vec<T>`, `&Box<T>`; a `bool` parameter;
  ownership taken then cloned, or a borrow cloned inside; a public field that
  should be private; a smart pointer or third-party type in a public
  signature; `get_` getters; `as_`, `to_` or `into_` that lies about cost.
- **Idiom.** A clone that only satisfies the borrow checker;
  check-then-unwrap; `+` string building; `HashMap` order reaching output or
  a test; `#![deny(warnings)]`; `#[allow]` without a reason.

## References

- [references/api.md](references/api.md): library API design. Read before
  designing or changing a public interface.
- [references/memory.md](references/memory.md): allocation, arenas, flat
  containers, layout, in-place initialization, hashers. Read before designing
  a data structure or a hot path.
- [references/unsafe-ffi.md](references/unsafe-ffi.md): the unsafe policy and
  FFI. Read before writing `unsafe`.
- [references/lints.md](references/lints.md): the house lint table, the core
  block, `clippy.toml` and profiles, ready to paste.
