// The compiler object, and what `run` means for Solidity.
//
// clang-wasm's `run(code, stdin)` compiles a program and executes it. Solidity has no stdin and no
// top-level statements: the unit of execution is a contract's function, and getting there is three
// steps - compile, deploy, call. So `run(code, options)` does all three and reports each one.
//
// The state that buys, and why it is opt-out rather than opt-in: a second run whose bytecode and
// constructor arguments are unchanged calls the instance the first run deployed. Without that, a
// counter contract could never be seen to count - every run would start from a clean deployment.
//
// Three operations, and they are not the same thing:
//
//   (nothing)          reuse the instance, so state carries across runs. The default.
//   `redeploy: true`   deploy a new instance alongside the old one, which is a redeploy on a live chain.
//   `reset()`          drop the world entirely: a clean chain, with senders back at nonce 0, so the
//                      next deploy lands at the same address as the first one did.
import { resolveAssetSource } from './assets.js';
import {
	DEFAULT_CALLER,
	DEFAULT_GAS_LIMIT,
	abiInterface,
	call,
	createWorld,
	deploy,
	senderFor
} from './evm.js';
import { resolveEvmVersion, evmVersionsFor } from './evm-versions.js';
import { acquireResource, createLock, releaseResource, withResourceLock } from './resource.js';
import { describeCall, describeDeployment } from './report.js';
import { buildInput, collectContracts, collectDiagnostics } from './standard-json.js';

