import { fork } from 'node:child_process';
import { types } from 'node:util';
import { safeEvidenceSnapshot } from './evidence-shadow.mjs';

const worker = new URL('./evidence-shadow-worker.mjs', import.meta.url);
const keys = ['disabled','invalid','overBudget','failed','analyzed','unsupported','noEvidence','candidates','ambiguous','uncertain','conflict','semanticUncertain','contextIncomplete'];
const counts = key => Object.fromEntries(keys.map(k => [k, Number(k === key)]));
const safeResult = value => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => !keys.includes(key))) return null;
    const result = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') ||
          !Number.isSafeInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 1) return null;
      Object.defineProperty(result, key, { value: descriptor.value, writable: true, enumerable: true, configurable: true });
    }
    const { disabled, invalid, overBudget, failed, analyzed, unsupported, noEvidence, candidates, ambiguous, uncertain, conflict, semanticUncertain, contextIncomplete } = result;
    if (disabled + invalid + overBudget + failed + analyzed !== 1 ||
        unsupported + noEvidence + candidates + ambiguous + uncertain !== analyzed) return null;
    if (!analyzed) {
      if (conflict || semanticUncertain || contextIncomplete) return null;
    } else if (unsupported ? conflict || semanticUncertain || contextIncomplete :
      semanticUncertain || contextIncomplete ? !uncertain :
      conflict ? !ambiguous : !candidates && !noEvidence) return null;
    return result;
  } catch { return null; }
};

// Process separation is not a security sandbox or a hard resource limit.
export function createEvidenceShadowProcess(options = {}) {
  if (options === null) throw new TypeError('options must not be null');
  let enabledDescriptor;
  let timeoutDescriptor;
  for (let current = Object(options); current !== null; current = Object.getPrototypeOf(current)) {
    if (types.isProxy(current)) throw new TypeError('proxy options are not supported');
    if (Object.getOwnPropertyDescriptor(current, 'analyze')) throw new TypeError('analyze option is no longer supported');
    enabledDescriptor ??= Object.getOwnPropertyDescriptor(current, 'enabled');
    timeoutDescriptor ??= Object.getOwnPropertyDescriptor(current, 'timeoutMs');
  }
  if (enabledDescriptor && !Object.hasOwn(enabledDescriptor, 'value')) throw new TypeError('enabled must be a data property');
  if (timeoutDescriptor && !Object.hasOwn(timeoutDescriptor, 'value')) throw new TypeError('timeoutMs must be a data property');
  const enabled = enabledDescriptor?.value === undefined ? false : enabledDescriptor.value;
  const timeoutMs = timeoutDescriptor?.value === undefined ? 1000 : timeoutDescriptor.value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new RangeError('invalid timeout');
  let active = null;
  let closed = false;
  let closePromise;
  return {
    observe(query, hits) {
      if (enabled !== true || closed) return Promise.resolve(counts('disabled'));
      if (active) return Promise.resolve(counts('overBudget'));
      const checked = safeEvidenceSnapshot(query, hits);
      if (!Object.hasOwn(checked, 'hits')) return Promise.resolve(checked);
      Object.setPrototypeOf(checked.hits, null);
      let snapshot = Object.assign(Object.create(null), checked);
      try {
        if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 1048576) return Promise.resolve(counts('overBudget'));
      } catch { return Promise.resolve(counts('failed')); }
      return new Promise(resolve => {
        let child;
        try { child = fork(worker, [], { env: {}, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); }
        catch { resolve(counts('failed')); return; }
        let outcome = counts('failed');
        let finished = false;
        let responseReceived = false;
        let timer;
        let resolveExit;
        const exited = new Promise(done => { resolveExit = done; });
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve(outcome);

        };
        const cancel = () => {
          if (finished) return;
          outcome = counts('failed');
          finish();
          try { child.kill(); } catch {}
        };
        active = { child, exited, cancel };
        child.on('error', cancel);
        child.on('close', (code, signal) => {
          if (active?.child === child) active = null;
          resolveExit();
          if (finished) return;
          if (code !== 0 || signal || !responseReceived) outcome = counts('failed');
          finish();
        });
        child.on('message', message => {
          if (finished) return;
          if (responseReceived) { cancel(); return; }
          responseReceived = true;
          const result = safeResult(message);
          if (result) outcome = result;
        });
        timer = setTimeout(cancel, timeoutMs);
        try { child.send(snapshot, error => { if (error) cancel(); }); }
        catch { cancel(); }
        snapshot = null;
      });
    },
    close() {
      closed = true;
      if (closePromise) return closePromise;
      const current = active;
      if (!current) return closePromise = Promise.resolve();
      closePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = new Error('shadow process close timed out');
          error.code = 'ERR_SHADOW_CLOSE_TIMEOUT';
          reject(error);
        }, timeoutMs);
        current.exited.then(() => { clearTimeout(timer); resolve(); });
      });
      current.cancel();
      return closePromise;
    }
  };
}
