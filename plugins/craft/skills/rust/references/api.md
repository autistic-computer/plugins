# Library API design

For a crate with users outside its repo. Every `pub` item is a promise, so the
interface gets the care application code does not need. Application code can
skip this file.

## Naming

| Prefix | Cost | Ownership |
|---|---|---|
| `as_` | free | borrowed to borrowed |
| `to_` | does work | borrowed to borrowed, or borrowed to owned |
| `into_` | varies | consumes `self` |

- `as_` and `into_` expose the representation; `to_` stays at the same level
  of abstraction and does work (`Path::to_str` checks UTF-8). A wrapper gives
  its value back with `into_inner()`. `mut` goes in type order:
  `as_mut_slice`.
- Getters: `first()`, `first_mut()`. A bare `get` only when there is one
  obvious thing to get. Beside them `set_foo(T)`, `take_foo()`,
  `replace_foo(T) -> T`, and `with_foo(|foo| ..)` for access behind a lock or
  a `RefCell`.
- Constructors: `new`; `with_capacity` or `new_with_foo` for variants;
  `try_new` when it can fail; `from_foo` for a conversion, paired with a
  `From` impl when it matters. I/O resources use the domain verb:
  `File::open`, `TcpStream::connect`.
- Iterators: `iter`, `iter_mut` and `into_iter` return `Iter`, `IterMut` and
  `IntoIter`. An iterator type is named after its method: `keys()` returns
  `Keys`.
- Type parameters are short and come from the main bound: `R: Read`.
- Don't repeat the module in the type: `foo::Id`, not `foo::FooId`.
- No `-rs` or `-rust` in a crate name.

## Standard traits

- A collection implements `FromIterator`, `Extend`, and `IntoIterator` for
  both the owned and the borrowed form. `size_hint` tells the truth.
- A flag-like number type also implements `LowerHex`, `UpperHex`, `Octal` and
  `Binary`.
- `Debug` output is never empty, even for an empty value.
- `serde` impls sit behind a feature named exactly `serde`.
- A type holding a raw pointer gets its `Send` and `Sync` checked by hand and
  pinned with a const assert.
- A smart pointer adds no inherent methods; it uses associated functions
  (`Box::into_raw(b)`), so a call can never be confused with the pointee's.
- A conversion lives on the more specific type (`str::as_bytes`,
  `str::from_utf8`).

## Parameters and returns

- Assume as little as the function needs: `impl IntoIterator<Item = T>` when it
  only iterates, `impl AsRef<Path>` when it only reads a path,
  `impl RangeBounds<T>` instead of a `(low, high)` pair, `impl Read` or
  `impl Write` by value (a caller keeps its file by passing `&mut file`).
  Every such parameter costs a copy of the function per type, so
  `impl Into<T>` is for the few calls where the call site really matters.
- Return an iterator instead of collecting into a `Vec` only to return it:
  `impl Iterator<Item = T>` internally, a named type for an interface that
  must stay stable. Return owned data when callers need ownership or random
  access, or when building the collection is the point.
- Hide an implementation type behind a newtype
  (`pub struct Lines<I>(Enumerate<Skip<I>>)`), so it can change.
- Expose work already done: `binary_search` returns the insertion point on a
  miss, `HashMap::insert` returns the old value.
- A function that consumes its argument and fails returns the argument inside
  the error, so the caller can retry without a clone.
- Take I/O as a parameter. A parser takes `impl Read` or a `&[u8]`, not a path
  it opens itself.

## Constructors and builders

- Provide `new()` even when `Default` exists, and make them agree.
- Up to two optional parameters: inherent constructors (`new`, `with_a`,
  `with_b`). Past that, or when construction validates or has side effects, a
  builder: `Foo::builder()` returns `FooBuilder`; setters are named after the
  field (`timeout(d)`, not `set_timeout`) and cannot fail; `build()` returns
  a `Result` and does all the validation, cross-field checks included.
- Builder setters take `&mut self` and return `&mut Self`. They consume `self`
  only when `build` has to move a value out.
- Four or more loose arguments become semantic types:
  `Deposit::new(account, amount)`.
- A bag-of-options struct with public fields implements `Default`, unless the
  options decide safety, durability or ordering.

## Visibility and evolution

- Private by default. Widen to `pub(crate)` or `pub(super)` before `pub`.
  Making an item more public later is not breaking; the reverse is.
- Fields stay private unless the struct is passive data. A public field fixes
  the representation and forbids an invariant.
