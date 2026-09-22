import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
// By name, so the tests exercise the real entry point - including the `node` condition that wires in the
// compiler from the installed `solc` package.
import { createCompiler, EVM_VERSIONS, evmVersionsFor } from '@live-codes/solc-wasm';
import { Hardfork } from '@ethereumjs/common';
import { ASSET_RECEIPTS } from '../src/receipts.js';
import { hardforkFor } from '../src/evm-versions.js';

const HELLO = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Hello {
    function greet() public pure returns (string memory message) {
        return "Hello from Solidity.";
    }
}
`;

const COUNTER = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Counter {
    uint256 public count;

    function increment() public {
        count += 1;
    }

    function current() public view returns (uint256) {
        return count;
    }
}
`;

// The default sender, and a stranger. All digits, so no checksum case to get wrong.
const OWNER = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';

const GUARDED = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Guarded {
    error Unauthorized(address caller);

    // The default sender, so this owner is reachable without a checksummed literal.
    address public constant OWNER = ${OWNER};

    function restricted() public view {
        if (msg.sender != OWNER) revert Unauthorized(msg.sender);
    }
}
`;

let compiler;

before(async () => {
	compiler = await createCompiler();
});

after(() => {
	compiler?.dispose();
});

test('the evmVersions are the ones solc accepts, and each maps to a real hardfork', () => {
	assert.deepEqual([...EVM_VERSIONS], [
		'homestead',
		'tangerineWhistle',
		'spuriousDragon',
		'byzantium',
		'constantinople',
		'petersburg',
		'istanbul',
		'berlin',
		'london',
		'paris',
		'shanghai',
		'cancun',
		'prague',
		'osaka'
	]);
	// The pairing is load-bearing, so it is asserted rather than assumed: an evmVersion solc accepts but
	// @ethereumjs does not would compile bytecode nothing can execute.
	for (const version of EVM_VERSIONS) {
		assert.ok(Hardfork[hardforkFor(version)], `no @ethereumjs hardfork for ${version}`);
	}
	assert.deepEqual(evmVersionsFor(), [...EVM_VERSIONS]);
});

test('an unknown evmVersion is rejected with the list of valid ones', async () => {
	await assert.rejects(
		() => createCompiler({ evmVersion: 'osaka2' }),
		/evmVersion must be one of homestead, .*got "osaka2"/
	);
});

test('Node needs no baseUrl: the installed solc package is the default', async () => {
	assert.match(compiler.solcVersion, /^0\.8\.37\+commit\.f401782d\./);
	assert.equal(compiler.evmVersion, 'cancun');
	assert.deepEqual(compiler.evmVersions, [...EVM_VERSIONS]);
});

test('compile() reports contracts and diagnostics without running anything', async () => {
	const compiled = await compiler.compile(HELLO);

	assert.equal(compiled.fileName, 'contract.sol');
	assert.equal(compiled.hasError, false);
	assert.deepEqual(compiled.errors, []);
	assert.deepEqual(compiled.warnings, []);
	assert.deepEqual(Object.keys(compiled.contracts), ['Hello']);
	assert.ok(compiled.contracts.Hello.bytecode.startsWith('0x'));
	assert.ok(compiled.contracts.Hello.bytecode.length > 2);
	assert.ok(compiled.contracts.Hello.abi.some((entry) => entry.name === 'greet'));
});

test('a run deploys, calls and reports the decoded value', async () => {
	const result = await compiler.run(HELLO, { fn: 'greet()' });

	assert.deepEqual(result.errors, []);
	assert.equal(result.exitCode, 0);
	assert.equal(result.contract, 'Hello');
	assert.equal(result.deployed, 'fresh');
	assert.match(result.address, /^0x[0-9a-f]{40}$/);
	assert.equal(result.fn, 'greet()');
	assert.equal(result.returnValue, 'message = "Hello from Solidity."');
	assert.match(result.returnData, /^0x/);
	assert.equal(typeof result.deployGas, 'bigint');
	assert.equal(typeof result.gasUsed, 'bigint');
	assert.ok(result.compileMs >= 0);
	assert.ok(result.runMs >= 0);
	assert.deepEqual(result.events, []);
	// The report is what a playground shows.
	assert.equal(result.stdout[0], `solc ${compiler.solcVersion}`);
	assert.match(result.stdout[1], /^Hello: \d+ bytes of bytecode$/);
	assert.ok(result.stdout.some((line) => line === 'greet()'));
	// `output` is the report and the diagnostics together, in that order.
	assert.equal(result.output, [...result.stdout, ...result.stderr].filter(Boolean).join('\n'));
});

test('the result shape is stable', async () => {
	const result = await compiler.run(HELLO, { fn: 'greet()' });
	assert.deepEqual(Object.keys(result).sort(), [
		'abi',
		'address',
		'bytecode',
		'compileMs',
		'contract',
		'contracts',
		'deployGas',
		'deployed',
		'errors',
		'events',
		'evmVersion',
		'exitCode',
		'fileName',
		'fn',
		'gasUsed',
		'output',
		'returnData',
		'returnValue',
		'revertReason',
		'runMs',
		'solcVersion',
		'stderr',
		'stdout',
		'warnings'
	]);
});

test('a source that does not compile returns diagnostics and never deploys', async () => {
	const result = await compiler.run(`contract Broken { uint256 public x }`, { fn: 'f()' });

	assert.equal(result.exitCode, null);
	assert.equal(result.runMs, null);
	assert.equal(result.address, null);
	assert.equal(result.deployed, null);
	assert.equal(result.contract, null);
	assert.equal(result.stdout.length, 0);
	assert.ok(result.errors.length > 0, 'expected diagnostics');
	assert.ok(
		result.errors.some((line) => /Expected ';' but got '\}'/.test(line)),
		`expected the parser error, got:\n${result.errors.join('\n')}`
	);
	// The source excerpt comes through, which is what makes a diagnostic usable.
	assert.ok(result.errors.some((line) => line.includes('contract.sol:1:')), result.errors.join('\n'));
});

test('warnings are not errors, because solc warns on code that is fine', async () => {
	// Deliberately no SPDX identifier: solc warns, and refusing to run this would be wrong.
	const result = await compiler.run(
		`pragma solidity ^0.8.0;\ncontract Quiet { function ok() public pure returns (uint256) { return 1; } }\n`,
		{ fn: 'ok()' }
	);

	assert.deepEqual(result.errors, [], 'a warning must not be treated as a failure');
	assert.ok(result.warnings.length > 0, 'expected the SPDX warning');
	assert.ok(result.warnings.every((line) => /SPDX/.test(line)));
	assert.equal(result.exitCode, 0);
	assert.equal(result.returnValue, '#0 = 1');
});

test('a lower evmVersion reaches solc and is warned about by solc, not by us', async () => {
	const result = await compiler.run(HELLO, { fn: 'greet()', evmVersion: 'london' });

	assert.deepEqual(result.errors, []);
	assert.equal(result.evmVersion, 'london');
	assert.ok(result.bytecode, 'still compiled');
});

test('an unsupported opcode pairing would be caught by the hardfork the version maps to', async () => {
	// `PUSH0` is Shanghai's. Compiled for shanghai it runs; the point of the test is that the EVM side
	// follows `evmVersion` rather than being fixed, so the same source at an older version emits
	// different bytecode.
	const push0Source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Zero { function zero() public pure returns (uint256) { return 0; } }
`;
	const modern = await compiler.run(push0Source, { fn: 'zero()', evmVersion: 'cancun' });
	const legacy = await compiler.run(push0Source, { fn: 'zero()', evmVersion: 'london' });

	assert.deepEqual(modern.errors, []);
	assert.deepEqual(legacy.errors, []);
	assert.equal(modern.returnValue, legacy.returnValue);
	assert.notEqual(modern.bytecode, legacy.bytecode, 'a different evmVersion should emit different code');
});

