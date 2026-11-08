import { AsyncLocalStorage } from 'node:async_hooks';

const disposerContext = new AsyncLocalStorage();

function reaches(start, target) {
  const pending = [start];
  const visited = new Set();
  while (pending.length) {
    const scope = pending.pop();
    if (scope === target) return true;
    if (visited.has(scope)) continue;
    visited.add(scope);
    for (const next of scope.dependencies) pending.push(next);
  }
  return false;
}

function reentrantError() {
  const error = new Error('Cannot close a resource scope from its active disposer or cyclic dependency');
  error.code = 'ERR_RESOURCE_SCOPE_REENTRANT_CLOSE';
  return error;
}

// A scope owns registered cleanup callbacks, not the resources themselves.
export function createResourceScope() {
  const disposers = [];
  const identity = { dependencies: new Set() };
  let closing, started = false;
  return {
    defer(dispose) {
      if (started) throw new Error('Resource scope is closing or closed');
      if (typeof dispose !== 'function') throw new TypeError('dispose must be a function');
      disposers.push(dispose);
    },
    close() {
      let caller;
      for (let frame = disposerContext.getStore(); frame; frame = frame.parent) {
        if (frame.active && frame.scope === identity) {
          throw reentrantError();
        }
        if (frame.active && !caller) caller = frame;
      }
      // Calls from an active disposer conservatively count as dependencies,
      // including calls whose returned promise is never awaited.
      if (caller && !identity.closed) {
        if (reaches(identity, caller.scope)) throw reentrantError();
        caller.scope.dependencies.add(identity);
      }
      if (closing) return closing;
      started = true;
      closing = Promise.resolve().then(async () => {
        const errors = [], failed = [];
        while (disposers.length) {
          const dispose = disposers.pop();
          const frame = { scope: identity, parent: disposerContext.getStore(), active: true };
          try {
            await disposerContext.run(frame, dispose);
          } catch (error) {
            errors.push(error);
            failed.unshift(dispose);
          } finally {
            frame.active = false;
            identity.dependencies.clear();
          }
        }
        disposers.push(...failed);
        if (errors.length) throw new AggregateError(errors, 'Resource cleanup failed');
        identity.closed = true;
      });
      const attempt = closing;
      attempt.catch(() => { if (closing === attempt) closing = undefined; });
      return attempt;
    },
  };
}

// open owns partial-open cleanup if it rejects before returning a store.
export async function withStore(open, use) {
  const store = await open();
  let result;
  let useError;
  let failed = false;
  try { result = await use(store); } catch (error) { failed = true; useError = error; }
  try { await store.close(); } catch (closeError) {
    if (failed) throw new AggregateError([useError, closeError], 'Store use and close failed');
    throw closeError;
  }
  if (failed) throw useError;
  return result;
}
