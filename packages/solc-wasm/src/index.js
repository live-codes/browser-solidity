// The entry everything gets unless something more specific matches.
//
// It works without a filesystem, so there is no `node:fs` here and `baseUrl` is required: a browser
// cannot read a file that lives inside an npm package, and it cannot reach the official release host
// either - `binaries.soliditylang.org` sends no Access-Control-Allow-Origin, so a worker cannot fetch
// it. Copy the assets somewhere you serve with `solc-wasm-copy-assets`.
//
// The compiling happens in a worker this entry owns; the EVM runs here, on the calling thread, because
// deploying and calling take milliseconds and only the compiler has to be kept off the main thread.
import { createApi } from './api.js';
import { createWorkerHost } from './host.client.js';

export { EVM_VERSIONS, evmVersionsFor } from './evm-versions.js';

const api = createApi({ packaged: null, createHost: createWorkerHost });

export const createCompiler = api.createCompiler;