- `#[non_exhaustive]` on a public enum, or a struct with public fields, that
  may grow. Not on a set that is closed by nature. It forces a wildcard arm on
  every user, so apply it on purpose.
- Seal a trait that outsiders must not implement, so methods can be added
  later:

```rust
mod private {
    pub trait Sealed {}
}

pub trait Encoding: private::Sealed {
    fn name(&self) -> &'static str;
}

pub struct Utf8;

impl private::Sealed for Utf8 {}

impl Encoding for Utf8 {
    fn name(&self) -> &'static str {
        "utf-8"
    }
}
```

- One path per public item. Not `pub mod db { pub struct Connection; }` and
  also `pub use db::Connection;`. A `pub(crate) mod` with one `pub use` is
  fine. Re-export item by item, never with a glob.
- Keep third-party types out of the interface unless they sit behind a feature
  or clearly earn their place. Where one must appear, re-export its crate so
  callers can name the matching version. `From<other::Error>` on a public
  error leaks `other`.
- Don't `pub use` another crate's items unless this is an umbrella crate.
- `const fn` only when it will stay `const`. No public `ErrorKind` that locks
  in failure modes.
- No statics or thread-locals where one consistent value matters: two
  incompatible versions of the crate in one build each get their own.
- `#[doc(hidden)]` on an impl users never call directly, such as
  `From<PrivateError> for PublicError`.

## Traits and generics

- Define a trait only for generic code (`T: Trait`, `impl Trait`,
  `dyn Trait`) or as an extension trait named `FooExt`. Not to organize code.
- Core functionality goes in inherent methods, and trait impls forward to
  them, so callers need no import.
- Prefer, in order: a concrete type; a generic over a narrow trait;
  `dyn Trait` wrapped in your own struct (`struct DynStore(Arc<dyn Store>)`).
  Generics give static dispatch and inlining for code size and compile time.
  Trait objects give heterogeneous collections and smaller binaries.
- No nested type parameters on a service-level type: `Service<Backend>`, not
  `Service<Backend<Store>>`.
- Decide early whether a trait must be object-safe. A generic method, or
  `Self` outside the receiver, breaks it unless excluded:

```rust
pub trait Shape {
    fn area(&self) -> f64;

    fn scaled<T: Into<f64>>(&self, factor: T) -> f64
    where
        Self: Sized,
    {
        self.area() * factor.into()
    }
}
```

- Few required methods, with defaults for everything derivable from them, the
  way `Iterator` builds on `next`.
- A function with a clear receiver is a method. One without is a free
  function, not `Database::check(params)`. Associated functions construct.
- Closures: the most general bound that works (`FnOnce`, then `FnMut`, then
  `Fn`), a `Fn*` bound rather than an `fn` pointer, last in the parameter
  list, at most one.
- Where an invalid call should not compile, put the protocol state in a type
  parameter: `Request<Unsent>` has `send`, `Request<Sent>` does not.
- Choose between two readers or writers at run time without a `Box`:

```rust
let mut stdin = std::io::stdin();
let mut file;
let reader: &mut dyn std::io::Read = if path == "-" {
    &mut stdin
} else {
    file = std::fs::File::open(path)?;
    &mut file
};
```

- No run-time reflection through `Any`. Say what is required with a trait.

## Macros

- A macro is the last resort, after functions, generics and traits.
  `macro_rules!` before a proc macro.
- Input looks like the output it produces.
- A macro never changes what kind of item a type is, changes a function's
  signature, or adds or removes `async`.
- Items a macro emits accept attributes, work at module and at function scope,
  and are private unless the input says `pub`.
- A proc-macro crate is a thin shim over an ordinary library crate that holds
  the logic and its tests.

## Semver and features

- Breaking: removing or renaming a public item; adding a variant to an enum
  that is not `#[non_exhaustive]`; adding a public field to a struct that can
  be built with a literal; adding a trait bound; making a trait
  non-object-safe; adding a blanket impl; removing `const`; changing the
  default features.
- Deprecate in a minor release before removing in a major one.
- Features are additive, because Cargo unifies them across the whole graph.
  Don't gate a struct field or a trait method behind one. A `std` feature
  sits on a `no_std` base. Mocks and fakes go behind `test-util`.
- Set `rust-version` on purpose and raise it only in a minor release.
- A 1.0 crate needs every crate whose types appear in its interface to be
  stable too.
- `[package]` carries `description`, `license` and `repository`.
- The crate builds on tier-1 targets with cargo and rustc alone. Code
  generation runs before publishing and its output ships in the crate.
