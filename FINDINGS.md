# Spike findings — Solidity in the browser

**Status: spike complete.** The page compiles Solidity typed into it and executes the result on an
EVM, in the tab, with no server-side compilation — and, unlike the COBOL work in `browser-cobol`,
**no cross-origin isolation either**. Everything below was **run**, in headless Chrome 153, not
inferred from docs.

> **Where this ended up.** The spike graduated into a package: [`packages/solc-wasm`](packages/solc-wasm)
> is `@live-codes/solc-wasm`, shaped like `@live-codes/clang-wasm`, and the page in `public/` is now a
> consumer of it rather than an implementation of its own. The measurements below are the evidence that
> built it and have not been rewritten; where a conclusion has since changed, the change is marked in
> place. Two are worth knowing before reading: the CORS mirrors in §3 are **not** the same bytes as the
> official artifact, and the loading variant §4 selected is no longer the one in use.

## 1. The pipeline, and why it is this one

```
Solidity source
  → solc 0.8.37 (WebAssembly)        in a Web Worker      → ABI + creation bytecode
  → @ethereumjs/vm 10.1.3 (pure JS)  on the main thread    → deploy, then call
  → ethers 6 (pure JS)               on the main thread    → calldata in, values/logs/errors out
```

Two things drove this shape: the compiler **cannot** run on the page's main thread (§2), and the
official compiler CDN **cannot** be used from a worker (§3). Neither is obvious, and both were
found by running the thing rather than reading about it.

Alternatives considered and rejected:

| Candidate | Why it does not work here |
| --- | --- |
| Compile on the main thread (the obvious version) | Chrome refuses to synchronously compile a wasm module >8 MB on the main thread, and emscripten's response is to swallow the error and never finish initialising (§2). |
| `soljson.js` from `binaries.soliditylang.org`, in a worker | That host sends no `Access-Control-Allow-Origin`, so a worker cannot `importScripts` or `fetch` it. A classic `<script>` tag does work — but only on the main thread, where §2 then applies (§3). |
| `solc` via a bundler (`import solc from 'solc'`) | Works, and is what most playgrounds do, but it puts a build step and a `node_modules` in a repo whose whole point is to be two files and a CDN. |
| `ethers` alone for "running" | `ethers` has no EVM. It encodes and decodes; it cannot execute. |
| A subset interpreter / regex "Solidity runner" | Not a real compiler, and the ecosystem's own policy forbids subset executors as language support. |

The one stack that does the whole thing client-side is the official `solc` wasm build plus
`@ethereumjs/vm`. `@ethereumjs/evm` is where the interpreter actually lives; `@ethereumjs/vm` is
used only because `createVM()` wires up a `Common` (chain/hardfork) and a working state manager for
us, which is otherwise the fiddliest part of standing up a bare EVM.

## 2. The headline finding: the compiler cannot run on the main thread

**Symptom.** `solc.compile(...)` on the page's main thread throws:

```
RangeError: WebAssembly.Compile is disallowed on the main thread, if the buffer size is larger
than 8MB. Use WebAssembly.compile, compile on a worker thread, or use the flag
`--enable-features=WebAssemblyUnlimitedSyncCompilation`.
```

On its own that reads like "use `WebAssembly.compile` instead". It is not that. `soljson.js` is
built with `WASM_ASYNC_COMPILATION=0` — it *must* instantiate synchronously so that `solc` can be
used as a synchronous API — and it embeds its ~9.2 MB module as base64 inside the JS:

```
var Module = Module || {}; Module["wasmBinary"] = (function(source, uncompressedSize) { ...
```

so the buffer is always over the limit. The same error appears whether the compiler is loaded from
esm.sh or from the raw official `soljson.js` via a `<script>` tag.

**The part that costs an afternoon.** emscripten *catches* that error, logs
`warning: failed to compile wasm module: RangeError: ...`, and then never completes initialisation.
The script finishes, `window.Module` exists, and `Module.cwrap` is `undefined` — there is no
exception to catch, no rejected promise, and nothing on the console but a warning. Loaded in a
worker, the same failure mode is a silent hang instead. A page built the obvious way just never
becomes ready.

