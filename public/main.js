// The playground: a UI over @live-codes/solc-wasm.
//
// Everything this file used to do itself - load soljson into a worker, apply the wrapper, deploy,
// encode calldata, decode returns and revert payloads - is the package's job now. What is left is the
// part that is actually this page's: an editor, a contract and function picker, and somewhere to put
// the report.
//
// Two things about the package's shape are worth knowing here:
//
//   * `compile` and `run` are separate. Compiling first is what lets the pickers be filled in from a
//     real compilation before anything is deployed, so a selection can never be stale - which matters
//     because `run` rejects an unknown contract or function rather than guessing.
//   * `run` compiles again. That sounds wasteful and is not: the compiler is warm by then, so the
//     second compile is tens of milliseconds against a 9.2 MB download that has already happened.
import { createCompiler } from '@live-codes/solc-wasm';
import examples from './examples.js';

const $ = (id) => document.getElementById(id);
const els = {
  editor: $('editor'),
  run: $('run'),
  reset: $('reset'),
  status: $('status'),
  meta: $('meta'),
  examples: $('examples'),
  contract: $('contract'),
  fn: $('fn'),
  ctorArgs: $('ctorArgs'),
  fnArgs: $('fnArgs'),
  caller: $('caller'),
  output: $('output'),
  diagnostics: $('diagnostics'),
};

/** Exposed as globals so scripted checks can drive the page without string selectors. */
for (const [name, el] of Object.entries(els)) window[name] = el;

const dataset = document.documentElement.dataset;
const setStage = (stage) => (dataset.stage = stage);
const setStatus = (text, kind = '') => {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
};
const write = (el, lines, kind = '') => {
  el.dataset.kind = kind;
  el.textContent = lines.join('\n');
};

// Pinned to the EVM dialect the sources are compiled for. The package pairs the two sides itself, so
// there is nothing here to keep in step beyond the choice.
const EVM_VERSION = 'cancun';
const GAS_LIMIT = 30_000_000n;

// Written by `npm start`. The package fetches soljson.js from here and verifies it against its pinned
// hash before compiling anything.
const ASSETS = '/solc-assets/';

// Prefilled so the field shows what an empty value would have meant anyway.
const DEFAULT_CALLER = '0x1111111111111111111111111111111111111111';

const parseArgs = (el, label) => {
  const text = el.value.trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} are not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed;
};

// --- the compiler ----------------------------------------------------------

let compilerPromise = null;

/**
 * The package loads the compiler on `createCompiler`, which is the 9.2 MB download, so this is created
 * once and kept. A failure clears the memo rather than caching it, so a retry is possible.
 */
const getCompiler = () => {
  if (!compilerPromise) {
    compilerPromise = createCompiler({
      baseUrl: ASSETS,
      evmVersion: EVM_VERSION,
      gasLimit: GAS_LIMIT,
      onProgress: (value) => setStatus(`Loading compiler… ${Math.round(value * 100)}%`, 'busy'),
    }).catch((error) => {
      compilerPromise = null;
      throw error;
    });
  }
  return compilerPromise;
};

// --- pickers ---------------------------------------------------------------

let contracts = {};
let wantedContract = '';
let wantedFunction = '';
const functionInputs = new Map();

