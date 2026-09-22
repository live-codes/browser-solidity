// Builds the two IIFE bundles: classic scripts, for workers and pages that cannot use ES modules.
//
//   npm run build:iife
//
// The output is committed, because a classic worker can only `importScripts()` a URL and consumers
// should not need a bundler to get one.
//
// There are two, and they stay separate. `solc-wasm.global.js` is the language API - compile and run -
// and is what a worker that *is* the language host loads. `solc-wasm-toolchain.global.js` is compile
// only, for the worker the browser entry point spawns for itself: that worker never runs anything, so
// making it carry the EVM would be a few hundred KB loaded for nothing.
//
// `solc/wrapper.js` is CommonJS and reaches for four Node modules that have no meaning here. Two are
// needed for real (`assert`); two belong to `loadRemoteVersion`, a Node-only path this package never
// calls, so those stubs throw rather than pretend.
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stub = (name) => fileURLToPath(new URL(`./stubs/${name}`, import.meta.url));

const alias = {
	assert: stub('assert.cjs'),
	memorystream: stub('memorystream.cjs'),
	'follow-redirects': stub('follow-redirects.cjs')
};

const RUNTIME_LICENSES =
	'Bundles @ethereumjs/vm, /util and /common (MPL-2.0), ethers (MIT) and the solc wrapper (MIT).';

const BUNDLES = [
	{
		entry: '../src/iife.js',
		outfile: '../dist/solc-wasm.global.js',
		globalName: 'solcWasm',
		banner: `/*! @live-codes/solc-wasm - MIT. IIFE build, sets self.solcWasm.
 *  importScripts('solc-wasm.global.js') then self.solcWasm.createCompiler({ baseUrl }).
 *  ${RUNTIME_LICENSES}
 *  soljson.js (GPL-3.0) is NOT bundled: it is fetched from baseUrl at run time. */`
	},
	{
		entry: '../src/toolchain.js',
		outfile: '../dist/solc-wasm-toolchain.global.js',
		globalName: 'solcWasmToolchain',
		banner: `/*! @live-codes/solc-wasm - MIT. Compile-only IIFE build, sets self.solcWasmToolchain.
 *  importScripts('solc-wasm-toolchain.global.js') then self.solcWasmToolchain.serve({ baseUrl }).
 *  For a worker whose only job is to compile. ${RUNTIME_LICENSES}
 *  soljson.js (GPL-3.0) is NOT bundled: it is fetched from baseUrl at run time. */`
	}
];

for (const { entry, outfile, globalName, banner } of BUNDLES) {
	const out = fileURLToPath(new URL(outfile, import.meta.url));
	await build({
		entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
		outfile: out,
		bundle: true,
		format: 'iife',
		globalName,
		minify: true,
		platform: 'browser',
		target: 'es2022',
		alias,
		// Keeps any third-party @license comments in a sidecar rather than in the payload.
		legalComments: 'external',
		banner: { js: banner }
	});
	console.log(`${outfile.replace('../', '')}  ${(statSync(out).size / 1024).toFixed(1)} KB (minified)`);
}
