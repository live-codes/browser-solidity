# Browser Solidity

Compile and run **Solidity entirely in the browser** — no server, no upload, no wallet, no testnet.
The compiler and the EVM both run in the tab, so a contract typed into the page is compiled, deployed
and called without a single byte leaving it.

It is a proof of concept for adding a `solidity` language to [LiveCodes](https://livecodes.io), in the
same shape as [`browser-cobol`](https://github.com/live-codes/browser-cobol) and
[`browser-haskell`](https://github.com/live-codes/browser-haskell) were for their languages.

This is the **real Solidity compiler**, not a subset or a simulated VM:

```
Solidity source
  → solc 0.8.37 (WebAssembly)      in a Web Worker    → ABI + creation bytecode
  → @ethereumjs/vm 10.1.3          in this tab        → deploy, then call
  → ethers 6                       in this tab        → calldata in, values/logs/errors out
```

The whole of that is [**`@live-codes/solc-wasm`**](./packages/solc-wasm), which lives in this
repository. This page is a consumer of it: an editor, a contract and function picker, and somewhere to
put the report. The spike that led to the package — including the two constraints it is built around —
is in [FINDINGS.md](./FINDINGS.md).

## Demo

```bash
npm start          # copies the compiler into solc-assets/, then → http://localhost:8127/
```

Pick an example (or type your own), choose a function, press **Compile & run** — or `Ctrl`/`Cmd` +
`Enter` in the editor. The deploy address, the decoded return value and any emitted events appear in
the output pane; `solc` diagnostics appear below it.

A static server is required, because `file://` cannot run ES modules, spawn a worker or fetch the
compiler — but it needs no special headers, and `serve.js` is a plain file server with no
configuration.

**~9.5 MB is fetched on the first run** and cached afterwards. The compiler is not fetched at all: it
is copied into `solc-assets/` by `npm start` and served from there, and the package verifies it against
a pinned SHA-256 before executing it. The EVM's JavaScript comes from esm.sh, as resolved by the import
map in `index.html`. There is no bundler and no `node_modules` for this page.

## If you read one thing about this repo

**The Solidity compiler cannot run on a page's main thread.** Chrome refuses to synchronously compile a
WebAssembly module larger than 8 MB on the main thread, and `solc`'s wasm build *is* synchronous (it
embeds ~9.2 MB of wasm as base64) — so the obvious implementation does not fail loudly, it just never
becomes ready. Emscripten catches the size error, logs a warning, and leaves `Module.cwrap` undefined.

The compiler therefore runs in a worker, where the same synchronous compilation succeeds.
`packages/solc-wasm/src/host.inline.js` is that worker, and this page never touches it. The
measurements are in [FINDINGS.md](./FINDINGS.md) §2 — along with why the official compiler CDN cannot
be used from a worker at all (§3).

## What this page still does itself

Not much, which is the point. `public/main.js` is the UI and nothing else:

- it calls `createCompiler`, `compile` and `run`, and renders `stdout` and `stderr`
- it fills the pickers from a real compilation before deploying anything, so a selection can never name
  a contract or function that no longer exists
- it turns the argument inputs into arrays

Everything else — loading 9.2 MB of compiler into a worker, applying the `solc` wrapper, deploying,
encoding calldata, decoding return values, events and revert payloads — is the package's.

## What you get

- **Client-side compilation and execution.** Nothing is uploaded; `solc`, the EVM and the deployed
  contract all run in the tab.
- **Real compiler diagnostics** — `solc` messages with the source excerpt and the offending line
  marked, including genuine address-checksum and parser errors.
- **Real EVM semantics.** State that persists across calls, `msg.sender`, constructors with arguments,
  `view` and state-changing functions, events with indexed arguments, `require` reasons and custom
  errors — all decoded back into readable form.
- **A contract selector, a function selector, JSON arguments and a caller address**, so you can call any
  ABI function as any account without editing the source. The caller is what makes `msg.sender`
  observable — the access-control examples revert for one address and run for another, against the same
  deployed contract. **Redeploy** starts from a clean chain.
- **An edit–run loop that is effectively instant** once the compiler is warm: ~9–57 ms per compile.
- **No cross-origin isolation.** Unlike the COBOL and Elixir runtimes, this one needs no
  `SharedArrayBuffer` and therefore no COOP/COEP headers — so a page like this can be embedded
  anywhere.

## Verified

Every row below was run through the page in headless Chrome and the output pane read back — re-run
after the page was rewired onto the package, with the same results it produced before.

| example | result |
| --- | --- |
| `Hello, World` | `message = "Hello from Solidity, compiled and run in your browser."` |
| `Counter (storage)` | `increment()` then `current()` → `1` (state survives between runs) |
| `Events` | `Transfer(from: "0x1111…", to: "0x…dEaD", value: 1000)` |
| `Revert with a reason` | `reverted: Error("insufficient balance")` |
| `Custom error` | `reverted: Unauthorized("0x1111…")` |
| `Structs and loops` | `add("widget", 5)` then `all()` → `[["widget", 5]]` |
| invalid source | `ParserError: Expected ';' but got '}'` + excerpt, nothing deployed |
| **Redeploy** | clean chain: `fresh`, the same address the first deploy used, `current()` back to `0` |
| **Caller** | same contract, two accounts: reverts for `0x1111…` and runs for the declared owner |

Fresh page, warm cache: first run ~2.5–3.2 s (~0.4 s of it compiling). After that, compiles land in
**9–57 ms**.

## Limitations

- **~9.5 MB on first run.** It works on a laptop; it is not a small download. Subsequent runs reuse the
  HTTP cache.
- **No imports.** One source unit; `import "..."` fails. `solc` supports an import callback, so this is
  a wrapper feature rather than a compiler limitation.
- **`console.log` does nothing.** Hardhat's console is a precompile, not part of the EVM. Adding it is a
  `customPrecompiles` entry and would be the highest-value next step.
- **No persistence.** State lives in memory for the page load and is gone on reload.
- **Gas is reported, never charged.** Out-of-gas is the only gas-related failure you can hit.
- **One pinned compiler.** `solc` 0.8.37, matched to `Cancun`; there is no version picker.
- **`run` compiles twice per click** — once for the pickers, once to execute. The second is tens of
  milliseconds against a download that has already happened, and it is what makes a stale selection
  impossible.

## Layout

```
public/index.html        the page: editor, pickers, output and diagnostics
public/main.js           the driver: calls the package, renders the result
public/examples.js       the starter programs
serve.js                 static server: mounts the page, the package and the compiler assets
packages/solc-wasm/      @live-codes/solc-wasm — the compiler, the worker and the EVM
solc-assets/             generated by `npm start`, not in version control
FINDINGS.md              the spike log: what was verified, what breaks, what it means
```

There is no bundler. The page resolves `@live-codes/solc-wasm` through the import map in `index.html`,
which is standing in for what a bundler would do — including pinning the three `@ethereumjs` packages to
the same version the package pins, because `Address` and `Account` cross the `vm` ⇄ `util` boundary.

## Verifying

| what | command |
| --- | --- |
| copy the compiler and serve the page | `npm start` → http://localhost:8127/ |
| copy the compiler only | `npm run assets` |
| check syntax | `npm run check` |
| the package's own tests | `npm --prefix packages/solc-wasm test` |
| the package's browser example | `npm --prefix packages/solc-wasm run example` |

The page exposes `document.documentElement.dataset` (`stage`, `runs`, `solc`, `compileMs`, `contract`,
`fn`, `deployed`, `address`, `deployGas`, `gas`, `logs`, `return`, `exitCode`) and every element id as a
global, so scripted checks can read state without string literals.

## Status

Spike complete, and now a consumer of the package it produced. Next: add the `lang-solidity` runner to
LiveCodes, loading `solc-wasm.global.js` in a classic worker — see
[packages/solc-wasm/README.md](./packages/solc-wasm/README.md) for the API and
[FINDINGS.md](./FINDINGS.md) §9 for the integration notes.

## License

MIT © Hatem Hosny. The compiler and libraries this page loads at runtime are governed by their own
licenses — see [LICENSE](LICENSE). Note that the Solidity compiler itself is **GPL-3.0**;
[packages/solc-wasm/THIRD-PARTY-NOTICES.md](./packages/solc-wasm/THIRD-PARTY-NOTICES.md) sets that out.