const setOptions = (select, options, preferred) => {
  select.innerHTML = '';
  for (const { value, label } of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  // A preference that no longer exists leaves the first option selected, which is the honest fallback
  // when the source has been edited since it was recorded.
  if (options.some((option) => option.value === preferred)) select.value = preferred;
};

const hintCallArgs = () => {
  const types = functionInputs.get(els.fn.value) ?? [];
  els.fnArgs.placeholder = types.length ? `[${types.join(', ')}]` : '[] — JSON array';
};

const renderFunctions = () => {
  const abi = contracts[els.contract.value]?.abi ?? [];
  const options = [{ value: '', label: '— deploy only —' }];
  functionInputs.clear();
  for (const entry of abi.filter((item) => item.type === 'function')) {
    const inputs = entry.inputs.map((input) => input.type);
    const signature = `${entry.name}(${inputs.join(',')})`;
    const outputs = entry.outputs.map((output) => output.type);
    const kind = ['view', 'pure'].includes(entry.stateMutability) ? 'view' : 'write';
    // The value is the canonical signature (no spaces), which is what the ABI coder expects.
    options.push({
      value: signature,
      label: `${entry.name}(${inputs.join(', ')})${outputs.length ? ` → ${outputs.join(', ')}` : ''}  [${kind}]`,
    });
    functionInputs.set(signature, inputs);
  }
  setOptions(els.fn, options, wantedFunction);
  wantedFunction = els.fn.value;
  hintCallArgs();
};

const renderContracts = (compiled, preferred) => {
  contracts = compiled;
  const deployable = Object.values(compiled).filter((contract) => contract.bytecode);
  setOptions(
    els.contract,
    deployable.map((contract) => ({ value: contract.name, label: contract.name })),
    preferred,
  );
  wantedContract = els.contract.value;
  renderFunctions();
};

// --- running ---------------------------------------------------------------

let running = false;

const clearOutput = () => {
  els.output.textContent = '';
  els.diagnostics.textContent = '';
  els.diagnostics.dataset.kind = '';
  for (const key of ['return', 'address', 'gas', 'logs', 'deployed', 'deployGas']) delete dataset[key];
};

const run = async ({ reset = false } = {}) => {
  if (running) return;
  running = true;
  els.run.disabled = true;
  els.reset.disabled = true;
  dataset.runs = String(Number(dataset.runs ?? 0) + 1);
  clearOutput();

  try {
    setStage('loading-compiler');
    setStatus('Loading compiler…', 'busy');
    const solc = await getCompiler();

    // Redeploy means a clean chain, not just a fresh contract: state, accounts and the deploy address
    // all start over. It keeps the loaded compiler, so it costs nothing.
    if (reset) solc.reset();

    setStage('compiling');
    setStatus('Compiling…', 'busy');
    const compiled = await solc.compile(els.editor.value);

    // Fill the pickers in from this compilation before anything runs, so the selection read below is
    // guaranteed to name a contract and function that exist.
    renderContracts(compiled.contracts, wantedContract);

    const diagnostics = [...compiled.warnings, ...compiled.errors];
    write(els.diagnostics, diagnostics, compiled.hasError ? 'error' : diagnostics.length ? 'warning' : '');

    if (compiled.hasError) {
      dataset.exitCode = '1';
      setStage('error');
      setStatus('Compilation failed', 'error');
      return;
    }

    setStage('running');
    setStatus('Deploying…', 'busy');
    const result = await solc.run(els.editor.value, {
      contract: els.contract.value || undefined,
      // `''` is the deploy-only option, which the package expresses as a null `fn`.
      fn: els.fn.value || null,
      args: parseArgs(els.fnArgs, 'Call arguments'),
      ctorArgs: parseArgs(els.ctorArgs, 'Constructor arguments'),
      // Empty means the package's default sender. A different address here is a different `msg.sender`,
      // which is how an access control check gets exercised from both sides.
      caller: els.caller.value.trim() || undefined,
    });

    write(els.output, result.stdout, result.exitCode ? 'reverted' : 'ok');
    write(
      els.diagnostics,
      result.stderr,
      result.errors.length ? 'error' : result.warnings.length ? 'warning' : '',
    );

    dataset.solc = result.solcVersion;
    dataset.compileMs = String(result.compileMs);
    dataset.contract = result.contract ?? '';
    dataset.fn = result.fn ?? '';
    dataset.deployed = result.deployed ?? '';
    dataset.address = result.address ?? '';
    dataset.deployGas = result.deployGas == null ? '' : String(result.deployGas);
    dataset.gas = result.gasUsed == null ? '' : String(result.gasUsed);
    dataset.logs = String(result.events.length);
    dataset.return = result.returnValue ?? '';
    // `null` means it never got as far as deploying; reported as a failure either way.
    dataset.exitCode = result.exitCode == null ? '1' : String(result.exitCode);

    els.meta.textContent = `solc ${result.solcVersion}`;
    setStage(result.exitCode == null ? 'error' : result.exitCode ? 'reverted' : 'done');
    setStatus(
      result.exitCode == null ? 'Failed' : result.exitCode ? 'Reverted' : 'Ran successfully',
      result.exitCode ? 'error' : 'ok',
    );
  } catch (error) {
    write(els.output, [(error && error.message) || String(error)], 'error');
    dataset.exitCode = '1';
    setStage('error');
    setStatus('Failed', 'error');
  } finally {
    running = false;
    els.run.disabled = false;
    els.reset.disabled = false;
  }
};

// --- wiring ----------------------------------------------------------------

const loadExample = (index) => {
  const example = examples[index];
  els.editor.value = example.source;
  els.ctorArgs.value = '';
  els.fnArgs.value = example.args.length ? JSON.stringify(example.args) : '';
  wantedContract = example.contract;
  wantedFunction = example.fn;
  dataset.example = example.name;
};

for (const [index, example] of examples.entries()) {
  const option = document.createElement('option');
  option.value = String(index);
  option.textContent = example.name;
  els.examples.append(option);
}

els.examples.addEventListener('change', () => loadExample(Number(els.examples.value)));
els.run.addEventListener('click', () => run());
// Redeploy starts from a clean chain, so the next deploy lands where the first one did.
els.reset.addEventListener('click', () => run({ reset: true }));
els.contract.addEventListener('change', () => {
  wantedContract = els.contract.value;
  renderFunctions();
});
els.fn.addEventListener('change', () => {
  wantedFunction = els.fn.value;
  // Arguments almost never carry over between functions, so start the new one empty.
  els.fnArgs.value = '';
  hintCallArgs();
});
els.editor.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    run();
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    const { selectionStart, selectionEnd } = els.editor;
    els.editor.setRangeText('    ', selectionStart, selectionEnd, 'end');
  }
});

loadExample(0);
els.caller.value = DEFAULT_CALLER;
els.meta.textContent = '';
setStage('idle');
setStatus('Ready');
