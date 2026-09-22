// The compiler host for a classic worker: load soljson.js, wrap it, compile with it.
//
// This is the only place the browser actually talks to solc, and it has to be a classic worker. Two
// reasons, and neither is a preference:
//
//   1. soljson.js instantiates a ~9.2 MB wasm module *synchronously* - its build sets
//      WASM_ASYNC_COMPILATION=0 so `solc` can be used as a synchronous API - and Chrome refuses to
//      compile a wasm module over 8 MB on the main thread. Emscripten does not surface that as an
//      exception: it logs `warning: failed to compile wasm module` and never finishes initialising, so
//      the page just never becomes ready. On a worker thread the same synchronous compile succeeds.
//   2. The file is a classic script. `importScripts` runs it as one; a module worker cannot call
//      `importScripts` at all, and evaluating 9.2 MB of fetched text with `new Function` would need
//      `unsafe-eval` in any CSP.
//
// The bytes come from `source.readSoljson()`, which verifies them, and are handed to `importScripts` as
// a blob URL - so what gets executed is exactly what was checked, rather than a second fetch of the same
// URL that nobody looks at.
import wrapper from 'solc/wrapper.js';

export async function createInlineHost({ source, progress = () => {} }) {
	if (typeof importScripts !== 'function') {
		throw new Error(
			'Solidity has to be compiled in a classic worker - soljson.js is a classic script, so it ' +
				'cannot be loaded as a module, and its wasm is too large to instantiate on a main ' +
				'thread. Use the package entry point, which spawns one for you, or call it from your ' +
				'own classic worker.'
		);
	}

	const bytes = await source.readSoljson({ onProgress: progress });

	const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
	try {
		importScripts(url);
	} finally {
		URL.revokeObjectURL(url);
	}

	const module = self.Module;
	if (!module || typeof module.cwrap !== 'function') {
		throw new Error(
			'soljson.js loaded but did not initialise a compiler module, so the compiler cannot run'
		);
	}

	const solc = wrapper(module);
	return {
		version: solc.version(),
		compile: async (input) => JSON.parse(solc.compile(JSON.stringify(input))),
		dispose() {}
	};
}
