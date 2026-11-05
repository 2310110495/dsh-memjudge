// A standalone protocol; only explicitly acquired leases are tracked.
export function createSyntheticDrainLifecycle({ unregister = [], close }) {
  if (!Array.isArray(unregister)) throw new TypeError('unregister must be an array of functions');
  const entries = [], length = unregister.length;
  for (let i = 0; i < length; i++) entries.push(Object.hasOwn(unregister, i) ? unregister[i] : undefined);
  if (entries.some(fn => typeof fn !== 'function')) throw new TypeError('unregister must be an array of functions');
  if (typeof close !== 'function') throw new TypeError('close must be a function');
  let state = 'open', leases = 0, notifyDrained, closing;
  function acquire() {
    if (state !== 'open') throw new Error('Lifecycle is closing or closed');
    leases++;
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      leases--;
      if (leases === 0 && notifyDrained) notifyDrained();
      return true;
    };
  }
  function run(operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const release = acquire();
    try { return Promise.resolve(operation()).finally(release); }
    catch (error) { release(); throw error; }
  }
  function shutdown() {
    if (closing) return closing;
    state = 'closing';
    closing = Promise.resolve().then(async () => {
      const errors = [];
      for (const entry of entries) {
        try { await entry(); } catch (error) { errors.push(error); }
      }
      if (leases !== 0) await new Promise(resolve => { notifyDrained = resolve; });
      try { await close(); } catch (error) { errors.push(error); }
      state = 'closed';
      if (errors.length) throw new AggregateError(errors, 'Synthetic lifecycle shutdown failed');
    });
    return closing;
  }
  return { acquire, run, shutdown, get state() { return state; }, get activeLeases() { return leases; } };
}
