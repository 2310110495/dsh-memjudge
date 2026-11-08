import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

const absolute = value => typeof value === 'string' && path.isAbsolute(value);
const text = value => typeof value === 'string' && value.length > 0;
const HARD_BUDGET = Object.freeze({
  maxSessionBytes: 8 * 1024 * 1024,
  maxEventBytes: 256 * 1024,
  maxEvents: 10000,
  maxPageBytes: 1024 * 1024,
  maxGraphNodes: 65536,
  maxGraphProperties: 32768,
  maxCodeUnits: 2 * 1024 * 1024,
  maxHeaderBytes: 16 * 1024,
});
const ownData = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return null;
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
};

// Only apply's host-owned startup argument enters this closure. Request/event
// fields never add grants. Same-process plugins and the OS account are trusted.
export function createRawIngestPolicy(input) {
  const required = ['enabled','mode','principalId','instanceId','directory','registryRoot','sourceRoot'];
  const initial = ownData(input, required);
  if (!initial || initial.enabled !== true) return null;
  if (initial.mode !== 'archive-only' || !text(initial.principalId) || !text(initial.instanceId)
      || !['directory','registryRoot','sourceRoot'].every(k => absolute(initial[k]))) throw Error('raw-invalid-deployment-policy');
  if (types.isProxy(input)) throw Error('raw-invalid-deployment-policy');
  const cfg = Object.create(null);
  if(Reflect.ownKeys(input).length>64)throw Error('raw-invalid-deployment-policy');
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') throw Error('raw-invalid-deployment-policy');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor,'value')) throw Error('raw-invalid-deployment-policy');
    cfg[key] = descriptor.value;
  }
  let policyNodes=0, policyProperties=0;
  const rejectNestedProxy = (value, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    if(++policyNodes>10000) throw Error('raw-invalid-deployment-policy');
    if (types.isProxy(value)) throw Error('raw-invalid-deployment-policy');
    seen.add(value);
    const keys=Reflect.ownKeys(value);policyProperties+=keys.length;
    if(policyProperties>20000) throw Error('raw-invalid-deployment-policy');
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('raw-invalid-deployment-policy');
      if(typeof key==='string'&&key.length>256) throw Error('raw-invalid-deployment-policy');
      rejectNestedProxy(descriptor.value, seen);
    }
  };
  try { rejectNestedProxy(cfg); structuredClone(cfg); } catch { throw Error('raw-invalid-deployment-policy'); }
  if (!Array.isArray(cfg.principals) || !cfg.principals.includes(cfg.principalId)
      || !Array.isArray(cfg.allowedProjectIds) || !Array.isArray(cfg.projects)) throw Error('raw-unknown-principal');
  if (!cfg.backend || !absolute(cfg.backend.moduleFile) || !/^[a-f0-9]{64}$/.test(cfg.backend.sha256)
      || cfg.backend.name !== 'session-persistence-jsonl' || !['none','zstd'].includes(cfg.backend.compression)) throw Error('raw-invalid-backend-binding');
  const budgetKeys = Object.keys(HARD_BUDGET);
  const suppliedBudget = ownData(cfg.budget, budgetKeys);
  if (!suppliedBudget || budgetKeys.some(key => !Number.isSafeInteger(suppliedBudget[key]) || suppliedBudget[key] <= 0 || suppliedBudget[key] > HARD_BUDGET[key])
      || suppliedBudget.maxEventBytes > suppliedBudget.maxPageBytes || suppliedBudget.maxPageBytes > suppliedBudget.maxSessionBytes
      || suppliedBudget.maxEvents > 10000 || suppliedBudget.maxGraphNodes > 65536
      || suppliedBudget.maxGraphProperties > 32768 || suppliedBudget.maxCodeUnits > 2 * 1024 * 1024
      || cfg.backend.contract !== 'bounded-jsonl-v1' || cfg.backend.implementationContract !== 'bounded-jsonl-v1') throw Error('raw-explicit-budget-contract-required');
  if (suppliedBudget.maxGraphNodes < suppliedBudget.maxEvents || suppliedBudget.maxGraphProperties < suppliedBudget.maxEvents || suppliedBudget.maxCodeUnits < suppliedBudget.maxEventBytes / 2) throw Error('raw-explicit-budget-contract-required');
  const budget = Object.freeze(suppliedBudget);
  const validateMetadata = entry => {
    if (types.isProxy(entry)) throw Error('raw-unbounded-source-metadata');
    const fields = ownData(entry, ['revision','sizeBytes','decodedBytes','maxEventBytes','eventCount']);
    if (!fields || typeof fields.revision !== 'string' || !fields.revision || fields.revision.length > 256
        || ['sizeBytes','decodedBytes','maxEventBytes','eventCount'].some(key => !Number.isSafeInteger(fields[key]) || fields[key] < 0)
        || fields.sizeBytes > budget.maxSessionBytes || fields.decodedBytes > budget.maxSessionBytes
        || fields.maxEventBytes > budget.maxEventBytes || fields.eventCount > budget.maxEvents
        || (fields.eventCount===0 ? fields.maxEventBytes!==0 : fields.maxEventBytes===0 || fields.maxEventBytes>fields.decodedBytes)
        || (fields.eventCount === 0) !== (fields.decodedBytes === 0)
        || fields.decodedBytes > fields.eventCount * budget.maxEventBytes) throw Error('raw-unbounded-source-metadata');
    return Object.freeze(fields);
  };
  const roots = new Map(), ids = new Set();
  for (const project of cfg.projects) {
    const fields=ownData(project,['id','cwd']);
    if (!fields || !text(fields.id) || !absolute(fields.cwd) || roots.has(path.resolve(fields.cwd)) || ids.has(fields.id)) throw Error('raw-invalid-project-registry');
    roots.set(path.resolve(fields.cwd), fields.id); ids.add(fields.id);
  }
  if (!Array.isArray(cfg.allowedProjectIds)||cfg.allowedProjectIds.length>10000||cfg.allowedProjectIds.some(id => !ids.has(id))) throw Error('raw-unknown-project-grant');
  let valid = true;
  const assertActive = () => { if (!valid || (cfg.expiresAt !== undefined && (!Number.isFinite(cfg.expiresAt) || Date.now() >= cfg.expiresAt))) throw Error('raw-policy-expired'); };
  const assertBackend = backend => {
    assertActive();
    if (!backend || types.isProxy(backend) || typeof backend.identity !== 'symbol' || backend.name !== cfg.backend.name
        || !absolute(backend.root) || path.resolve(backend.root) !== path.resolve(cfg.sourceRoot)
        || backend.compression !== cfg.backend.compression || backend.rawReadContract !== 'bounded-jsonl-v1'
        || backend.maxRawReadBytes < cfg.budget.maxPageBytes || backend.maxRawEventBytes < cfg.budget.maxEventBytes
        || backend.maxRawReadEvents < Math.max(1, Math.floor(cfg.budget.maxPageBytes / cfg.budget.maxEventBytes))) throw Error('raw-backend-binding-mismatch');
    const actual = createHash('sha256').update(fs.readFileSync(cfg.backend.moduleFile)).digest('hex');
    if (actual !== cfg.backend.sha256) throw Error('raw-backend-module-changed');
  };
  const authorize = header => {
    assertActive();
    if (!header || types.isProxy(header)) throw Error('raw-invalid-session-header');
    const fields=ownData(header,['id','cwd']);
    if (!fields || !text(fields.id) || fields.id.length>256 || (fields.cwd!==undefined&&fields.cwd!==null&&fields.cwd.length>4096)) throw Error('raw-invalid-session-header');
    if (fields.cwd !== undefined && fields.cwd !== null && fields.cwd !== '') {
      if (!absolute(fields.cwd)) throw Error('raw-unresolved-scope');
      const projectId = roots.get(path.resolve(fields.cwd));
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
    pageSize:Number.isSafeInteger(cfg.pageSize) && cfg.pageSize > 0 && cfg.pageSize <= Math.max(1, Math.floor(budget.maxPageBytes / budget.maxEventBytes)) ? cfg.pageSize : Math.max(1, Math.floor(budget.maxPageBytes / budget.maxEventBytes)),
    binding:Object.freeze({sourceRoot:path.resolve(cfg.sourceRoot),instanceId:cfg.instanceId,principalId:cfg.principalId,backend:cfg.backend}),
    budget, validateMetadata, assertActive, assertBackend, authorize, revoke(){ valid=false; },
  });
}
