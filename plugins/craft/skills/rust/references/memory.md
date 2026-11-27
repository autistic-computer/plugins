# Memory and layout

The Rust form of the memory, layout and hot-loop rules. `craft`'s
`references/performance.md` has the reasoning; this file has the patterns.
Most of it is for core code. The examples are excerpts of code that compiles
clean under the house lints with the core block.

## Where Rust allocates without saying so

`format!`, `to_string`, `to_owned`, `to_vec`, `collect`, `clone` on a heap type,
`Box::new`, `Rc::new`, `Arc::new`, a `String` or `Vec` returned by value, and
any `push`, `insert` or `extend` past capacity. On a steady-state path each of
these is a finding.

## Startup storage and scratch

- Build backing storage once: `vec![T::default(); n].into_boxed_slice()` for a
  fixed `Box<[T]>`, or `Vec::with_capacity(n)` with a capacity check before
  every push.
- Take scratch from the caller. In core code that is `&mut [u8]`; elsewhere
  `&mut Vec<u8>` or `&mut String` with `.clear()` is simpler and keeps the
  capacity.
- `write!` into a reused buffer instead of `format!`.
- Zero the tail of a reused buffer.

```rust
pub fn render_key(scratch: &mut String, tenant: u32, sequence: u64) -> &str {
    scratch.clear();
    write!(scratch, "{tenant}/{sequence:016x}").expect("writing to a String cannot fail");
    scratch
}

pub fn fill_frame(payload: &[u8], frame: &mut [u8]) -> Result<(), PayloadTooLarge> {
    let max = frame.len();
    let Some((head, tail)) = frame.split_at_mut_checked(payload.len()) else {
        return Err(PayloadTooLarge {
            len: payload.len(),
            max,
        });
    };
    head.copy_from_slice(payload);
    tail.fill(0);
    Ok(())
}
```

## Arenas and handles

One `Vec` of nodes and a four-byte id, instead of a `Box`, `Rc` or `Arc` per
node. `NonZeroU32` gives `Option<NodeId>` a niche, so an optional link costs
nothing extra, and the newtype stops an id from one arena indexing another.

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct NodeId(NonZeroU32);

impl NodeId {
    fn index(self) -> usize {
        self.0.get() as usize - 1
    }
}

const _: () = assert!(size_of::<Option<NodeId>>() == 4);

pub struct Arena<T> {
    slots: Vec<T>,
    capacity: u32,
}

impl<T> Arena<T> {
    pub fn with_capacity(capacity: u32) -> Self {
        Self {
            slots: Vec::with_capacity(capacity as usize),
            capacity,
        }
    }

    pub fn insert(&mut self, value: T) -> Result<NodeId, ArenaFull> {
        let id = u32::try_from(self.slots.len() + 1)
            .ok()
            .filter(|&count| count <= self.capacity)
            .and_then(NonZeroU32::new)
            .ok_or(ArenaFull {
                capacity: self.capacity,
            })?;
        self.slots.push(value);
        Ok(NodeId(id))
    }

    pub fn get(&self, id: NodeId) -> &T {
        &self.slots[id.index()]
    }
}
```

- Pass an arena or a scratch buffer as a parameter (`&mut Arena<T>`). Don't
  store one inside a domain struct, where the allocation is hidden.
- **Slots freed out of order**: `slotmap`. A plain free list hands a stale id
  the slot's new occupant; a generational key detects it.
- **Phase-scoped data** (one parse, one request): `bumpalo`. Allocation is a
  pointer bump and the whole phase drops at once, with no per-item destructor.

## Flat containers

- **`Vec<String>`** becomes one byte buffer and a `(start, len)` pair per
  entry: one allocation instead of one per string plus 24 bytes of header
  each. For repeated keys intern them (`lasso`, `ustr`); for many short
  strings `compact_str` or `smol_str` keep them inline. None of those four is
  a house crate yet, so ask before adding one.
- **`Vec<Vec<T>>`** becomes one flat `Vec<T>` and a `Vec<u32>` of start
  offsets, for data built once and read often. Inserting into an early row
  shifts every row after it.

```rust
pub struct Names {
    bytes: Vec<u8>,
    spans: Vec<(u32, u32)>,
}

impl Names {
    pub fn get(&self, index: usize) -> &[u8] {
        let (start, len) = self.spans[index];
        &self.bytes[start as usize..(start + len) as usize]
    }
}

pub struct Adjacency {
    starts: Vec<u32>,
    targets: Vec<NodeId>,
}

