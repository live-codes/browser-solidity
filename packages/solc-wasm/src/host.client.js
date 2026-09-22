// The compiler host for a page: spawn a classic worker, hand it the standard JSON, take the reply.
//
// The browser entry point lives here rather than in the worker, because a page cannot compile Solidity
// at all - see host.inline.js for why - so the only useful thing it can do is own a worker that can.
//
// The worker it spawns loads `solc-wasm-toolchain.global.js`, the compile-only bundle, which is
// deliberately not the one that carries the EVM: this side already has an EVM, and the worker's job is
// to compile. That keeps 9.2 MB of wasm and a few hundred KB of JavaScript from being loaded twice.
const TOOLCHAIN_SCRIPT = 'solc-wasm-toolchain.global.js';

export async function createWorkerHost({ source, progress = () => {} }) {
	if (typeof Worker !== 'function') {
		throw new Error(
			'Compiling Solidity needs a classic worker, and there is no `Worker` here. In a browser, ' +
				'use this package from a page or from a worker that can spawn one.'
		);
	}

	const toolchainUrl = new URL(TOOLCHAIN_SCRIPT, source.baseUrl).href;
	// Two lines of bootstrap, so the protocol itself stays in the bundle where it can be tested, rather
	// than in a template string built here.
	const bootstrap = [
		`importScripts(${JSON.stringify(toolchainUrl)});`,
		`self.solcWasmToolchain.serve({ baseUrl: ${JSON.stringify(source.baseUrl)} });`
	].join('\n');

	const url = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
	const worker = new Worker(url);

	let nextId = 0;
	let pending = new Map();
	let settleReady;
	let settleFailed;
	const ready = new Promise((resolve, reject) => {
		settleReady = resolve;
		settleFailed = reject;
	});
	// The failure is reported to whoever awaits `createCompiler`; do not also report it unhandled.
	ready.catch(() => undefined);

	const settle = (action) => {
		worker.terminate();
		URL.revokeObjectURL(url);
		for (const [, request] of pending) request.reject(new Error('The compiler worker stopped.'));
		pending = new Map();
		action();
	};

	worker.onmessage = (event) => {
		const message = event.data ?? {};
		if (message.type === 'ready') {
			settleReady(message.version);
			return;
		}
		if (message.type === 'progress') {
			progress(message.value);
			return;
		}
		if (message.type === 'error') {
			settle(() => settleFailed(new Error(message.message)));
			return;
		}
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.ok) request.resolve(message.output);
		else request.reject(new Error(message.error));
	};

	worker.onerror = (event) => {
		settle(() => settleFailed(new Error(`The compiler worker failed: ${event.message}`)));
	};

	const version = await ready;

	return {
		version,
		compile: (input) =>
			new Promise((resolve, reject) => {
				const id = (nextId += 1);
				pending.set(id, { resolve, reject });
				worker.postMessage({ id, input });
			}),
		dispose() {
			settle(() => {});
		}
	};
}
