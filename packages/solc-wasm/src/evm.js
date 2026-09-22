// Deploying and calling, on an in-page EVM.
//
// `@ethereumjs/vm` is the only reason this is a package and not a compiler wrapper: solc produces
// bytecode, and bytecode that is never executed is not a "run". `ethers` is here purely as an ABI
// codec - it has no EVM - but it earns its place, because `Interface` covers calldata in, return
// values, indexed event topics and revert payloads without any hand-rolled decoding.
//
// Everything this module returns is plain data. No `Address`, no ethers `Result`, no Uint8Array:
// callers should not have to know which library a value came from, and the API stays the same if the
// one underneath is ever replaced.
import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
// v10 constructs addresses from bytes: there is no `Address.fromString`, and `Account`'s constructor
// is deprecated in favour of `createAccount`.
import { createAccount, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { createVM } from '@ethereumjs/vm';
import { Interface } from 'ethers';
import { hardforkFor } from './evm-versions.js';

export const DEFAULT_CALLER = '0x1111111111111111111111111111111111111111';
export const DEFAULT_GAS_LIMIT = 30_000_000n;

/**
 * Every account starts with a balance, so `value` transfers work and no test has to think about funds.
 * `skipBalance` means a sender is topped up if it would otherwise be short, which keeps a playground
 * forgiving: out-of-gas stays the only gas-related failure a user can hit.
 */
const ACCOUNT_BALANCE = 10n ** 18n;

/**
 * A fresh EVM world for one run: one VM at the hardfork that matches the `evmVersion` the source was
 * compiled for.
 *
 * A world holds *accounts*, not a caller. Who sends a given call is a property of the call, because a
 * contract's whole notion of identity is `msg.sender` and the interesting question is almost always
 * "what happens when someone else calls this" - deploy as the owner, then call as a stranger and watch
 * the guard revert. If the sender were a property of the world instead, changing it would mean starting
 * over, and the contract would be gone.
 */
export async function createWorld({ evmVersion, gasLimit = DEFAULT_GAS_LIMIT }) {
	const vm = await createVM({
		common: new Common({ chain: Mainnet, hardfork: Hardfork[hardforkFor(evmVersion)] })
	});
	return { vm, gasLimit: BigInt(gasLimit), accounts: new Map() };
}

/**
 * The address that will send the next call, funded and registered on first use.
 *
 * Accounts are created lazily so a session can accumulate as many senders as it likes without any of
 * them existing until they are used - which is also what keeps a fresh world's first deploy at nonce 0,
 * and therefore at a predictable address.
 */
export async function senderFor(world, address = DEFAULT_CALLER) {
	const key = `${address}`.toLowerCase();
	const existing = world.accounts.get(key);
	if (existing) return existing;

	const sender = createAddressFromString(key);
	await world.vm.stateManager.putAccount(
		sender,
		createAccount({ nonce: 0n, balance: ACCOUNT_BALANCE })
	);
	world.accounts.set(key, sender);
	return sender;
}

/** An ABI coder for one contract. `ethers` accepts the ABI array from solc as-is. */
export const abiInterface = (abi) => new Interface(abi);

/**
 * Deploy creation bytecode, with constructor arguments encoded onto the end of it.
 *
 * A revert here is not thrown: a constructor that refuses to run is a result the caller wants to
 * report, not an exception that should escape as a stack trace.
 */
export async function deploy(world, { caller, iface, bytecode, ctorArgs = [] }) {
	const data = `${bytecode}${iface.encodeDeploy(ctorArgs).slice(2)}`;
	const result = await world.vm.evm.runCall({
		caller,
		data: hexToBytes(data),
		gasLimit: world.gasLimit,
		skipBalance: true
	});

	const { execResult } = result;
	const gasUsed = execResult.executionGasUsed;
	if (execResult.exceptionError) {
		return {
			ok: false,
			address: null,
			gasUsed,
			revertReason: describeFailure(iface, execResult),
			returnData: toHex(execResult.returnValue)
		};
	}
	return {
		ok: true,
		address: result.createdAddress ? result.createdAddress.toString() : null,
		gasUsed,
		revertReason: null,
		returnData: toHex(execResult.returnValue)
	};
}

/** Call a function on a deployed contract, as `caller`. */
export async function call(world, { caller, iface, address, signature, args = [], value = 0n }) {
	const fn = iface.getFunction(signature);
	const result = await world.vm.evm.runCall({
		caller,
		to: createAddressFromString(address),
		data: hexToBytes(iface.encodeFunctionData(fn, args)),
		value: BigInt(value),
		gasLimit: world.gasLimit,
		skipBalance: true
	});

	const { execResult } = result;
	const returnData = toHex(execResult.returnValue);
	const events = (execResult.logs ?? []).map((entry) => describeEvent(iface, entry));

	if (execResult.exceptionError) {
		return {
			ok: false,
			gasUsed: execResult.executionGasUsed,
			returnData,
			outputs: [],
			events: [],
			revertReason: describeFailure(iface, execResult),
			error: execResult.exceptionError.error
		};
	}

	return {
		ok: true,
		gasUsed: execResult.executionGasUsed,
		returnData,
		outputs: describeOutputs(iface, fn, execResult.returnValue),
		events,
		revertReason: null,
		error: null
	};
}

/**
 * Why a frame failed, in the terms a user wrote it in.
 *
 * A revert carries its reason as return data, so `Error("insufficient balance")` and a declared custom
 * error both decode into readable text. Anything else - out of gas, an invalid opcode - has no payload
 * and falls back to the EVM's own wording.
 */
function describeFailure(iface, execResult) {
	const returnData = toHex(execResult.returnValue);
	if (returnData !== '0x') {
		try {
			const decoded = iface.parseError(returnData);
			if (decoded) return `${decoded.name}(${decoded.args.map(formatArg).join(', ')})`;
		} catch {
			// Not a declared or standard error; fall through to the EVM's own wording.
		}
	}
	const { error, errorMessage } = execResult.exceptionError;
	return errorMessage ? `${error}: ${errorMessage}` : error;
}

function describeOutputs(iface, fn, returnValue) {
	if (!fn.outputs?.length) return [];
	let decoded;
	try {
		decoded = iface.decodeFunctionResult(fn, returnValue);
	} catch (error) {
		// A short or malformed return value can only happen from hand-written assembly; reporting it is
		// better than throwing away an otherwise successful call.
		return [{ name: '', type: '', value: `<undecodable: ${error.message}>` }];
	}
	return fn.outputs.map((output, index) => ({
		name: output.name || `#${index}`,
		type: output.type,
		value: formatArg(decoded[index])
	}));
}

function describeEvent(iface, [emitter, topics, data]) {
	const address = toHex(emitter);
	try {
		const parsed = iface.parseLog({ topics: topics.map(toHex), data: toHex(data) });
		const args = {};
		parsed.fragment.inputs.forEach((input, index) => {
			args[input.name || `#${index}`] = formatArg(parsed.args[index]);
		});
		return { name: parsed.name, address, args };
	} catch {
		// An event the ABI does not declare - emitted by a library, or by assembly.
		return {
			name: null,
			address,
			args: null,
			raw: { topics: topics.map(toHex), data: toHex(data) }
		};
	}
}

/** Bigints print as `123` rather than `123n`; strings are quoted so `42` and `"42"` stay distinct. */
const formatArg = (value) => {
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'string') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(formatArg).join(', ')}]`;
	return String(value);
};

const toHex = (bytes) =>
	bytes && bytes.length
		? `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
		: '0x';
