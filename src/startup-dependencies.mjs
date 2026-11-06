// Resolve dependencies without invoking their providers until the caller needs them.
export function startupDependencies(defaults, overrides = {}) {
  const result = {};
  for (const name of ['storeFactory', 'maxChars', 'storageLimitBytes', 'installRpc', 'autoCapture',
    'defaultDbPath', 'configReport', 'embedDims', 'expand', 'select']) {
    const value = Object.hasOwn(overrides, name) ? overrides[name] : defaults[name];
    if (typeof value !== 'function') throw new TypeError(`invalid startup dependency: ${name}`);
    result[name] = value;
  }
  return result;
}
