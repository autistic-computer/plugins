# Safety

The reasoning and technique behind the assertion, failure, bounds and
determinism rules in SKILL.md. Examples are in neutral pseudocode; the language
skill has the real spelling.

## Assertions

What an assertion buys:

- It turns a silently wrong state into a stop at the place it went wrong,
  instead of corrupt data discovered later somewhere else.
- It multiplies fuzzing and simulation. Random input only finds a bug if
  something notices the bad state it produced.
- It is the documentation that runs. Where code carries no comments, the
  assertions are where the intent is written down.

### What to assert

- **Arguments.** Preconditions the parameter types do not carry: a range, an
  ordering between two arguments, the state the object must be in.
- **Results.** What was written is what was asked for; the count went up by
  exactly one; the output is sorted.
- **Invariants.** A relation between fields, checked after the mutation that
  could break it.
- **Constants.** A relation between two constants, or the size of a layout,
  checked at compile time.

### What not to assert

| Pattern | Why it is noise or worse |
|---|---|
| A value against its own type: a non-zero type compared with zero, an unsigned value `>= 0` | The compiler already proved it. |
| What the previous line established: `count = 0; assert(count == 0)` | Cannot fail. |
| The same condition twice in one function | The second adds nothing. |
| A property that only usually holds: `assert(checksum != 0)` | A valid checksum can be zero. The assertion is now the bug. |
| A condition on outside input: `assert(packet.length <= MAX)` | That is a recoverable failure. Asserting it lets a sender stop the program. |

A function with nothing worth asserting has none. A count of assertions is not
a goal.

### Techniques

**Split.** `assert(a); assert(b);` instead of `assert(a and b)`. The failure
then says which.

**Negative space.** For every "this must hold", look for the "this must never
hold" beside it: the index is in range, and the slot it names is not free.

**Implication.** `if is_leader { assert(has_quorum) }`. There is no need for an
implication operator.

**Pairs.** A property that matters is checked on two paths that do not share
code:

- before a record is written and after it is read back
- at the sender before encoding and at the receiver after decoding
- a count kept incrementally against a recount, where the recount is cheap
- an encode followed by a decode that must return the original

One check guards one path. Two independent checks guard the property.

**Compile time.** Relations between constants (`BUFFER_SIZE >= MESSAGE_SIZE_MAX`)
and the size and alignment of every type with a fixed layout. These cost
nothing at run time and fail before the program exists.

**Output.** A failed comparison prints both sides. Where the language has an
equality form that does this, use it; otherwise give the values in the message.
A message that repeats the condition adds nothing. A value that is a secret is
never printed, including by a failed assertion.

**Cost.** Constant-time checks stay on in production. A check that is linear in
the data, inside a hot loop, may be debug-only once it has been measured as
the problem.

## Failures

| Kind | Example | Mechanism | Who acts |
|---|---|---|---|
| Absence | key not in the map, end of stream | the absence type | the caller, as normal flow |
| Recoverable failure | file missing, malformed packet, peer timed out, disk full | the language's error value or exception | a caller that can retry, report or degrade |
| Broken invariant | our own index past the end, a state machine in a state it cannot reach | an assertion, and the program stops | a programmer, later |

The test that separates the last two: could correct code reach this point,
given some input from outside? If yes, it is a recoverable failure. If only
wrong code gets here, it is a broken invariant.

- **The boundary.** Outside input is validated once, where it enters, and
  becomes a type. Before that point a violation is a recoverable failure. After
  it, the same violation is a bug.
- **Swallowing** has four forms: discarding a result, an empty catch,
  substituting a default, and logging then continuing as though the operation
  succeeded. The last is only handling when continuing is actually correct.
- **Content.** The operation, the value (which file, which line, which id) and
  the cause underneath. An error that says only "invalid input" sends someone
  to a debugger.
- **Catching a crash** is for a host boundary: unwinding into foreign code,
  a plugin taking down its host, one request taking down a server. Translate
  it, then stop or restart from a known state. State touched by the crashed
  code is not trusted afterwards.
- **Cleanup** that can fail is not cleanup. A flush or a commit whose failure
  matters is an explicit call with a result; the automatic path only releases.

## Bounds

**Loops.** Iterating a collection of known length is bounded by that length.
Anything else needs a named maximum: retries, reading until a condition,
following links, waiting.

**Outside input.** Past the bound there are three honest policies:

| Policy | When |
|---|---|
| Reject with an error | Correctness needs all of it: an import, a request body, a config file. |
| Process a batch, keep the rest | Stream work: handle N this tick, the remainder next tick. |
| Drop and count | Lossy by design: telemetry, coalescable updates. The counter is visible. |

Silent truncation is none of these. Returning the first N items as though they
were all of them loses data without a trace.

**Queues and collections.** Each has a named maximum. A full queue pushes back
on its producer or counts a drop. A collection that grows with input and has
no maximum is an out-of-memory failure with a delay.

**Events.** Reacting to each event as it arrives hands the pace of the program
to whoever sends events:

```text
on_event(event):
    handle(event)                     the sender controls how much work happens

tick(incoming):
    for event in incoming:
        if queue is full: dropped += 1
        else: queue.push(event)
    for up to BATCH_MAX events in queue:
        handle(event)                 the program controls it
```

**Recursion.** A depth that input controls becomes an explicit stack with a
named capacity, and exceeding the capacity is a recoverable failure. Recursion
over a structure whose depth is fixed and asserted needs no rewrite.

**Function length.** Seventy lines is what fits on a screen. A longer function
is split where its control flow splits, not at an arbitrary line: the parent
keeps the branches and the state changes, the helpers keep the straight-line
work.

## Determinism

The same inputs in the same order produce the same outputs in the same order.
Core logic gets there by doing no I/O of its own. Two shapes:

```text
Commands out                              Capabilities in

step(state, event, now) -> commands       tick(state, now, storage)
                                              storage.write(...)
shell:                                    
    for command in commands:              test:
        perform(command)                      tick(state, 1000, fake_storage)
```

- **Commands out.** The state machine returns what should happen: write these
  bytes, send this message, set this timer. A shell performs them. A recorded
  sequence of events replays with no shell at all.
- **Capabilities in.** The state machine calls an interface it is handed on
  each call. Tests hand it a simulated one that can also inject faults.

Either way the I/O, the clock and the randomness are parameters. They are not
fields of core state, not globals and not ambient calls.

Ambient inputs that break determinism without looking like I/O: the wall
clock, a random generator seeded from the system, environment variables, the
working directory, thread scheduling, the iteration order of an unordered map,
and memory addresses used as keys or for ordering.

What it buys: a failure reproduces from its seed, a simulator runs years of
faults in minutes, and a fuzzer explores states instead of timing.

## Resources

- Acquire and release in the same scope, with the release tied to leaving it
  on every path.
- Hold a resource for the shortest scope that works. A lock held across a call
  into code you do not control is held for an unknown time.
- Clear a reused buffer beyond what was written this time. The tail still has
  the last user's bytes, and they travel with the buffer into a file, a packet
  or a hash.