**The measurement.** Chrome's limit applies to the main thread only. Probed with a synthetic
module — a valid wasm binary padded to size with one custom section — so the result does not depend
on `solc`:

| module size | main thread, `new WebAssembly.Module()` | worker, sync | worker, async |
| --- | --- | --- | --- |
| 2 MB | OK | — | — |
| 7 MB | OK | OK | OK |
| 9 MB | **RangeError** | OK | OK |
| 12 MB | **RangeError** | OK | OK |

So: **the compiler runs in a worker.** In the spike that was `public/solc-worker.js`; it is
`packages/solc-wasm/src/host.inline.js` now, and the two say the same thing. This is not a
performance nicety, it is the only way it works.

## 3. The second finding: the official compiler CDN has no CORS

The natural way to get a real, version-pinned compiler is
`https://binaries.soliditylang.org/bin/soljson-<version>+commit.<hash>.js`. Checked directly:

```
GET https://binaries.soliditylang.org/bin/soljson-v0.8.37+commit.f401782d.js
  status: 200
  access-control-allow-origin: (absent)
  content-type: text/javascript
```

No `Access-Control-Allow-Origin` means a worker cannot `importScripts` it and the page cannot
`fetch` it. A classic `<script>` tag *can* load it (script tags are not CORS-restricted) — which is
exactly why the failure in §2 looks like a wasm problem on a page where the download clearly
succeeded.

CORS-enabled mirrors exist, because the file also ships in the `solc` npm package:

| source | CORS |
| --- | --- |
| `binaries.soliditylang.org/bin/soljson-*.js` | **none** |
| `cdn.jsdelivr.net/npm/solc@0.8.37/soljson.js` | `*` |
| `unpkg.com/solc@0.8.37/soljson.js` | `*` |
| `esm.sh/solc@0.8.37` | `*` |

**Corrected after the fact: those mirrors are not the same artifact.** This section first called them
that, and they are not. For 0.8.37 the npm package's `soljson.js` is 9 237 611 bytes, sha256
`221d7a66…`, while `binaries.soliditylang.org` serves 9 222 701 bytes, sha256 `d73fead3…` — same
version, same commit, and different bytes from offset 26 onwards, so the embedded wasm itself differs
rather than just the glue around it. Both compile correctly; they are two builds of one release.

Two consequences. Anything that pins a compiler has to pin a *build* and say which. And the
comparison above is about **headers, not content** — the reason to host the compiler yourself is that
a worker cannot reach `binaries.soliditylang.org` at all, not that the CDN copies are interchangeable
with it.

`packages/solc-wasm` pins the npm build, because that is the copy the `solc` dependency installs and
therefore the one Node and a browser can be made to run identically. It still does not load it from a
CDN: `solc-wasm-copy-assets` writes it into a directory you serve, so the bytes are yours and checked
against a hash before they are executed.

## 4. Loading the compiler in a worker — four variants, all tested

Every variant below ran in a real worker in headless Chrome. "Compile" means: compile a trivial
contract and read back a 201-byte bytecode blob.

| variant | worker | how it loads | result |
| --- | --- | --- | --- |
| `esm.sh` `solc` | module | `import solc from 'https://esm.sh/solc@0.8.37'` | works — **376 ms** |
| jsDelivr `soljson.js` + `esm.sh` wrapper | classic | `importScripts(...)` then dynamic `import(...)` | works — 2227 ms |
| jsDelivr `soljson.js` + `new Function` | module | `fetch` the text, evaluate it, apply the wrapper | works — 323 ms |
| jsDelivr `soljson.js` alone | classic | `importScripts(...)` | `Module` + `cwrap` present; compiles |

