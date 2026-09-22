// The full bundle: `self.solcWasm`.
//
// For a classic worker that is the whole language host - it compiles and it runs - which is the shape
// LiveCodes gives its languages. Everything is inside the bundle, so a worker needs nothing but
// `importScripts` and a baseUrl.
import { createApi } from './api.js';
import { createInlineHost } from './host.inline.js';

export { EVM_VERSIONS, evmVersionsFor } from './evm-versions.js';

const api = createApi({ packaged: null, createHost: createInlineHost });

export const createCompiler = api.createCompiler;