test('state survives between runs, and redeploy is the way to clear it', async () => {
	const first = await compiler.run(COUNTER, { fn: 'increment()' });
	assert.equal(first.deployed, 'fresh');

	const second = await compiler.run(COUNTER, { fn: 'current()' });
	assert.equal(second.deployed, 'reused');
	assert.equal(second.address, first.address);
	assert.equal(second.returnValue, '#0 = 1');

	const redeployed = await compiler.run(COUNTER, { fn: 'current()', redeploy: true });
	assert.equal(redeployed.deployed, 'fresh');
	assert.equal(redeployed.returnValue, '#0 = 0');
});

test('an edited source is a different deployment, not a reuse', async () => {
	const one = await compiler.run(COUNTER, { fn: 'increment()' });
	const edited = COUNTER.replace('count += 1;', 'count += 2;');
	const two = await compiler.run(edited, { fn: 'current()' });

	assert.equal(two.deployed, 'fresh');
	assert.notEqual(two.address, one.address);
});

test('events decode, including indexed arguments', async () => {
	const result = await compiler.run(
		`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Token {
    event Transfer(address indexed from, address indexed to, uint256 value);
    mapping(address => uint256) public balanceOf;
    constructor() { balanceOf[msg.sender] = 1000; }
    function transfer(address to, uint256 value) public returns (bool ok) {
        require(balanceOf[msg.sender] >= value, "insufficient balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }
}
`,
		{
			fn: 'transfer(address,uint256)',
			args: ['0x000000000000000000000000000000000000dEaD', '1000']
		}
	);

	assert.deepEqual(result.errors, []);
	assert.equal(result.returnValue, 'ok = true');
	assert.equal(result.events.length, 1);
	const [event] = result.events;
	assert.equal(event.name, 'Transfer');
	assert.equal(event.args.value, '1000');
	assert.equal(event.args.to, '"0x000000000000000000000000000000000000dEaD"');
	assert.match(event.address, /^0x[0-9a-f]{40}$/);
	// The report includes it too.
	assert.ok(result.stdout.some((line) => /event from 0x[0-9a-f]{40}: Transfer\(/.test(line)));
});

test('a revert returns its reason instead of throwing', async () => {
	const result = await compiler.run(
		`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Vault {
    function withdraw(uint256 amount) public pure {
        require(amount == 0, "insufficient balance");
    }
}
`,
		{ fn: 'withdraw(uint256)', args: ['1'] }
	);

	assert.equal(result.exitCode, 1);
	assert.equal(result.revertReason, 'Error("insufficient balance")');
	assert.ok(result.errors.some((line) => line.includes('insufficient balance')));
	assert.equal(result.returnValue, null);
	assert.match(result.address, /^0x[0-9a-f]{40}$/, 'the contract still deployed');
});

test('a custom error decodes with its arguments', async () => {
	const result = await compiler.run(GUARDED, { fn: 'restricted()', caller: STRANGER });

	assert.equal(result.exitCode, 1);
	assert.equal(result.revertReason, `Unauthorized("${STRANGER}")`);
});

test('the sender is per call, so one contract can be called by several accounts', async () => {
	// Deploy and call as the owner.
	const accepted = await compiler.run(GUARDED, { fn: 'restricted()', caller: OWNER });
	assert.deepEqual(accepted.errors, []);
	assert.equal(accepted.exitCode, 0);

	// The stranger is refused - against the same contract, not a fresh one. Which is the whole point:
	// "deploy as the owner, then call as someone else" is the question every access control check is
	// asking, and it cannot be asked if a different sender means a different deployment.
	const rejected = await compiler.run(GUARDED, { fn: 'restricted()', caller: STRANGER });
	assert.equal(rejected.deployed, 'reused', 'a different sender must not redeploy');
	assert.equal(rejected.address, accepted.address);
	assert.equal(rejected.exitCode, 1);
	assert.equal(rejected.revertReason, `Unauthorized("${STRANGER}")`);

	// And the original sender still works, so nothing was disturbed along the way.
	const again = await compiler.run(GUARDED, { fn: 'restricted()', caller: OWNER });
	assert.equal(again.deployed, 'reused');
	assert.equal(again.exitCode, 0);
});

test('state belongs to the contract, not to the sender', async () => {
	await compiler.run(COUNTER, { fn: 'increment()', caller: OWNER });

	// A different account reading the same contract sees what the first one wrote.
	const readByStranger = await compiler.run(COUNTER, { fn: 'current()', caller: STRANGER });
	assert.equal(readByStranger.deployed, 'reused');
	assert.equal(readByStranger.returnValue, '#0 = 1');
});

test('reset starts over without reloading the compiler', async () => {
	// Its own compiler, so this test does not depend on what the shared one has accumulated.
	const isolated = await createCompiler();
	try {
		const first = await isolated.run(COUNTER, { fn: 'increment()' });
		assert.equal(first.deployed, 'fresh');
		assert.equal((await isolated.run(COUNTER, { fn: 'current()' })).returnValue, '#0 = 1');

		// `redeploy` is a redeploy on a live chain: another instance, at another address, starting empty.
		const redeployed = await isolated.run(COUNTER, { fn: 'current()', redeploy: true });
		assert.equal(redeployed.deployed, 'fresh');
		assert.notEqual(redeployed.address, first.address);
		assert.equal(redeployed.returnValue, '#0 = 0');

		// `reset` is a clean chain. Senders are back at nonce 0, so the deploy lands at the same address
		// the first one did - which is what makes a run reproducible.
		isolated.reset();
		const after = await isolated.run(COUNTER, { fn: 'increment()' });
		assert.equal(after.deployed, 'fresh');
		assert.equal(after.address, first.address, 'a reset world should deploy to the first address again');
		assert.equal(after.returnValue, null);
		// Still loaded: a reset must not cost the 9.2 MB download again.
		assert.equal(after.solcVersion, isolated.solcVersion);
	} finally {
		isolated.dispose();
	}
});

test('value is sent with the call, so payable functions work', async () => {
	const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Vault {
    mapping(address => uint256) public balanceOf;
    function deposit() public payable { balanceOf[msg.sender] += msg.value; }
    function balance() public view returns (uint256) { return balanceOf[msg.sender]; }
}
`;
	const deposited = await compiler.run(source, { fn: 'deposit()', value: 5n });
	assert.deepEqual(deposited.errors, []);

	const balance = await compiler.run(source, { fn: 'balance()' });
	assert.equal(balance.deployed, 'reused');
	assert.equal(balance.returnValue, '#0 = 5');
});

test('constructor arguments are encoded onto the deployment', async () => {
	const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Named {
    string public name;
    constructor(string memory initial) { name = initial; }
    function getName() public view returns (string memory) { return name; }
}
`;
	const result = await compiler.run(source, { fn: 'getName()', ctorArgs: ['LiveCodes'] });

	assert.deepEqual(result.errors, []);
	assert.equal(result.returnValue, '#0 = "LiveCodes"');
});

test('the constructor reverting is reported, not thrown', async () => {
	const result = await compiler.run(
		`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Picky { constructor() { revert("no thanks"); } }
`,
		{}
	);

	assert.equal(result.exitCode, 1);
	assert.equal(result.deployed, null);
	assert.ok(
		result.errors.some((line) => line.includes('the constructor reverted: Error("no thanks")')),
		result.errors.join('\n')
	);
});

test('several contracts need naming, and naming one works', async () => {
	const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract A { function who() public pure returns (string memory) { return "A"; } }
contract B { function who() public pure returns (string memory) { return "B"; } }
`;
	const ambiguous = await compiler.run(source, { fn: 'who()' });
	assert.equal(ambiguous.exitCode, null);
	assert.ok(ambiguous.errors.some((line) => /contract must be one of A, B/.test(line)));

	const named = await compiler.run(source, { contract: 'B', fn: 'who()' });
	assert.equal(named.contract, 'B');
	assert.equal(named.returnValue, '#0 = "B"');

	// A default set on the compiler is used when a run does not name one.
	const defaulted = await createCompiler({ contract: 'B' });
	assert.equal((await defaulted.run(source, { fn: 'who()' })).returnValue, '#0 = "B"');
	defaulted.dispose();
});

test('an interface is not deployable, and the reason says so', async () => {
	const result = await compiler.run(
		`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
interface IThing { function thing() external view returns (uint256); }
`,
		{}
	);

	assert.equal(result.exitCode, null);
	assert.ok(
		result.errors.some((line) => /no deployable contract/.test(line)),
		result.errors.join('\n')
	);
});

test('an fn that is not on the contract is rejected, listing the ones that are', async () => {
	await assert.rejects(
		() => compiler.run(COUNTER, { fn: 'nope()' }),
		(error) => {
			assert.match(error.message, /fn must be a signature on Counter:/);
			assert.match(error.message, /increment\(\)/);
			assert.match(error.message, /current\(\)/);
			assert.match(error.message, /got "nope\(\)"/);
			return true;
		}
	);
});

test('runs are serialised, so two at once do not interleave', async () => {
	const [a, b] = await Promise.all([
		compiler.run(HELLO, { fn: 'greet()' }),
		compiler.run(COUNTER, { fn: 'increment()' })
	]);

	assert.equal(a.returnValue, 'message = "Hello from Solidity."');
	assert.deepEqual(b.errors, []);
});

test('compilers sharing assets share one compiler behind them', async () => {
	const second = await createCompiler();
	assert.equal(second.solcVersion, compiler.solcVersion);
	assert.equal((await second.run(HELLO, { fn: 'greet()' })).exitCode, 0);
	second.dispose();

	// Disposing one must not take the compiler away from the other.
	assert.equal((await compiler.run(HELLO, { fn: 'greet()' })).exitCode, 0);
});

test('a disposed compiler refuses further runs', async () => {
	const disposable = await createCompiler();
	disposable.dispose();
	await assert.rejects(() => disposable.run(HELLO, { fn: 'greet()' }), /disposed/);
	await assert.rejects(() => disposable.compile(HELLO), /disposed/);
});

test('the pinned receipt is the copy the installed solc package ships', async () => {
	const path = fileURLToPath(new URL('../node_modules/solc/soljson.js', import.meta.url));
	const bytes = await readFile(path);
	const receipt = ASSET_RECEIPTS['soljson.js'];

	assert.equal(bytes.length, receipt.bytes, 'soljson.js is the wrong size');
	assert.equal(
		createHash('sha256').update(bytes).digest('hex'),
		receipt.sha256,
		'soljson.js does not hash to its receipt - the compiler the dependency installs has changed'
	);
});

test('every bundled asset is present and non-trivial', async () => {
	for (const name of ['solc-wasm.global.js', 'solc-wasm-toolchain.global.js']) {
		const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
		assert.ok(bytes.length > 10000, `${name} looks unbuilt (${bytes.length} bytes)`);
	}
});

test('a compiler that is not the pinned one is refused', async () => {
	const { verifySoljson } = await import('../src/assets.js');
	const bytes = await readFile(fileURLToPath(new URL('../node_modules/solc/soljson.js', import.meta.url)));

	await verifySoljson(new Uint8Array(bytes));

	// One flipped byte, with the length untouched, so this can only be caught by the hash.
	const tampered = new Uint8Array(bytes);
	tampered[tampered.length - 2] ^= 0xff;
	await assert.rejects(
		() => verifySoljson(tampered),
		/failed SHA-256 verification: expected 221d7a66.*got [0-9a-f]{64}/
	);

	// A truncated file is caught by the length, before anything is hashed.
	await assert.rejects(() => verifySoljson(tampered.slice(0, 1000)), /is 1000 bytes, expected 9237611/);
});

test('the browser entry point needs a baseUrl, and says what to run', async () => {
	const browserEntry = await import('../src/index.js');
	await assert.rejects(
		() => browserEntry.createCompiler(),
		/baseUrl is required here[\s\S]*copy-assets/
	);
	await assert.rejects(
		() => browserEntry.createCompiler({ baseUrl: 'ftp://example.com/solc/' }),
		/baseUrl must be an absolute http\(s\) URL/
	);
});