**The spike used variant 1**, and it is still the least code — but it is no longer what this repository
runs. `packages/solc-wasm` settled on a hybrid of variants 2 and 4: the official wrapper is *bundled*
(so a CommonJS package needs no module-resolution step), and `soljson.js` is fetched from the base URL
you host, verified against its pinned hash, and handed to `importScripts` as a blob URL. That keeps the
official artifact, drops the runtime CDN dependency, and makes the bytes that execute the bytes that
were checked. Variant 3 remains the one to avoid: it evaluates 9 MB of fetched text, which any sane CSP
forbids.

One thing we did **not** chase down, recorded so it is not rediscovered later: an early run of
variant 1 received no response at all for 120 s — no error, no result — and the identical variant
completed in 376 ms afterwards. All four variants were re-run successfully later. The plausible
explanation is esm.sh building a 9 MB bundle on demand at the edge; it is not confirmed. **If we
come to depend on esm.sh, confirm this** — it is the difference between a 400 ms first run and a
hang.

## 5. Running the bytecode: what `@ethereumjs` v10 actually looks like

`@ethereumjs/vm` 10.1.3 is a large API change from the versions most examples on the web use. The
parts that matter:

```js
const vm = await createVM({
  common: new Common({ chain: Mainnet, hardfork: Hardfork.Cancun }),
});

// deploy: omit `to`, and the created address comes back on the result
const deployed = await vm.evm.runCall({ caller, data: creationBytecode, gasLimit });
deployed.createdAddress;                       // Address
deployed.execResult.executionGasUsed;          // bigint

// call: pass `to`
const called = await vm.evm.runCall({ caller, to: address, data: calldata, gasLimit });
called.execResult.returnValue;                 // Uint8Array
called.execResult.logs;                        // [address, topics[], data][]
called.execResult.exceptionError;              // { error: 'revert', ... } | undefined
```

Four details worth writing down:

- **`Address.fromString` does not exist.** v10 constructs addresses from bytes:
  `createAddressFromString(hex)` / `createAddressFromBigInt(value)` / `createZeroAddress()`. The
  `Account` constructor is deprecated in favour of `createAccount({...})`.
- **Version-pin the `@ethereumjs` packages together.** `Address` and `Account` instances cross the
  `vm` ⇄ `util` boundary, so `@ethereumjs/vm`, `@ethereumjs/util` and `@ethereumjs/common` must
  resolve to the *same* module instance or `instanceof` checks fail. Pinning all three to `10.1.3`
  gives identical esm.sh URLs and therefore one shared instance.
- **`runCall` at depth 0 increments the caller's nonce**, so each deploy lands at a new address.
  The caller needs an account in the state (`stateManager.putAccount`); `skipBalance: true` spares
  it having to hold ether.
- **Pin the Solidity `evmVersion` and the EVM hardfork together.** We compile with
  `evmVersion: 'cancun'` and run at `Hardfork.Cancun`, so an opcode like `MCOPY` always has an
  implementation on both sides.

`ethers` is used only as an ABI codec, but it earns its place: `Interface` gives
`encodeFunctionData`, `encodeDeploy`, `decodeFunctionResult`, `getFunction`, plus `parseLog` and
`parseError`, which handle indexed event topics and revert payloads without hand-rolled decoding.

## 6. What the compiler tells the user

Diagnostics are genuine `solc` output, including the source excerpt and the caret. A one-character
mistake in this spike's own example produced:

```
SyntaxError: This looks like an address but has an invalid checksum. Correct checksummed address:
"0xBEEF00000000000000000000000000000000BEEf". If this is not used as an address, please prepend
'00'. For more information please see https://docs.soliditylang.org/en/develop/types.html#address-literals
 --> contract.sol:7:37:
  |
7 |     address public constant OWNER = 0xBEEF00000000000000000000000000000000BEEF;
  |                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

and a parser error:

```
ParserError: Expected ';' but got '}'
 --> contract.sol:1:36:
  |
1 | contract Broken { uint256 public x }
  |                                    ^
