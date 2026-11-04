import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function readRecord(file) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (r.version !== 1 || !uuid.test(r.namespace) || !uuid.test(r.generation) || !Number.isFinite(Date.parse(r.createdAt)) || (r.cloneOf !== undefined && !uuid.test(r.cloneOf))) throw Error('corrupt-namespace');
  return r;
}
function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); return 'synced'; }
  catch (e) {
    if (['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes(e.code)) return 'unavailable';
    throw e;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function publish(file, record) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(tmp, file);
    syncDirectory(path.dirname(file));
  } finally { fs.unlinkSync(tmp); }
}
// Interrupted unpublished candidates are evidence, not database contents. Never
// delete/adopt them: another publisher may still own one. A published identity wins.
const candidateName = /^namespace\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
function hasStoreContents(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).some(e => !e.isFile() || !candidateName.test(e.name));
}

// binding must come from deployment configuration outside the copied data tree.
// Recovery is read-only unless the caller explicitly requests and obtains this lease.
export function openNamespace({ directory, registryRoot, sourceRoot, instanceId, writable = false, cloneOf }) {
  directory = path.resolve(directory);
  const file = path.join(directory, 'namespace.json');
  if (writable) {
    if (typeof instanceId !== 'string' || !instanceId || typeof sourceRoot !== 'string' || !sourceRoot || !registryRoot) throw Error('missing-deployment-binding');
    const relative = path.relative(directory, path.resolve(registryRoot));
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('registry-inside-copy-domain');
  }
  if (!fs.existsSync(file)) {
    if (!writable) throw Error('missing-namespace');
    if (fs.existsSync(directory) && hasStoreContents(directory) && !fs.existsSync(file)) throw Error('missing-namespace-nonempty');
    // A prior deployment binding is evidence that this source already had an
    // identity, even when the copied directory now contains only orphan temps.
    if (fs.existsSync(registryRoot)) {
      for (const name of fs.readdirSync(registryRoot)) {
        if (!name.endsWith('.json') || !uuid.test(name.slice(0, -5))) continue;
        const binding = JSON.parse(fs.readFileSync(path.join(registryRoot, name), 'utf8'));
        if (binding.sourceRoot === path.resolve(sourceRoot) && !fs.existsSync(file)) throw Error('missing-namespace-bound-source');
      }
    }
    if (cloneOf !== undefined && !uuid.test(cloneOf)) throw Error('invalid-clone-origin');
    fs.mkdirSync(directory, { recursive: true });
    const record = { version: 1, namespace: randomUUID(), generation: randomUUID(), createdAt: new Date().toISOString(), ...(cloneOf ? { cloneOf } : {}) };
    try { publish(file, record); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const record = readRecord(file);
  const original = fs.readFileSync(file);
  const directorySync = writable ? syncDirectory(directory) : 'not-requested';
  let lock, token, descriptor, registrationFile, bindingBytes, released = false;
  if (writable) {
    if (typeof instanceId !== 'string' || !instanceId || typeof sourceRoot !== 'string' || !sourceRoot || !registryRoot) throw Error('missing-deployment-binding');
    registryRoot = path.resolve(registryRoot);
    const relative = path.relative(directory, registryRoot);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('registry-inside-copy-domain');
    fs.mkdirSync(registryRoot, { recursive: true });
    const binding = { namespace: record.namespace, sourceRoot: path.resolve(sourceRoot), instanceId };
    const registration = path.join(registryRoot, record.namespace + '.json');
    try { publish(registration, binding); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (JSON.stringify(JSON.parse(fs.readFileSync(registration, 'utf8'))) !== JSON.stringify(binding)) throw Error('deployment-binding-mismatch');
    registrationFile = registration;
    bindingBytes = fs.readFileSync(registration);
    lock = path.join(registryRoot, record.namespace + '.lock');
    token = createHash('sha256').update(randomUUID()).digest('hex');
    descriptor = fs.openSync(lock, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, token); fs.fsyncSync(descriptor); } catch (e) { fs.closeSync(descriptor); throw e; }
  }
  return Object.freeze({
    ...record,
    directorySync,
    assertWritable() {
      if (!writable || released) throw Error('namespace-read-only');
      if (!fs.readFileSync(registrationFile).equals(bindingBytes)) throw Error('deployment-binding-changed');
      if (!fs.readFileSync(file).equals(original) || fs.readFileSync(lock, 'utf8') !== token) throw Error('namespace-lease-lost');
      const current = fs.statSync(lock); const owned = fs.fstatSync(descriptor);
      if (current.ino !== owned.ino || current.dev !== owned.dev) throw Error('namespace-lease-lost');
    },
    close() {
      if (released) return;
      released = true;
      if (descriptor !== undefined) {
        try {
          const current = fs.statSync(lock), owned = fs.fstatSync(descriptor);
          if (current.ino === owned.ino && current.dev === owned.dev && fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock);
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        finally { fs.closeSync(descriptor); }
      }
    },
  });
}
