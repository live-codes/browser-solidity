// A classic worker that is the whole language host - the shape LiveCodes gives its languages.
//
// `importScripts` of the bundle is the entire setup: the compiler is fetched, verified and instantiated
// on this thread, and everything else is inside the bundle. A module worker could not do this at all,
// and the main thread could not instantiate the compiler's wasm.
//
// The URL has to be absolute, not `/example/assets/...`. `importScripts` does not resolve a relative
// path against the worker's location - it rejects it outright - which is why the base URL is built from
// `self.location` rather than passed as a path.
const BASE = new URL('/example/assets/', self.location.href).href;

importScripts(`${BASE}solc-wasm.global.js`);

const status = (value) => self.postMessage({ type: 'status', value });

status(`bundle loaded (solcWasm: ${typeof self.solcWasm})`);

let compiler = null;

const getCompiler = () => {
	if (!compiler) {
		status('loading the compiler…');
		compiler = self.solcWasm
			.createCompiler({
				baseUrl: BASE,
				onProgress: (value) => status(`downloading ${Math.round(value * 100)}%`)
			})
			.then((created) => {
				status(`compiler ready: ${created.solcVersion}`);
				return created;
			})
			.catch((error) => {
				status(`compiler failed: ${(error && error.message) || error}`);
				compiler = null;
				throw error;
			});
	}
	return compiler;
};

self.onmessage = async (event) => {
	const { id, source, options } = event.data ?? {};
	try {
		const result = await (await getCompiler()).run(source, options);
		self.postMessage({ id, ok: true, result });
	} catch (error) {
		self.postMessage({ id, ok: false, error: `${(error && error.message) || error}` });
	}
};
