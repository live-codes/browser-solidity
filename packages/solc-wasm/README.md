# @live-codes/solc-wasm

Compile and run **Solidity** in the browser and in Node, on the real `solc` compiled to WebAssembly,
executing on an in-page EVM.

```js
import { createCompiler } from '@live-codes/solc-wasm';

const solc = await createCompiler();
const result = await solc.run(source, { fn: 'greet()' });

result.returnValue; // 'message = "Hello from Solidity."'
result.stdout;      // the report a playground shows
solc.dispose();
```

No server, no wallet, no testnet, no network round trip at run time.

It is the same idea as [`@live-codes/clang-wasm`](https://www.npmjs.com/package/@live-codes/clang-wasm)
— a whole toolchain in one package, with a plain API, an IIFE build for classic workers and a
`copy-assets` CLI — for a language whose toolchain is a different shape. See
[How this differs from clang-wasm](#how-this-differs-from-clang-wasm); the differences are real and
worth reading before adopting it.

> **Status.** Working and tested, but young. The spike it comes from is in the repository root:
> [FINDINGS.md](../../FINDINGS.md) has the measurements behind the two constraints this package is
> built around.

## Install

```bash
npm install @live-codes/solc-wasm
```

Node needs nothing else. A browser needs the compiler published somewhere it can fetch — one command:

```bash
npx --package @live-codes/solc-wasm solc-wasm-copy-assets public/solc
```

That writes four files (about 9.7 MB) and prints the URL to pass as `baseUrl`.

## What `run` means

clang-wasm's `run(code, stdin)` compiles a program and executes it. Solidity has no stdin and no
top-level statements — the unit of execution is a contract's function — so `run` is compile, deploy,
call, and it reports all three.

```js
const result = await solc.run(
	`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Counter {
    event Incremented(uint256 value);
    uint256 public count;

    function increment() public { count += 1; emit Incremented(count); }
    function current() public view returns (uint256) { return count; }
}
`,
	{ fn: 'increment()' }
);
```

A second run whose bytecode and constructor arguments are unchanged **calls the instance the first run
deployed**, so `run(source, { fn: 'current()' })` afterwards returns `1`. Without that a counter could
never be seen to count, which is the point of the whole thing.

Three operations decide what happens to that state, and they are not the same:

| | |
| --- | --- |
| *(nothing)* | Reuse the instance, so state carries across runs. The default. |
| `redeploy: true` | Deploy another instance alongside the old one — a redeploy on a live chain, at a new address, starting empty. |
| `reset()` | Drop the world: a clean chain. |

`reset()` is the one to reach for when a run has to be **reproducible** — a script that increments a
counter should print `1` every time it runs. It is deliberately not `dispose()`: that would drop the
loaded compiler too, and the next run would pay the 9.2 MB download again.

### Accounts

`caller` is the sender of *a call*, not a property of the session. Accounts are funded and registered on
first use, so any number of them can be used against one deployed contract:

```js
await solc.run(source, { fn: 'restricted()', caller: owner });    // deploys, and is allowed in
await solc.run(source, { fn: 'restricted()', caller: stranger }); // same contract, reverts
```

That is what makes `msg.sender` observable, and with it every `owner`, role and
`require(msg.sender == …)` check — which is most of what anyone writes first. Deploy as the owner, call
as a stranger, watch it revert, all against the contract that is already there rather than a fresh one.

## API

### `createCompiler(options?)`

Loads the compiler and returns a compiler object. In the browser the load is the 9.2 MB download, so
this is the slow call — `onProgress` reports it.

| option | |
| --- | --- |
| `baseUrl` | Where `soljson.js` is served from. **Required in a browser**; optional in Node, where the copy inside the `solc` dependency is used. |
| `evmVersion` | The EVM dialect to compile for. One of `evmVersionsFor()`; default `'cancun'`. |
| `fileName` | The name the source is compiled under. Default `'contract.sol'`. |
| `contract` | The contract to run when the source declares several. |
| `caller` | The address that sends this run's calls, i.e. `msg.sender`. Per run, and accounts accumulate, so several senders can be used against one contract. Default `0x1111…1111`. |
| `gasLimit` | Default `30_000_000n`. |
| `onProgress` | `(value: number) => void`, 0 to 1. |

```js
const solc = await createCompiler({
	baseUrl: '/solc/',
	evmVersion: 'shanghai',
	onProgress: (value) => (bar.value = value)
});

solc.solcVersion;  // '0.8.37+commit.f401782d.Emscripten.clang'
solc.evmVersion;   // 'shanghai'
solc.evmVersions;  // every value it accepts
solc.fileName;     // 'contract.sol'
```

### `compiler.compile(code, options?)`

Compile without running. This is what you need to fill in a contract picker and an argument form
before anything is deployed, which is why it is not a side effect of `run`.

```js
const { contracts, errors, warnings, hasError, fileName } = await solc.compile(source);
contracts.Hello; // { name, abi, bytecode: '0x…', deployedBytecode: '0x…' }
```

### `compiler.run(code, options?)`

`compile` plus deploy plus call. Options are the same as `createCompiler`'s, per run, plus:

| option | |
| --- | --- |
| `fn` | The function to call, as a canonical signature — `'transfer(address,uint256)'`, not `'transfer'`. Omit to deploy only. |
| `args` | Arguments for `fn`, as an array. |
| `ctorArgs` | Arguments for the constructor. |
| `value` | Wei sent with the call, for payable functions. |
| `redeploy` | Deploy a new instance instead of reusing the last one. The old one stays in the world; see `reset()` for a clean chain. |

An `fn` that does not exist, or a `contract` that is not one of several, **rejects** rather than
returning a failed result: they are caller mistakes, not a program's outcome.

### `compiler.reset()`

Forget the world and the deployment, keeping the loaded compiler. Senders go back to nonce 0, so the
next deploy lands at the address the first one did — which is what makes a run reproducible.

Safe to call between runs, which is the only time it means anything.

### `compiler.dispose()`

Drops this compiler's hold on the shared compiler. The last one out tears it down. Further `run` or
`compile` calls throw.

Every compiler created against the same `baseUrl` shares one loaded compiler — and, in the browser, one
worker — so asking for two does not pay for the download twice.

### The result

All three kinds of run — compiled, not compiled, reverted — return the same keys, so a caller can read
`result.errors` without first working out which it is looking at.

| field | |
| --- | --- |
| `stdout` | The report: what was deployed, what the call cost, what came back, what was emitted. `string[]`. |
| `stderr` | The compiler's diagnostics, plus the revert reason if there was one. `string[]`. |
| `output` | `stdout` then `stderr`, joined. |
| `errors` | **The failure signal.** Error-severity diagnostics only, and `reverted: …` when a call reverted. Empty means it compiled and did not revert. |
| `warnings` | Warning-severity diagnostics. Kept apart from `errors` on purpose — see below. |
| `exitCode` | `0` ran, `1` reverted, `null` never got as far as deploying. |
| `compileMs`, `runMs` | Timings. `runMs` is `null` when nothing ran. |
| `contract`, `abi`, `bytecode` | What ran. |
| `contracts` | Everything solc produced, keyed by name. |
| `address`, `deployed` | Where it is, and whether this run deployed it (`'fresh'`) or reused it (`'reused'`). |
| `deployGas`, `gasUsed` | `bigint`, or `null`. |
| `fn`, `returnValue`, `returnData` | The call, its decoded returns as printable text, and the raw return data. |
| `events` | `[{ name, address, args }]`, decoded including indexed arguments. `name` is `null` for an event the ABI does not declare. |
| `revertReason` | `'Error("insufficient balance")'`, `'Unauthorized("0x…")'`, or the EVM's own wording. |
| `solcVersion`, `evmVersion`, `fileName` | |

**Warnings are not errors.** This is a deliberate difference from clang-wasm, where one `errors` array
holds whatever the compiler said. Solidity warns on code that is perfectly fine — a missing SPDX
identifier, an `evmVersion` older than `london`, an unused local — and a caller that treated every
diagnostic as fatal would refuse to run most of what users type. `errors` is what failed; `warnings` is
what to mention.

## In the browser

**Solidity cannot be compiled on a page's main thread, and that is not a performance preference.**
`soljson.js` instantiates a ~9.2 MB wasm module *synchronously* — it is built that way so `solc` can be
a synchronous API — and Chrome refuses to compile a wasm module over 8 MB on the main thread.
Emscripten does not throw: it logs `warning: failed to compile wasm module` and never finishes
initialising, so the page simply never becomes ready. On a worker thread the same synchronous compile
succeeds. [FINDINGS.md](../../FINDINGS.md) §2 has the measurements.

So the compiler always runs in a **classic worker**, and there are two ways to get there:

```html
<!-- 1. Your own classic worker. This is the shape LiveCodes gives its languages. -->
<script>
	importScripts('/solc/solc-wasm.global.js');   // must be an absolute URL
	const solc = await self.solcWasm.createCompiler({ baseUrl: '/solc/' });
</script>
```

```js
// 2. The module entry point, which spawns and owns a worker for you. The EVM stays on your thread.
import { createCompiler } from '@live-codes/solc-wasm';
const solc = await createCompiler({ baseUrl: '/solc/' });
```

Both load the same files, so the assets directory is the only thing to publish either way. A bundler
resolves the bare imports of route 2; without one, an import map does.

### Two bundles, and why

| file | size | for |
| --- | --- | --- |
| `solc-wasm.global.js` | ~464 KB | A worker that *is* the language host: it compiles and it runs. Sets `self.solcWasm`. |
| `solc-wasm-toolchain.global.js` | ~44 KB | Compile only. Sets `self.solcWasmToolchain`. This is what the module entry point's own worker loads. |

They stay separate because the EVM is a few hundred KB of JavaScript that a compile-only worker never
touches; the numbers above are the argument. Both bundles have the `solc` wrapper and its
dependencies compiled in, so neither needs a module loader.

## `evmVersion`

The counterpart to clang-wasm's `std`: which dialect the compiler emits for. Per-run overridable.

```
homestead  tangerineWhistle  spuriousDragon  byzantium  constantinople  petersburg
istanbul   berlin            london          paris      shanghai        cancun  prague  osaka
```

The list is not from documentation — it is what `solc` 0.8.37 accepts, checked by compiling at each
value. `amsterdam` is deliberately absent: `solc` accepts it only with `settings.experimental`.

The value configures **both** sides — the compiler and the `@ethereumjs` hardfork that executes the
result. That pairing is load-bearing rather than cosmetic: `cancun` bytecode run at `paris` means an
opcode like `MCOPY` is emitted by the compiler and then rejected by the VM. There is therefore no "let
solc decide" option, which is where this differs from clang-wasm's `std: null`.

## Node

```js
import { createCompiler } from '@live-codes/solc-wasm';

const solc = await createCompiler(); // no baseUrl: the `solc` dependency is the compiler
const result = await solc.run(source, { fn: 'count()' });
```

The compiler Node runs is read out of the installed `solc` package — the same bytes `copy-assets`
publishes for the browser. The `solc` wrapper is bundled into the IIFE builds; the compiler itself
never is, which is why it is fetched from `baseUrl` at run time.

## Verifying the compiler

`soljson.js` is checked against a pinned SHA-256 (size and digest) **before it is executed** — in the
browser, in `copy-assets`, and in the tests. A compiler that is not the one this package was built
against is refused with both hashes in the message, which matters because the alternative is running
9.2 MB of someone else's WebAssembly:

```
soljson.js failed SHA-256 verification: expected 221d7a66…, got 280875f7…. The compiler on that host
is not the one this package was built and tested against.
```

The receipt is in [`src/receipts.js`](src/receipts.js), next to a note worth reading before bumping the
version: **the build inside the `solc` npm package is not byte-identical to the release artifact at
`binaries.soliditylang.org`.** Same version, same commit, different embedded wasm (9 222 701 bytes
there, 9 237 611 here). Pinning the npm build is what keeps Node and the browser running the same
compiler rather than two builds that merely claim the same version.

## Testing

```bash
npm test          # 29 tests, real compiles, no network
npm run example   # builds the bundles, copies the assets, serves the example at :4180
```

The suite runs real compilations in Node — deploys, calls, events, reverts, custom errors, constructor
arguments, state across runs, `msg.sender`, payable calls — and pins the compiler to its receipt.

The example exercises both browser routes in a real page and reports which deployment, return value
and events each produced.

## Gotchas

Learned building this, each one a trap:

1. **`importScripts` rejects relative URLs.** `/solc/solc-wasm.global.js` fails; it has to be absolute.
   The package normalises `baseUrl` to an absolute URL internally for exactly this reason, so
   `createCompiler({ baseUrl: '/solc/' })` is fine — but `importScripts(baseUrl + '…')` in your own
   worker is not.
2. **A worker that fails to load reports `error` with an empty `message`.** Wire `worker.onerror`, or a
   typo in a path looks exactly like a hang.
3. **`@ethereumjs` v10 has no `Address.fromString`.** Addresses are built from bytes
   (`createAddressFromString`), and `Account`'s constructor is deprecated in favour of `createAccount`.
4. **Pin `@ethereumjs/vm`, `/util` and `/common` to the same version.** `Address` and `Account` cross the
   `vm` ⇄ `util` boundary; different instances break `instanceof` checks.
5. **This machine may omit devDependencies.** `npm config get omit` returning `dev` means `esbuild` is
   not installed by a plain `npm install`, so `npm run build:iife` fails. Use `npm install --include=dev`.
   The build output is committed, so this only affects rebuilding it.

## How this differs from clang-wasm

| | clang-wasm | solc-wasm |
| --- | --- | --- |
| Languages | c, cpp, objc, objcpp — one compiler, four dialects | Solidity only; the dialect axis is `evmVersion` |
| `run(code, stdin)` | compiles and runs a program | compiles, **deploys and calls** — `run(code, options)` |
| Runtime | wasm32-wasi module executed by a WASI host | EVM bytecode executed by `@ethereumjs/vm` |
| On the main thread | works, but blocks the UI | **cannot work at all**; a worker is required, and the module entry point provides one |
| Bundles | full API + low-level toolchain | full API + compile-only |
| `errors` | whatever the compiler said | error-severity only; warnings are separate |
| Assets | carried in the package, copied by `copy-assets` | read out of the `solc` dependency, copied by `copy-assets` |
| Compiler licence | permissive throughout | **GPL-3.0** — see below |

## License

MIT for everything in this package. The components it loads at run time are governed by their own:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

**The compiler is GPL-3.0, and that is the one difference worth pausing on.** The `solc` npm package
declares MIT, but that covers its JavaScript wrapper; `soljson.js` is a build of the Solidity compiler,
which is GPL-3.0. LiveCodes is MIT, so shipping this as a language means shipping a GPL-3.0 compiler
inside it — a decision to make deliberately rather than inherit from this package's own licence, exactly
as the GnuCOBOL question was for COBOL.