export function createApi({ packaged, createHost }) {
	// Progress sinks live per asset source, not per compiler: the download belongs to the shared host, so
	// a second compiler asking for the same assets must not silently replace the first one's callback.
	const progressSinks = new Map();

	/**
	 * @param {object} [options]
	 * @param {string} [options.baseUrl] - where soljson.js is served from. Required in a browser; in
	 *   Node the copy that ships in the `solc` dependency is the default.
	 * @param {string} [options.evmVersion] - the EVM dialect to compile for, from `evmVersionsFor()`.
	 * @param {string} [options.fileName] - the name the source is compiled under.
	 * @param {string} [options.contract] - the contract to run when the source declares several.
	 * @param {string} [options.caller] - the address that deploys and calls, i.e. `msg.sender`.
	 * @param {bigint|number|string} [options.gasLimit]
	 * @param {(value: number) => void} [options.onProgress] - compiler download progress, 0 to 1.
	 */
	async function createCompiler(options = {}) {
		const source = resolveAssetSource(options, packaged);
		const evmVersion = resolveEvmVersion(options.evmVersion);

		const sinks = progressSinks.get(source.key) ?? new Set();
		progressSinks.set(source.key, sinks);
		if (options.onProgress) sinks.add(options.onProgress);

		const record = await acquireResource(`host\u0000${source.key}`, () =>
			createHost({
				source,
				progress: (value) => {
					for (const sink of sinks) sink(value);
				}
			})
		);
		const host = record.value;

		const defaults = {
			evmVersion,
			fileName: options.fileName ?? 'contract.sol',
			contract: options.contract ?? null,
			caller: options.caller ?? DEFAULT_CALLER,
			gasLimit: options.gasLimit ?? DEFAULT_GAS_LIMIT
		};

		// The instance the last run deployed, the identity of what produced it, and the world it lives
		// in. All three are per compiler, because a world is where the state between runs actually is.
		let instance = null;
		let world = null;
		let worldKey = null;
		let disposed = false;
		const lock = createLock();
		const assertUsable = () => {
			if (disposed) throw new Error('This compiler has been disposed.');
		};

		/**
		 * The EVM world runs share, created on first use and kept.
		 *
		 * It has to be kept: a fresh one per run would mean the contract the previous run deployed is
		 * not in it, and a `view` call against an address with no code returns empty data rather than
		 * the state that was just written - so reuse would look like it worked and quietly answer
		 * nothing. The cost is that addresses advance with the sender's nonce across runs instead of
		 * restarting at the same value, which is the honest behaviour of a chain. `reset()` starts over.
		 *
		 * Only what a VM cannot change at runtime starts a new world. The sender is deliberately not one
		 * of them: it is resolved per call, so calling as a different account works against the contract
		 * that is already deployed rather than replacing it.
		 */
		const worldFor = async ({ evmVersion, gasLimit }) => {
			const key = `${evmVersion}\u0000${gasLimit}`;
			if (worldKey !== key) {
				world = await createWorld({ evmVersion, gasLimit });
				worldKey = key;
				instance = null;
			}
			return world;
		};

		/** Compile, using the shared host under its lock. */
		const compileWith = (code, compileOptions) => {
			const evm = resolveEvmVersion(compileOptions.evmVersion ?? evmVersion);
			const fileName = compileOptions.fileName ?? defaults.fileName;
			return withResourceLock(record, async () => {
				const output = await host.compile(buildInput({ code, fileName, evmVersion: evm }));
				const { lines, errors, warnings, hasError } = collectDiagnostics(output);
				return {
					fileName,
					contracts: collectContracts(output, fileName),
					diagnostics: lines,
					errors,
					warnings,
					hasError,
					solcVersion: host.version
				};
			});
		};

		const execute = async (code, runOptions) => {
			const evm = resolveEvmVersion(runOptions.evmVersion ?? evmVersion);
			const started = Date.now();
			const compiled = await compileWith(code, runOptions);
			const compileMs = Date.now() - started;

			const deployable = Object.values(compiled.contracts).filter((contract) => contract.bytecode);
			if (compiled.hasError) {
				return assemble({ compiled, evmVersion: evm, compileMs });
			}

			const chosen = chooseContract({
				contracts: deployable,
				requested: runOptions.contract ?? defaults.contract
			});
			if (!chosen) {
				compiled.errors.push(
					deployable.length
						? `contract must be one of ${deployable.map((contract) => contract.name).join(', ')}`
						: 'the source declares no deployable contract (an interface or an abstract contract cannot be deployed)'
				);
				return assemble({ compiled, evmVersion: evm, compileMs });
			}

			const signature = runOptions.fn ?? null;
			if (signature) assertFunctionExists(chosen, signature);
			const ctorArgs = runOptions.ctorArgs ?? [];

			const runStarted = Date.now();
			const activeWorld = await worldFor({
				evmVersion: evm,
				gasLimit: runOptions.gasLimit ?? defaults.gasLimit
			});
			// Who sends this run's calls, registered on first use so a session can use as many accounts
			// as it likes without any of them disturbing the world.
			const sender = await senderFor(activeWorld, runOptions.caller ?? defaults.caller);
			const iface = abiInterface(chosen.abi);

			const key = `${chosen.name}\u0000${chosen.bytecode}\u0000${stableKey(ctorArgs)}`;
			const reuse = !(runOptions.redeploy ?? false) && instance?.key === key;

			let address;
			let deployment;
			let failure = null;
			if (reuse) {
				address = instance.address;
				deployment = { ok: true, address, gasUsed: null };
			} else {
				deployment = await deploy(activeWorld, {
					caller: sender,
					iface,
					bytecode: chosen.bytecode,
					ctorArgs
				});
				if (deployment.ok) {
					address = deployment.address;
					instance = { key, address };
				} else {
					failure = `the constructor reverted: ${deployment.revertReason}`;
				}
			}

			const run = {
				contract: chosen.name,
				abi: chosen.abi,
				bytecode: chosen.bytecode,
				deployed: reuse ? 'reused' : 'fresh',
				address: deployment.ok ? address : null,
				deployGas: deployment.gasUsed,
				fn: signature,
				runMs: Date.now() - runStarted
			};

			if (failure) {
				return assemble({
					compiled,
					evmVersion: evm,
					compileMs,
					// Nothing was deployed, so `deployed` stays null rather than claiming a fresh one.
					run: { ...run, deployed: null, exitCode: 1 },
					extraErrors: [failure]
				});
			}

			const stdout = [
				`solc ${host.version}`,
				...describeDeployment({
					contract: chosen.name,
					bytecode: chosen.bytecode,
					address,
					deployed: run.deployed,
					gasUsed: deployment.gasUsed
				})
			];

			if (!signature) {
				stdout.push('', 'Deployed only — pass a `fn` to call something.');
				return assemble({ compiled, evmVersion: evm, compileMs, run: { ...run, stdout } });
			}

			const result = await call(activeWorld, {
				caller: sender,
				iface,
				address,
				signature,
				args: runOptions.args ?? [],
				value: runOptions.value ?? 0n
			});
			stdout.push('', ...describeCall({ signature, ...result }));

			return assemble({
				compiled,
				evmVersion: evm,
				compileMs,
				run: {
					...run,
					stdout,
					exitCode: result.ok ? 0 : 1,
					gasUsed: result.gasUsed,
					returnData: result.returnData,
					returnValue: result.outputs.length
						? result.outputs.map((output) => `${output.name} = ${output.value}`).join('; ')
						: null,
					revertReason: result.revertReason,
					events: result.events
				}
			});
		};

		return {
			/** solc's own version string, e.g. `0.8.37+commit.f401782d.Emscripten.clang`. */
			solcVersion: host.version,

			/** The EVM dialect this compiler compiles for. */
			evmVersion,

			/** Every `evmVersion` this package accepts, for building a picker. */
			evmVersions: evmVersionsFor(),

			fileName: defaults.fileName,

			/**
			 * Compile without running.
			 *
			 * This is what a caller needs to fill in a contract picker and an argument form before anything
			 * is deployed, so it is separate from `run` rather than a side effect of it.
			 */
			async compile(code, compileOptions = {}) {
				assertUsable();
				assertSource(code, 'compile');
				return compileWith(code, compileOptions);
			},

			/**
			 * Compile, deploy and call.
			 *
			 * Per-run options override every compile option, and add `fn`, `args`, `ctorArgs`, `value` and
			 * `redeploy`. The returned object is documented in the README.
			 */
			async run(code, runOptions = {}) {
				assertUsable();
				assertSource(code, 'run');
				return lock(() => execute(code, runOptions));
			},

			/**
			 * Start over: forget the world and the deployment, keeping the loaded compiler.
			 *
			 * This is the difference between a demonstration and a session. A call script that increments
			 * a counter should read `1` every time it runs, and it only will if each run begins from a
			 * clean world - which also puts the senders back at nonce 0, so the deploy address is the
			 * same one every time.
			 *
			 * Keeping the compiler matters as much as the reset. `dispose()` would drop the shared host
			 * too, and the next run would pay the 9.2 MB download again; this costs nothing.
			 *
			 * Safe to call between runs, which is the only time it means anything: a run already in
			 * flight holds its own reference to the world it started with.
			 */
			reset() {
				assertUsable();
				world = null;
				worldKey = null;
				instance = null;
			},

			/** Drop this compiler's hold on the shared compiler. Further runs throw. */
			dispose() {
				if (disposed) return;
				disposed = true;
				if (options.onProgress) sinks.delete(options.onProgress);
				releaseResource(record);
			}
		};
	}

	return { createCompiler };
}

