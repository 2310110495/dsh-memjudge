import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const absolute = value => typeof value === 'string' && path.isAbsolute(value);
const text = value => typeof value === 'string' && value.length > 0;

// Only apply's host-owned startup argument enters this closure. Request/event
// fields never add grants. Same-process plugins and the OS account are trusted.
export function createRawIngestPolicy(input) {
  if (!input || input.enabled !== true) return null;
  if (input.mode !== 'archive-only' || !text(input.principalId) || !text(input.instanceId)
      || !['directory','registryRoot','sourceRoot'].every(k => absolute(input[k]))) throw Error('raw-invalid-deployment-policy');
  const cfg = structuredClone(input);
  if (!Array.isArray(cfg.principals) || !cfg.principals.includes(cfg.principalId)
      || !Array.isArray(cfg.allowedProjectIds) || !Array.isArray(cfg.projects)) throw Error('raw-unknown-principal');
  if (!cfg.backend || !absolute(cfg.backend.moduleFile) || !/^[a-f0-9]{64}$/.test(cfg.backend.sha256)
      || cfg.backend.name !== 'session-persistence-jsonl' || !['none','zstd'].includes(cfg.backend.compression)) throw Error('raw-invalid-backend-binding');
  const roots = new Map(), ids = new Set();
  for (const project of cfg.projects) {
    if (!text(project.id) || !absolute(project.cwd) || roots.has(path.resolve(project.cwd)) || ids.has(project.id)) throw Error('raw-invalid-project-registry');
    roots.set(path.resolve(project.cwd), project.id); ids.add(project.id);
  }
  if (cfg.allowedProjectIds.some(id => !ids.has(id))) throw Error('raw-unknown-project-grant');
  let valid = true;
  const assertActive = () => { if (!valid || (cfg.expiresAt !== undefined && (!Number.isFinite(cfg.expiresAt) || Date.now() >= cfg.expiresAt))) throw Error('raw-policy-expired'); };
  const assertBackend = backend => {
    assertActive();
    if (!backend || typeof backend.identity !== 'symbol' || backend.name !== cfg.backend.name
        || !absolute(backend.root) || path.resolve(backend.root) !== path.resolve(cfg.sourceRoot)
        || backend.compression !== cfg.backend.compression) throw Error('raw-backend-binding-mismatch');
    const actual = createHash('sha256').update(fs.readFileSync(cfg.backend.moduleFile)).digest('hex');
    if (actual !== cfg.backend.sha256) throw Error('raw-backend-module-changed');
  };
  const authorize = header => {
    assertActive();
    if (!header || !text(header.id)) throw Error('raw-invalid-session-header');
    if (header.cwd !== undefined && header.cwd !== null && header.cwd !== '') {
      if (!absolute(header.cwd)) throw Error('raw-unresolved-scope');
      const projectId = roots.get(path.resolve(header.cwd));
      if (!projectId || !cfg.allowedProjectIds.includes(projectId)) throw Error('raw-unresolved-scope');
      return { kind:'project-private', principalId:cfg.principalId, projectId };
    }
    if (cfg.noProjectScope === 'user-shared' && cfg.capabilities?.includes('shared-write')) return {kind:'user-shared',principalId:cfg.principalId};
    throw Error('raw-unresolved-scope');
  };
  assertActive();
  return Object.freeze({
    directory:path.resolve(cfg.directory), registryRoot:path.resolve(cfg.registryRoot), sourceRoot:path.resolve(cfg.sourceRoot), instanceId:cfg.instanceId,
    intervalMs:Number.isSafeInteger(cfg.intervalMs) && cfg.intervalMs >= 10 ? cfg.intervalMs : 5000,
    pageSize:Number.isSafeInteger(cfg.pageSize) && cfg.pageSize > 1 ? cfg.pageSize : 128,
    binding:Object.freeze({sourceRoot:path.resolve(cfg.sourceRoot),instanceId:cfg.instanceId,principalId:cfg.principalId,backend:cfg.backend}),
    assertActive, assertBackend, authorize, revoke(){ valid=false; },
  });
}
