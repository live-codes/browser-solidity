// The compiler this package runs, and the receipt for the exact bytes of it.
//
// `soljson.js` ships inside the `solc` dependency, so this package does not re-vendor it. Node uses
// the installed copy, `copy-assets` copies that same file out for the browser, and every byte is
// checked against the receipt below before any of it is executed. One compiler, one hash, both
// environments.
//
// Measured before pinning, and worth knowing before bumping the version: the build inside the `solc`
// npm package is NOT the same bytes as the release artifact at
// `binaries.soliditylang.org/bin/soljson-v0.8.37+commit.f401782d.js`. Same version, same commit,
// different bytes from offset 26 onwards - so the embedded wasm itself differs, not just the glue
// around it (9 222 701 bytes / sha256 d73fead3... there, versus what is pinned below). Pinning the
// npm build is what keeps Node and the browser running the same compiler rather than two builds that
// merely claim the same version.

export const COMPILER = Object.freeze({
	version: '0.8.37',
	commit: 'f401782d'
});

/**
 * The assets this package checks before using, keyed by the name they are served under.
 *
 * `soljson.js` is the only one. It is both the compiler and its own runtime - the ~9.2 MB wasm module
 * is embedded in it as base64 - which is why there is no separate `.wasm` to serve.
 */
export const ASSET_RECEIPTS = Object.freeze({
	'soljson.js': Object.freeze({
		bytes: 9237611,
		sha256: '221d7a667378b5068d913e75fe092507e061363cd1d23b64c49ae82febabad4c'
	})
});