impl Adjacency {
    pub fn neighbors(&self, node: usize) -> &[NodeId] {
        let start = self.starts[node] as usize;
        let end = self.starts[node + 1] as usize;
        &self.targets[start..end]
    }
}
```

## Enum size

An enum is as large as its largest variant, plus a discriminant unless a niche
absorbs it (`Option<NonZeroU32>`, `Option<Box<T>>` and `Option<&T>` are free).
One rare 64-byte variant makes every 8-byte variant eight times larger.

- Move the rare or large payload to a side `Vec` and keep a `u32` index in the
  variant. Pin the result: `const _: () = assert!(size_of::<Token>() == 8);`.
- A stream that is only walked front to back (a log, a command buffer, IR) can
  be a `Vec<u8>`: one tag byte, then exactly that variant's payload.
- Never `#[repr(packed)]`. The default layout already reorders fields to
  minimize padding; `packed` forces unaligned access and forbids references to
  fields. Shrink the field types instead: `u32` over `usize`, `f32` over
  `f64`, `bitflags` over several `bool`s, a handle over a `String`.

## Field grouping

`Vec<Struct>` is right when the loop reads most fields of each element. When
it reads a few, move the cold ones (names, metadata, debug state) to a second
`Vec` under the same index. One `Vec` per field pays off when a loop scans a
single column or handles one variant at a time.

## Fixed layout

Anything written to disk, a socket or FFI is `#[repr(C)]`, with padding spelled
as private zeroed fields and the size and alignment pinned at compile time.
Padding the compiler inserts on its own is uninitialized: viewing the struct as
`&[u8]` to hash, compare or write it is undefined behavior, and whatever bytes
happen to be there make equal values hash differently.

```rust
#[repr(C)]
pub struct Entry {
    key: u64,
    value: u64,
    flags: u32,
    _pad: u32,
}

impl Entry {
    pub const fn new(key: u64, value: u64, flags: u32) -> Self {
        Self {
            key,
            value,
            flags,
            _pad: 0,
        }
    }
}

const _: () = assert!(size_of::<Entry>() == 24);
const _: () = assert!(align_of::<Entry>() == 8);
```

The padding field is private: clippy's `pub_underscore_fields` rejects a public
one. `#[repr(C, align(64))]` puts a value on its own cache line when two
threads would otherwise share one.

## Large values

`Box::new(Big { .. })` builds the value on the stack and then copies it. For a
large struct that is a large copy at best and a stack overflow at worst.

- A large zeroed buffer: `vec![0u8; n].into_boxed_slice()`. No stack copy and
  no `unsafe`.
- A large struct that already exists: an `init(&mut self, ..)` method that
  fills it in place.
- A large struct for which all-zero bytes are valid: `Box::new_zeroed()`
  (Rust 1.92), then `assume_init` under a `// SAFETY:` comment. The example
  is in [unsafe-ffi.md](unsafe-ffi.md).
- Clippy's `large_stack_arrays` flags the accidental case.

## Bounds checks

Tell the compiler the lengths before the loop and the per-element checks go,
with no `unsafe`. `zip`, a constant chunk size through `as_chunks`, a runtime
one through `chunks_exact`, and an upfront `assert_eq!` on lengths all do it.
Clippy rejects `chunks_exact` with a constant size.

```rust
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub fn sum_words(bytes: &[u8]) -> u64 {
    let (words, rest) = bytes.as_chunks::<8>();
    assert_eq!(rest.len(), 0);
    words
        .iter()
        .map(|&word| u64::from_le_bytes(word))
        .fold(0, u64::wrapping_add)
}
```

## Hot loops

A hot loop is a free function over slices and plain values. Passing `&[u8]`
tells the optimizer nothing else aliases it; a loop inside a `&mut self` method
has to assume every field can change underneath it. Keep validity checks and
`match`es on a variant out of the body: validate the batch, then run it over
contiguous data. `Vec<Box<dyn Trait>>` in a hot loop is a pointer chase and an
indirect call per element. No logging inside the loop.

## Maps, strings, allocators

- `HashMap` uses SipHash, which resists collision attacks and is slow on
  integers and short keys. For keys the program generates itself use `foldhash`
  or `rustc-hash`. Keep the default for anything a peer or user chooses.
- A long-lived sequence that never grows again is `Box<[T]>`, `Box<str>` or
  `Arc<str>`. Call `shrink_to_fit` on a long-lived collection that was built
  without a reservation.
- `Vec::with_capacity`, or `collect` from an iterator of known length, instead
  of a push loop.
- A binary that leans on the heap sets `mimalloc` as its `#[global_allocator]`.
  Libraries never set one.

## Proving a path does not allocate

- Best: the core state machine is `#![no_std]` without `extern crate alloc`.
  The compiler then proves it.
- Otherwise a test: wrap the system allocator in a counter, install it as the
  test binary's `#[global_allocator]`, warm the path up once, and assert the
  counter does not move across a steady-state run.

```rust
pub static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);

pub struct Counting;

// SAFETY: every call is forwarded to `System` unchanged; the counter never
// touches the memory being handed out.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        // SAFETY: the caller upholds the contract of `GlobalAlloc::alloc`.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` came from `alloc` above with this same `layout`.
        unsafe { System.dealloc(ptr, layout) }
    }
}
```
