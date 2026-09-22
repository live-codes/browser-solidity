// One instance of something expensive, shared by every compiler created against the same assets.
//
// The compiler is ~9.2 MB of wasm and the EVM has to import a fair amount of JavaScript, and a page
// that creates two compilers wants one of each - not two. Callers hold a reference; `dispose()` drops
// it, and the last one out tears the shared instance down.
const resources = new Map();

/**
 * Get the shared resource for `key`, creating it on first use.
 *
 * @param {string} key - identity of the resource; callers that want the same thing must build the
 *   same key.
 * @param {() => Promise<any>} create - builds the value. Called at most once per live key.
 * @returns {Promise<object>} a record to pass to `releaseResource` and `withResourceLock`.
 */
export async function acquireResource(key, create) {
	let pending = resources.get(key);
	if (!pending) {
		pending = Promise.resolve()
			.then(create)
			.then((value) => ({ key, value, references: 0, lock: createLock() }))
			.catch((error) => {
				// A failed load must not poison the cache - the next caller should be able to retry.
				resources.delete(key);
				throw error;
			});
		resources.set(key, pending);
	}

	const record = await pending;
	record.references += 1;
	return record;
}

export function releaseResource(record) {
	record.references -= 1;
	if (record.references > 0) return;
	resources.delete(record.key);
	record.value?.dispose?.();
}

/**
 * Serialise work against a shared resource.
 *
 * Both shared things here hold mutable state that two concurrent runs would trample: solc's wasm
 * module keeps one heap and one set of globals, and the EVM holds one world state. Runs therefore
 * queue rather than interleave.
 */
export async function withResourceLock(record, work) {
	return record.lock(work);
}

/**
 * A lock of one's own, for state that is not shared with anyone: a compiler's record of what it last
 * deployed, for instance. Same shape as the shared lock, so callers do not need two mental models.
 */
export function createLock() {
	let queue = Promise.resolve();
	return async (work) => {
		const previous = queue;
		let release;
		queue = new Promise((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await work();
		} finally {
			release();
		}
	};
}