/**
 * One place that builds the result object, so every path - compiled, not compiled, deployed, reverted -
 * returns the same keys. A caller can therefore read `result.errors` without first asking which kind of
 * failure it is looking at.
 */
function assemble({ compiled, evmVersion, compileMs, run = {}, extraErrors = [] }) {
	const stdout = run.stdout ?? [];
	const stderr = [...compiled.diagnostics];
	const errors = [...compiled.errors, ...extraErrors];
	if (run.revertReason) {
		const line = `reverted: ${run.revertReason}`;
		if (!errors.includes(line)) errors.push(line);
		if (!stderr.includes(line)) stderr.push(line);
	}

	return {
		// The compiler.
		solcVersion: compiled.solcVersion,
		evmVersion,
		fileName: compiled.fileName,
		compileMs,
		runMs: run.runMs ?? null,

		// What solc produced, and what it said.
		contracts: compiled.contracts,
		errors,
		warnings: compiled.warnings,
		stderr,
		stdout,
		output: [...stdout, ...stderr].filter(Boolean).join('\n'),

		// What ran, if anything did.
		exitCode: run.contract == null ? null : (run.exitCode ?? 0),
		contract: run.contract ?? null,
		abi: run.abi ?? null,
		bytecode: run.bytecode ?? null,
		deployed: run.deployed ?? null,
		address: run.address ?? null,
		deployGas: run.deployGas ?? null,
		fn: run.fn ?? null,
		gasUsed: run.gasUsed ?? null,
		returnData: run.returnData ?? null,
		returnValue: run.returnValue ?? null,
		revertReason: run.revertReason ?? null,
		events: run.events ?? []
	};
}

const assertSource = (code, method) => {
	if (typeof code !== 'string') {
		throw new Error(`${method}() needs the source as its first argument.`);
	}
};

function chooseContract({ contracts, requested }) {
	if (requested) {
		return contracts.find((contract) => contract.name === requested) ?? null;
	}
	// Unambiguous only when there is one; picking the first of several would be a guess.
	return contracts.length === 1 ? contracts[0] : null;
}

function assertFunctionExists(contract, signature) {
	const iface = abiInterface(contract.abi);
	// ethers returns null for an unknown function rather than throwing, so the presence of the result is
	// the check; leaving it to `encodeFunctionData` fails later with "Cannot read properties of null".
	if (iface.getFunction(signature)) return;

	const functions = contract.abi
		.filter((entry) => entry.type === 'function')
		.map((entry) => `${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`);
	throw new Error(
		`fn must be a signature on ${contract.name}: ${functions.join(', ') || '(none)'} - got ${JSON.stringify(signature)}`
	);
}

/** A stable key for the reuse check. `JSON.stringify` throws on a BigInt argument. */
const stableKey = (values) =>
	values
		.map((value) => (typeof value === 'bigint' ? `${value}n` : (JSON.stringify(value) ?? 'void')))
		.join('\u0000');
