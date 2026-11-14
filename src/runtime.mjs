// Fail before opening or creating a database. Feature presence, not version text alone,
// is authoritative for embedded or custom Node builds.
export const NODE_RANGE = '^22.16.0 || >=24.0.0';
export function assertRuntime(version = process.versions.node) {
  const parts = /^([0-9]+)[.]([0-9]+)[.]([0-9]+)$/.exec(String(version));
  const major = Number(parts?.[1]), minor = Number(parts?.[2]);
  if (!parts || !((major === 22 && minor >= 16) || major >= 24)) {
    throw new Error('memjudge requires Node.js ' + NODE_RANGE + '; found ' + version);
  }
}
const checked = new WeakSet();
export function assertSQLiteCapabilities(Database) {
  if (typeof Database === 'function' && checked.has(Database)) return;
  let probe;
  try {
    probe = new Database(':memory:');
    if (typeof probe.isTransaction !== 'boolean' || probe.isTransaction) throw new Error('missing transaction state');
    probe.exec('BEGIN');
    if (probe.isTransaction !== true) throw new Error('invalid transaction state');
    probe.exec('ROLLBACK');
    if (probe.isTransaction !== false || probe.prepare('SELECT 1 AS n').get().n !== 1) throw new Error('invalid synchronous SQL API');
    checked.add(Database);
  } catch (cause) {
    throw new Error('memjudge requires node:sqlite DatabaseSync.isTransaction and synchronous SQL APIs; upgrade the host runtime before opening a database', { cause });
  } finally { probe?.close(); }
}
