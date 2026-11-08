import { createResourceScope } from './resource-lifecycle.mjs';

export function initializeWithDisposal(ctx, dispose, initialize, report = (error) => console.error('[memjudge] initialization cleanup failed:', error)) {
  try {
    ctx.effect(() => dispose);
    return initialize();
  } catch (error) {
    void dispose().catch(report);
    throw error;
  }
}

export function createDisposal({ close, clear = () => {} }) {
  const disposers = [];
  const scope = createResourceScope();
  let started = false;
  let closed = false;
  let cleared = false;

  const track = (disposer) => {
    if (started) throw new Error('disposal already started');
    if (typeof disposer === 'function') disposers.push(disposer);
    return disposer;
  };

  scope.defer(async () => {
    const errors = [], failed = [];
    while (disposers.length) {
      const disposer = disposers.pop();
      try { await disposer(); } catch (error) { errors.push(error); failed.unshift(disposer); }
    }
    disposers.push(...failed);
    // Dependencies retain ownership until every child has closed successfully.
    if (errors.length) throw new AggregateError(errors, 'memjudge disposal failed');
    if (!cleared) { await clear(); cleared = true; }
    if (!closed) { await close(); closed = true; }
  });
  const dispose = () => { started = true; return scope.close(); };
  return { track, dispose };
}
