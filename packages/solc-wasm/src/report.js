// The human-readable half of a run.
//
// A caller running Solidity in a playground wants a short report, not a JSON blob: what was deployed,
// what the call cost, what came back, what was emitted. That is what these functions produce, and it is
// the package's `stdout`. The structured fields alongside it are for callers that want to build their
// own view, which is why both exist rather than one being derived from the other.
//
// Everything is plain lines joined by the caller, so nothing here decides about newlines.

const hex = (bytes) =>
	bytes && bytes.length
		? `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
		: '0x';

export const toHex = hex;

/** `0x1234` is 2 bytes, and solc's bytecode arrives without the prefix. */
export const byteLength = (hexString) => {
	const body = `${hexString ?? ''}`.replace(/^0x/, '');
	return body.length / 2;
};

export function describeDeployment({ contract, bytecode, address, deployed, gasUsed }) {
	if (deployed === 'reused') {
		return [`${contract}: reusing the instance deployed at ${address}`];
	}
	return [
		`${contract}: ${byteLength(bytecode)} bytes of bytecode`,
		`deployed at ${address} (gas ${gasUsed})`
	];
}

export function describeCall({ signature, ok, gasUsed, outputs, events, revertReason, returnData }) {
	const lines = [signature, `  gas used: ${gasUsed}`];
	if (!ok) {
		lines.push(`  reverted: ${revertReason}`);
		return lines;
	}
	if (outputs.length) {
		lines.push('  returned:', ...outputs.map((output) => `    ${output.name} = ${output.value}`));
	} else {
		lines.push('  returned: nothing');
	}
	lines.push(`  return data: ${returnData}`);
	for (const event of events) {
		lines.push(`  event from ${event.address}: ${describeEvent(event)}`);
	}
	return lines;
}

function describeEvent(event) {
	if (!event.name) {
		return `raw topics [${event.raw.topics.join(', ')}] data ${event.raw.data}`;
	}
	const args = Object.entries(event.args)
		.map(([name, value]) => `${name}: ${value}`)
		.join(', ');
	return `${event.name}(${args})`;
}
