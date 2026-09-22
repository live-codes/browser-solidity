# Third-party notices

This package is MIT. What it depends on, bundles and loads at run time is not, and one of those is the
reason this file exists.

## The compiler: GPL-3.0

**`soljson.js` is a build of the Solidity compiler, which is licensed GPL-3.0.**
([`ethereum/solidity`](https://github.com/ethereum/solidity) ships GPL-3.0 as its `LICENSE.txt`.)

Two things about that are easy to get wrong:

- The `solc` **npm package** declares MIT. That covers its JavaScript wrapper — the files that drive
  the compiler through `cwrap`. It does not cover `soljson.js`, which that wrapper drives.
- **This package neither bundles nor redistributes `soljson.js`.** It ships no compiler at all: Node
  reads the copy the `solc` dependency installs, and a browser fetches a copy you publish with
  `solc-wasm-copy-assets`. The compiler is a separate component at run time, not a part of this
  package's distribution.

That keeps the licensing question where it belongs — with whoever redistributes or hosts the compiler —
but it is a real question. **Anyone shipping this as part of a product should decide it deliberately**,
particularly if that product is itself MIT. It is the same shape of decision the GnuCOBOL GPL-3
compiler was for COBOL.

## Bundled into the IIFE builds

`dist/solc-wasm.global.js` and `dist/solc-wasm-toolchain.global.js` are self-contained: the bundler
inlines everything below, so a classic worker needs no module loader. The license comments found in the
bundled sources are preserved next to each build in `dist/*.LEGAL.txt`.

| component | licence |
| --- | --- |
| `solc` — the JavaScript wrapper, bindings, translator and formatters | MIT |
| `@ethereumjs/vm`, `/evm`, `/statemanager`, `/block`, `/tx`, `/mpt`, `/rlp`, `/util`, `/binarytree`, `/common` | MPL-2.0 |
| `ethers` | MIT |
| `@noble/curves`, `@noble/hashes` | MIT |
| `js-sha3` | MIT |
| `eventemitter3` | MIT |
| `debug`, `ms` | MIT |
| `semver` | ISC |
| `tslib` | 0BSD |

Two Node-only modules that `solc/wrapper.js` requires — `memorystream` (MIT) and `follow-redirects`
(MIT) — are **not** bundled. They belong to `loadRemoteVersion`, which downloads a compiler over Node's
`http`/`https`; that code path is unreachable here and cannot work in a browser anyway, so the build
substitutes stubs that throw. The same applies to Node's `assert`, which is replaced by a small
stand-in in `scripts/stubs/`.

`solc-wasm.global.js` also carries the EVM. `solc-wasm-toolchain.global.js` does not: it is the
compile-only build, so a worker that only compiles does not download an EVM it never calls.

## Dependencies of this package

Not bundled; resolved by your bundler or import map.

| package | licence |
| --- | --- |
| `@ethereumjs/common`, `@ethereumjs/util`, `@ethereumjs/vm` | MPL-2.0 |
| `ethers` | MIT |
| `solc` | MIT (wrapper; the compiler it loads is GPL-3.0, above) |
| `esbuild` (development only, to build the IIFEs) | MIT |

## MPL-2.0

The `@ethereumjs` packages are MPL-2.0, which is file-level copyleft: modifications to *their* files
carry the MPL, while this package's own files remain MIT. Nothing in `src/` modifies them; the IIFE
bundles inline them unmodified, with their license comments preserved in the sidecar.

## What the compiler is checked against

The compiler is pinned by size and SHA-256 in [`src/receipts.js`](src/receipts.js) and refused if it does
not match, so a host cannot silently substitute a different build.

That pin is for the `solc` **npm** build, not the `binaries.soliditylang.org` release artifact: same
version and commit, but not the same bytes. Both are the Solidity compiler under the same licence; the
npm build is pinned because it is the one the `solc` dependency installs, which is what keeps Node and
the browser running one compiler rather than two.
