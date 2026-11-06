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
  const errors = [];
  let started = false;
  let closed = false;
  let cleared = false;
  let pending;

  const track = (disposer) => {
    if (started) throw new Error('disposal already started');
    if (typeof disposer === 'function') disposers.push(disposer);
    return disposer;
  };

  const dispose = () => {
    if (pending) return pending;
    started = true;
    pending = Promise.resolve().then(async () => {
      while (disposers.length) {
        try { await disposers.pop()(); } catch (error) { errors.push(error); }
      }
      if (!cleared) {
        cleared = true;
        try { clear(); } catch (error) { errors.push(error); }
      }
      if (!closed) {
        try { await close(); closed = true; } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError([...errors], 'memjudge disposal failed');
    });
    const attempt = pending;
    attempt.then(() => {}, () => { if (!closed && pending === attempt) pending = undefined; });
    return attempt;
  };
  return { track, dispose };
}