```

Two contract-level details this forced: `solc.compile` **returns** compile errors in
`output.errors` rather than throwing (only a broken call throws), so the page must scan
`errors[].severity === 'error'` and refuse to deploy; and compilation diagnostics and execution
results belong in separate panes, because the return value of a *successful* compile is
uninteresting and the diagnostics of a failed one are the whole story.

## 7. Verified working

Each row was produced by selecting the example, clicking **Compile & run**, and reading the output
pane back — verbatim, with isolation never entered:

| example | result |
| --- | --- |
| `Hello, World` | `message = "Hello from Solidity, compiled and run in your browser."` |
| `Counter (storage)` | `increment()`, then `current()` → `#0 = 1` — the second run reuses the deployed instance, so state survives |
| `Events` | `Transfer(from: "0x1111…1111", to: "0x…dEaD", value: 1000)` parsed from the log |
| `Revert with a reason` | `require` → `reverted: Error("insufficient balance")` |
| `Custom error` | `revert Unauthorized(msg.sender)` → `reverted: Unauthorized("0x1111…1111")` |
| `Structs and loops` | `add("widget", 5)` then `all()` → `list = [["widget", 5]]` |
| invalid source | `ParserError` with excerpt; nothing deployed |

Timings, fresh page, warm HTTP cache:

| | |
| --- | --- |
| first run (worker + 9 MB compiler initialisation + compile + deploy + call) | ~2.5–3.2 s, of which compile 307–415 ms |
| subsequent compile (worker warm) | **9–57 ms** |
| deploy (`Hello`, 387-byte bytecode) | 71 921 gas |
| call (`greet()`) | 631 gas |

Cost is entirely in the one-time toolchain load; the edit–run loop after it is effectively instant.

## 8. Payload

Measured while the spike loaded `solc` from esm.sh. The shape of the total has not changed now that
the compiler is hosted rather than imported from a CDN, but the request count has: the npm build is one
9 237 611-byte file rather than a module plus a pile of Node shims.

| asset | decoded | requests |
| --- | --- | --- |
| `solc` in the worker (the esm.sh build) | 8.92 MB | 28 |
| &nbsp;&nbsp;— of which the compiler module, wasm embedded as base64 | 8.78 MB | 1 |
| `@ethereumjs/vm` + `util` + `common` + `ethers` on the page | 0.54 MB | 51 |
| **total** | **~9.5 MB** | ~79 |

The compiler carries its wasm inline, so there is no separate `.wasm` fetch and no streaming
compilation — which is precisely why §2 bites. Served directly, it is one 9 237 611-byte file: the same
compiler, without the module shim and Node shims the esm.sh build carries around it.

Nothing is committed to this repository. The compiler is written into `solc-assets/` by `npm start`
and is not in version control; the package ships the two bundles from `dist/` and no compiler at all.

## 9. Recommendation for LiveCodes

- **Start from `packages/solc-wasm`.** It is this spike's outcome, and it already has the shape a
  LiveCodes language wants: a `createCompiler`/`run`/`dispose` API, an IIFE build for a classic worker,
  a `copy-assets` CLI, pinned compiler hashes and a test suite. Most of what follows is therefore a note
  on why it is built this way rather than a list of work.
- **Shape:** `lang-solidity` with `scriptType: 'text/solidity'`, `compiler.factory` returning
  identity, and `scripts: [baseUrl + '{{hash:lang-solidity-script.js}}']` — the same shape as
  `lang-clang-wasm` and `lang-cobol`.
- **The runner must own a worker.** Not optional and not a detail to "optimise later": without one,
  nothing runs (§2). LiveCodes already has a worker-based runner pattern for its wasm languages;
  `solc-wasm.global.js` is what that worker `importScripts`, and the compiler never touches the main
  thread. The example in `packages/solc-wasm/example/worker.js` is that worker in fifteen lines.
- **Do not point the worker at `binaries.soliditylang.org`.** It sends no `Access-Control-Allow-Origin`,
  so a worker cannot load it at all (§3). Host `soljson.js` yourself — in `browser-compilers`,
  referenced from `vendors.ts`, pinned by hash — and pass the directory as `baseUrl`.
  `solc-wasm-copy-assets` produces exactly that directory, and the package verifies each byte against
  the pin before executing it.
