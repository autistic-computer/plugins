# Performance

The budget sketch, data layout patterns, batching and hot loops behind the
performance rules in SKILL.md. The layout patterns apply where the language
gives control over memory; the language skill has the real spelling.

## The budget sketch

Most of the speed available is decided before any code exists. Sketch the load
against the four resources, with numbers good to an order of magnitude:

```text
Operation: process 10k messages per second, 100 bytes each

Network   10k * 100 B  = 1 MB/s      far below a 1 Gbps link
Disk      10k * 100 B  = 1 MB/s      an SSD sustains 500+ MB/s
Memory    10k * 1 KB   = 10 MB       past L2, check it fits L3
CPU       10k * 1 us   = 10 ms/s     1% of one core
```

The sketch shows which resource runs out first and what the design has to
protect. Optimize in order of cost per access, adjusted for frequency:

| Resource | Latency | Order |
|---|---|---|
| Network | 1 ms to 100 ms | first |
| Disk | 100 us to 10 ms | second |
| Memory | 100 ns to 1 us for a miss | third |
| CPU | 1 ns to 100 ns | last |

Frequency can reorder the table: a cache miss taken a thousand times per
request costs as much as one disk flush.

## Planes and batches

- **Control plane** runs rarely: configuration, connection setup, schema
  changes. It validates everything and precomputes what the data path needs.
- **Data plane** runs per item. It works on what was already validated, in
  batches, with no per-item decisions that setup could have made once.

Batching amortizes a fixed cost over many items: one write for a buffer of
messages instead of a write per message, one lock for a batch instead of a lock
per item, one flush per group commit. A batch has a maximum size and a maximum
wait, so latency stays bounded when traffic is light.

## Data layout

Two numbers dominate: how many bytes the hot loop has to touch (the working
set) and how many separate allocations hold them. Instruction-level tuning is
small next to either.

### Bulk storage and handles

Objects allocated one at a time are scattered, each pays an allocator header,
and tearing the structure down walks every pointer. Put them in one contiguous
array and refer to them by index.

- A 32-bit index is half the size of a pointer, so links cost half as much.
- Indices survive the array moving or being written to disk. Pointers do not.
- Wrap the index in its own type per collection, so a node index cannot be
  used on the edge array.
- **Slots reused out of order** make a plain index dangerous: a stale handle
  silently reads the new occupant. Pair each slot with a generation counter and
  each handle with the generation it was issued for; a mismatch is detected.
- **Phase-scoped data** (everything for one parse, one request, one frame)
  goes in a bump region: allocation is a pointer increment and the whole phase
  is freed at once.

### Flat containers

- **Many small strings**: one byte buffer plus an (offset, length) pair per
  string, instead of a separate allocation each. Repeated strings are interned
  once and referred to by id.
- **A list of lists**: one flat array of all the elements plus an array of
  start offsets. This is for structures built once and read often; inserting
  into an early list shifts everything after it.
- **Scratch space**: the caller owns a buffer and the callee clears and
  refills it, so capacity is paid for once.
- **Known sizes** are reserved up front, which avoids regrowth copies and the
  slack they leave behind.

### Variant size

A tagged union is as large as its largest variant. One rare 64-byte variant
makes a million 8-byte ones eight times bigger.

- Move the rare or large payload into a side array and keep an index in the
  variant.
- A sequence that is only read front to back (a log, a command buffer, an
  instruction stream) can be bytes: a one-byte tag followed by exactly that
  variant's payload. No variant pays for another.
- Shrink the fields before reaching for packed layouts: 32-bit indices instead
  of pointer-sized ones, bit flags instead of several booleans, a handle
  instead of an owned string.

### Field grouping

- **Array of structs is the default.** When the loop reads most fields of each
  element, keeping them adjacent is the best use of a cache line.
- **Hot/cold split** when the loop reads a few fields and skips the rest. The
  names, metadata and debug state move to a parallel array under the same
  index, and the hot array gets denser.
- **Struct of arrays** when a loop scans one field across all elements, or
  handles one variant at a time. Each field is its own array; the loop touches
  only the bytes it needs, and the compiler can vectorize it.

### Hashing

A hash function that resists collision attacks is slow on small keys. It is the
right default for keys an attacker can choose. For keys the program generates
itself (ids, interned symbols, indices), a fast non-resistant hash is safe and
often removes a third or more of the time in map-heavy code.

## Hot loops

- Contiguous input, no pointer chasing, and no branch in the body that the
  predictor cannot learn. Validity checks and mode switches move out of the
  loop: validate the batch, then run it.
- A standalone function over plain values and arrays. Inside a method, the
  compiler must assume the object's other fields can change under the loop and
  reloads them; a reader has the same problem.
- Bounds established once, before the loop, so the per-element check can go.

## Measuring

Layout, batching and the choice of resource to protect are design, and waiting
for a profile to make them is too late. Everything below that level waits for
a benchmark of the real hot path: reordering instructions, unrolling, manual
vectorization, prefetching. Keep the benchmark next to the code it justifies.