- **`largeDownload: true`** — ~9.5 MB on first run.
- **`baseUrl` must be absolute in a worker.** `importScripts` rejects a relative path outright, which is
  a trap for anyone writing the runner by hand; the package normalises it internally, so passing the
  assets URL is enough.
- **Contract mapping:** the deploy address, the decoded return value and the parsed events are stdout;
  compiler diagnostics and revert reasons are stderr; `exitCode` is `1` on a revert, `0` on success and
  `null` when the source never got as far as deploying. `errors` is the signal to check, and it holds
  **error-severity diagnostics only** — warnings are separate, because `solc` warns on code that is
  perfectly fine and a runner that treated every diagnostic as fatal would refuse to run most of what
  users type. A compile failure is a *successful* compiler call yielding `errors[]`, not an exception —
  the same asymmetry `browser-cobol` documented for `cobc`.
- **One open question for the product, not the spike:** the `solc` npm package declares MIT, but
  the compiler it wraps is the Solidity compiler, which is GPL-3.0. LiveCodes is MIT. Worth a
  deliberate decision before this ships, exactly as the GnuCOBOL GPL-3 question was for COBOL.
- **`console.log` is not wired.** Hardhat's console (`0x…636F6E736F6C652E6C6F67`) is a precompile,
  not part of the VM, so `console.log` compiles and silently does nothing. Adding it is a
  `customPrecompiles` entry and would be a large usability win — it is the single most expected
  thing a Solidity playground user will try.

## 10. Behaviour worth knowing

- **Imports are not resolved.** The worker compiles one source unit; `import "..."` fails with a
  source-not-found error. `solc` supports an import callback (the official wrapper uses one), so
  this is a wrapper feature to add, not a compiler limitation.
- **Runs reuse a deployment by default.** A second run with unchanged bytecode and constructor
  arguments calls the instance already deployed, so state written by one function is visible to the
  next; **Redeploy** starts a fresh one. Without this, a "counter" that increments is meaningless,
  because every run would begin from a clean contract.
- **State is per page load, in memory.** Nothing is persisted, and a reload starts from scratch.
- **Gas is reported but never charged.** The caller is funded with `10^18` wei and `skipBalance`
  is on, so out-of-gas is the only gas-related failure a user can hit.
- **`evmVersion` is pinned to `cancun`**, matching `Hardfork.Cancun`. Bumping the compiler without
  bumping the EVM (or the reverse) is the kind of change that produces invalid-opcode errors on
  working code.

## 11. Reproducing the verification

```bash
npm start                            # copies the compiler into solc-assets/, then → :8127/
npm run check                        # syntax-check serve.js and the page's modules
npm --prefix packages/solc-wasm test # the package's own tests, 29 of them, real compiles
```

`npm start` has to copy the compiler first because the page is a consumer of the package now: the
package fetches `soljson.js` from a URL, so it has to exist at one.

Driven here with the `agent-browser` CLI against headless Chrome: select the example, click
**Compile & run**, wait for `document.documentElement.dataset.stage` to leave the running states,
then read `#output`, `#diagnostics` and the dataset (`stage`, `runs`, `solc`, `compileMs`,
`contract`, `fn`, `deployed`, `address`, `deployGas`, `gas`, `logs`, `return`, `exitCode`). Element
ids are exposed as globals (`editor`, `run`, `reset`, `output`, `diagnostics`, `examples`,
`contract`, `fn`, `ctorArgs`, `fnArgs`) so probes can avoid string literals — shells mangle quotes
in native-command arguments.

The §2 limit table was produced by generating wasm binaries of a chosen size (a valid header plus
one custom section padded to length) and calling `new WebAssembly.Module` on them, on the main
thread and in a worker. The §8 payload table was produced by walking the module graph from each
entry URL, following every absolute import specifier, and summing decoded sizes.
