import path from 'node:path';
import { createResourceScope } from './resource-lifecycle.mjs';
import { types } from 'node:util';
import { createRawIngestPolicy } from './raw-ingest-policy.mjs';
import { openNamespace } from './raw-namespace.mjs';
import { RawRepository } from './raw-repository.mjs';
import { encodeIdentity, equalBytes } from './raw-codec.mjs';
import { observeRaw, OBSERVATION_LIMITS, ownLimit } from './raw-observation.mjs';

const HARD_MAX_SESSIONS = 10000;

// Inspect own data descriptors before passing a graph to reflection or cloning.
function hasUnsafeGraph(value, seen, depth, budget, local) {
  if (++budget.nodes > budget.max.nodes) { budget.exceeded = true; throw RangeError('raw-read-budget'); }
  if (typeof value === 'string') {
    budget.codeUnits += value.length;
    if (budget.codeUnits > budget.max.codeUnits) { budget.exceeded = true; throw RangeError('raw-read-budget'); }
  }
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (types.isProxy(value) || typeof value === 'function' || depth > 128 || ++local.nodes > 4096) return true;
  // Identity does not encode prototypes, aliases, or descriptor flags. Cloning
  // such graphs could silently change their meaning while preserving identity.
  if (seen.has(value)) return true;
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return true;
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  budget.properties += keys.length;
  if (budget.properties > budget.max.properties) { budget.exceeded = true; throw RangeError('raw-read-budget'); }
  for (const key of keys) {
    if (typeof key === 'string') budget.codeUnits += key.length;
    if (budget.codeUnits > budget.max.codeUnits) { budget.exceeded = true; throw RangeError('raw-read-budget'); }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return true;
    if (!(array && key === 'length') && (!descriptor.enumerable || !descriptor.writable || !descriptor.configurable)) return true;
    if (array && key === 'length' && !descriptor.writable) return true;
    if (hasUnsafeGraph(descriptor.value, seen, depth + 1, budget, local)) return true;
  }
  return false;
}

function unknownReadSlot(reason) {
  return { observation: { format: 'raw-observation-v2', identity: false, completeGraph: false, partial: true,
    observedPartial: true, hiddenSlotsUnverified: false, locations: [{ parent: null }],
    records: [{ kind: 'unknown', location: 0, reason }] } };
}

// This bounds aggregate work by the batch cap times the per-item limits, not memory.
export const RAW_READ_BATCH_LIMIT = 256;
const appendOwn = (array, value) => Object.defineProperty(array, array.length, { value, writable: true, enumerable: true, configurable: true });
const readBatchStates = new WeakMap();

// Exports capture-time metadata only, never items, snapshots, identity or evidence.
// Batch spreads/copies are not batches and must not be used for full transport.
export function exportRawReadState(batch) {
  if ((typeof batch !== 'object' && typeof batch !== 'function') || batch === null || types.isProxy(batch)) throw TypeError('raw-invalid-read-batch');
  const state = readBatchStates.get(batch);
  if (state === undefined) throw TypeError('raw-invalid-read-batch');
  return state;
}

// Capture observations before yielding; observations never establish identity.
export function captureRawRead(events, limits = {}) {
  if (types.isProxy(events) || !Array.isArray(events)) throw Error('raw-invalid-read');
  const batch = ownLimit(limits, 'batch', RAW_READ_BATCH_LIMIT, 'raw-invalid-read-limit');
  if (!Number.isSafeInteger(batch) || batch < 0 || batch > RAW_READ_BATCH_LIMIT) throw RangeError('raw-invalid-batch-limit');
  const length = Object.getOwnPropertyDescriptor(events, 'length').value;
  if (length > batch) throw RangeError('raw-batch-limit');
  const captured = [];
  const maxima = { nodes: 65536, properties: 32768, codeUnits: 2097152 };
  const max = Object.create(null);
  for (const key of Object.keys(maxima)) {
    max[key] = ownLimit(limits, key, maxima[key], 'raw-invalid-read-limit');
    if (!Number.isSafeInteger(max[key]) || max[key] < 0 || max[key] > maxima[key]) throw RangeError('raw-invalid-read-limit');
  }
  const budget = { nodes: 0, properties: 0, codeUnits: 0, exceeded: false, max };
  let next = length, limited = null;
  for (let index = 0; index < length; index++) {
    const before = { nodes: budget.nodes, properties: budget.properties, codeUnits: budget.codeUnits };
    const descriptor = Object.getOwnPropertyDescriptor(events, String(index));
    if (!descriptor) { appendOwn(captured, unknownReadSlot('array-hole')); continue; }
    if (!Object.hasOwn(descriptor, 'value')) { appendOwn(captured, unknownReadSlot('accessor')); continue; }
    const event = descriptor.value;
    try {
      if (hasUnsafeGraph(event, new WeakSet(), 0, budget, { nodes: 0 })) throw Error('raw-unsafe-graph');
      const identity = encodeIdentity(event);
      const snapshot = structuredClone(event);
      if (!equalBytes(identity, encodeIdentity(snapshot))) throw Error('raw-clone-changed');
      const item = { snapshot, identity };
      Object.defineProperty(item, 'toJSON', { value() { throw TypeError('raw-snapshot-not-json-serializable'); } });
      appendOwn(captured, item);
    } catch {
      // Discard speculative preflight charges and account for the actual observation.
      Object.assign(budget, before, { exceeded: false });
      const remaining = Object.create(null);
      for (const key of Object.keys(max)) remaining[key] = Math.min(max[key] - budget[key], OBSERVATION_LIMITS[key]);
      const observation = observeRaw(event, remaining);
      for (const key of Object.keys(max)) budget[key] += observation.usage[key];
      appendOwn(captured, { observation });
      if (observation.limitHit) { next = index; limited = { index, reason: 'observation-limit' }; break; }
    }
  }
  const result = {
    format: 'raw-read-batch-v2',
    items: captured,
    traversalComplete: next === length,
    // Traversal alone proves neither identity nor durable preservation.
    evidenceComplete: false,
    partialIndex: limited ? next : null,
    unprocessed: next === length ? null : { start: next + 1, end: length },
    limited,
    usage: { nodes: budget.nodes, properties: budget.properties, codeUnits: budget.codeUnits },
  };
  // Block inherited toJSON hooks before JSON.stringify visits any nested values.
  Object.defineProperty(result, 'toJSON', { value() { throw TypeError('raw-batch-not-json-serializable'); } });
  // Construct JSON from bounded primitives, without consulting inherited toJSON hooks.
  const range = limited ? `{"start":${next + 1},"end":${length}}` : 'null';
  const restriction = limited ? `{"index":${next},"reason":"observation-limit"}` : 'null';
  const partial = limited ? String(next) : 'null';
  readBatchStates.set(result, `{"format":"raw-read-state-v1","traversalComplete":${next === length},"evidenceComplete":false,"partialIndex":${partial},"unprocessed":${range},"limited":${restriction},"usage":{"nodes":${budget.nodes},"properties":${budget.properties},"codeUnits":${budget.codeUnits}}}`);
  return result;
}
// This checks current snapshot/identity consistency only, not provenance or
// immutability. Both values can be changed together, including after validation.
// Snapshot items are in-memory only; JSON has no supported recovery contract.
export function validateCapturedSnapshot(item) {
  if (!item || typeof item !== 'object' || types.isProxy(item)) throw TypeError('raw-invalid-captured-snapshot');
  const identity = Object.getOwnPropertyDescriptor(item, 'identity');
  const snapshot = Object.getOwnPropertyDescriptor(item, 'snapshot');
  if (!identity || !snapshot || !Object.hasOwn(identity, 'value') || !Object.hasOwn(snapshot, 'value') || !Buffer.isBuffer(identity.value) || types.isProxy(identity.value)) throw TypeError('raw-invalid-captured-snapshot');
  const budget = { nodes: 0, properties: 0, codeUnits: 0, max: { nodes: 65536, properties: 32768, codeUnits: 2097152 } };
  if (hasUnsafeGraph(snapshot.value, new WeakSet(), 0, budget, { nodes: 0 }) || !equalBytes(identity.value, encodeIdentity(snapshot.value))) throw TypeError('raw-invalid-captured-snapshot');
  return snapshot.value;
}
const same=(a,b)=>equalBytes(encodeIdentity(a),encodeIdentity(b));

export function installRawHostAdapter(ctx, input) {
  const policy=createRawIngestPolicy(input);
  if(!policy) return ()=>{};
  if(typeof ctx.inject!=='function') throw Error('raw-host-inject-required');
  let disposed=false, previousClosed=Promise.resolve();
  const workers=new Set();
  let injection;
  try{injection=ctx.inject(['sessions','sessionPersistence'], child=>{
    const backend=child.sessionPersistence;
    policy.assertBackend(backend);
    const predecessor=previousClosed;
    let release,rejectRelease,lease,repo,predecessorFailure,predecessorFailed=false;
    previousClosed=new Promise((resolve,reject)=>{release=resolve;rejectRelease=reject;});
    previousClosed.catch(()=>{});
    let active=true,timer=null,handleCloseFailed=false,handleClosed=Promise.resolve();
    const retainedHandles = new Set();
    const diagnostics=new Set();
    const diagnose=error=>{let message;try{message=String(error?.message ?? error).slice(0,160);}catch{message='unprintable error';}if(diagnostics.size<16&&!diagnostics.has(message)){diagnostics.add(message);console.error('[memjudge raw archive]',message);}};
    const abort=new AbortController();
    const check=header=>{if(disposed||!active||child.sessionPersistence?.identity!==backend.identity)throw Error('raw-stale-epoch');policy.assertBackend(backend);if(header)policy.authorize(header);};
    const scan=async()=>{
      check();
      if(retainedHandles.size) throw Error('raw-handle-close-pending');
      const listed=await backend.list({signal:abort.signal});
      if(types.isProxy(listed)||!Array.isArray(listed)||listed.length>HARD_MAX_SESSIONS) throw Error('raw-session-list-budget');
      for(const entry of listed){
        check();
        let handle, horizon=null, events=[], provenance, unknown=false, publishing=false, currentSessionId='';
        const variants=[], untrusted=new Set();
        let authorizedHeader;
        const preserve=()=>{publishing=true;for(let i=0;i<events.length+variants.length;i++){check(authorizedHeader);const event=i<events.length?events[i]:variants[i-events.length];const result=repo.ingestHostEvent({fullSessionId:currentSessionId,event,source:provenance,untrustedIdentity:untrusted.has(event)});if(result.classification==='pending')throw Error('raw-preservation-pending');}};
        try{
          if(types.isProxy(entry)) throw Error('raw-unbounded-source-metadata');
          const headerDescriptor=Object.getOwnPropertyDescriptor(entry??{},'header');
          if(!headerDescriptor||!Object.hasOwn(headerDescriptor,'value')||types.isProxy(headerDescriptor.value)) throw Error('raw-invalid-session-header');
          const header=headerDescriptor.value;
          if(types.isProxy(header)) throw Error('raw-invalid-session-header');
          authorizedHeader=header;
          const sessionId=Object.getOwnPropertyDescriptor(header??{},'id');
          if(!sessionId||!Object.hasOwn(sessionId,'value')||typeof sessionId.value!=='string'||!sessionId.value) throw Error('raw-invalid-session-header');
          currentSessionId=sessionId.value;
          check(header);
          // List metadata is required to be a bounded, own-data contract before open may parse content.
          const metadata=policy.validateMetadata(entry);
          const authorized=policy.authorize(header);
          const headerFields=Object.create(null);
          for(const key of ['id','cwd','createdAt','updatedAt']){const descriptor=Object.getOwnPropertyDescriptor(header,key);if(descriptor&&Object.hasOwn(descriptor,'value'))headerFields[key]=descriptor.value;else if(descriptor)throw Error('raw-invalid-session-header');}
          if(Object.keys(headerFields).length>8||Object.values(headerFields).some(value=>typeof value==='string'&&value.length>4096))throw Error('raw-invalid-session-header');
          const headerCopy=structuredClone(headerFields);
          const headerBytes=Buffer.byteLength(JSON.stringify(headerCopy),'utf8');
          if(headerBytes>policy.budget.maxHeaderBytes)throw Error('raw-invalid-session-header');
          provenance={...policy.binding,scope:authorized,header:headerCopy,inheritedEventCount:0};
          handle=await backend.open(currentSessionId,'read',{signal:abort.signal,limits:policy.budget,expectedRevision:metadata.revision,metadata});
          check(handle.header);
          if(!same(headerCopy,handle.header)||handle.revision!==metadata.revision||handle.inheritedEventCount!==metadata.eventCount)throw Error('raw-header-changed');
          const inherited=handle.inheritedEventCount;
          provenance.inheritedEventCount=inherited;
          events.length=metadata.eventCount;
          for(let start=0;start<metadata.eventCount;start+=policy.pageSize){
            check(handle.header);
            const count=Math.min(policy.pageSize,metadata.eventCount-start);
            const page=await handle.read(start,count,{signal:abort.signal,limits:policy.budget,expectedRevision:metadata.revision,maxBytes:policy.budget.maxPageBytes});
            check(handle.header);
            if(types.isProxy(page)||!page||types.isProxy(page.events)||!Array.isArray(page.events)||page.events.length!==count||page.revision!==metadata.revision||!Number.isSafeInteger(page.decodedBytes)||page.decodedBytes>policy.budget.maxPageBytes||page.decodedBytes<count*metadata.maxEventBytes)throw Error('raw-page-budget-contract');
            for(let i=0;i<count;i++){
              const event=page.events[i], seq=Object.getOwnPropertyDescriptor(event??{},'seq');
              if(!seq||!Object.hasOwn(seq,'value')||seq.value!==start+i)throw Error('raw-sequence-gap');
              let encoded;
              try{encoded=encodeIdentity(event);}catch{throw Error('raw-event-identity-budget');}
              if(encoded.length>policy.budget.maxEventBytes)throw Error('raw-event-byte-budget');
              const graph={nodes:0,properties:0,codeUnits:0,max:{nodes:policy.budget.maxGraphNodes,properties:policy.budget.maxGraphProperties,codeUnits:policy.budget.maxCodeUnits}};
              if(hasUnsafeGraph(event,new WeakSet(),0,graph,{nodes:0})) throw Error('raw-event-graph-budget');
              const clone=structuredClone(event);
              if(!equalBytes(encoded,encodeIdentity(clone)))throw Error('raw-event-clone-changed');
              events[start+i]=clone;
            }
          }
          horizon=metadata.eventCount;
          const after=await backend.stat(currentSessionId,{signal:abort.signal});
          check(handle.header);
          if(!after||after.revision!==metadata.revision||!same(after.header,headerCopy)||handle.revision!==metadata.revision||handle.inheritedEventCount!==inherited)throw Error('raw-revision-changed');
          await handle.close();handle=null;
          check(headerCopy);
          preserve();
          repo.clearHostUncertain({fullSessionId:currentSessionId,events,provenance});
          if(events.length)repo.recordHostPrefix({fullSessionId:currentSessionId,events,provenance});
        }catch(error){
          // Metadata/read instability never publishes event identities or proofs.
          check();
          const message=error?.message;
          const reason=['raw-unresolved-scope','raw-invalid-session-header','raw-unbounded-source-metadata','raw-session-list-budget','raw-page-budget-contract','raw-event-byte-budget','raw-event-identity-budget','raw-event-graph-budget','raw-sequence-gap','raw-prefix-changed','raw-revision-changed','raw-header-changed'].includes(message)?message:'source-unavailable';
          repo.recordHostDirty({fullSessionId:currentSessionId,nextSeq:horizon,reason});
          diagnose(error);
        }finally{if(handle){retainedHandles.add(handle);handleClosed=Promise.resolve().then(()=>handle.close());try{await handleClosed;retainedHandles.delete(handle);handleCloseFailed=retainedHandles.size>0;}catch(error){handleCloseFailed=true;throw error;}}}
      }
    };
    let pending=Promise.resolve();
    const retryRetainedHandles=async()=>{
      for(const handle of [...retainedHandles]){await handle.close();retainedHandles.delete(handle);}
      handleCloseFailed=retainedHandles.size>0;
    };
    const tick=()=>{pending=(async()=>{try{await retryRetainedHandles();await scan();}catch(error){if(active&&!disposed)diagnose(error);}finally{if(active&&!disposed&&!handleCloseFailed){timer=setTimeout(tick,policy.intervalMs);timer.unref?.();}}})();};
    const workerScope=createResourceScope();
    workerScope.defer(async()=>{
      active=false;
      abort.abort(); clearTimeout(timer); timer=null;
      // A scan error is diagnostic; retained handles, not stale errors, own retries.
      await pending.catch(diagnose);
      await handleClosed;
      await retryRetainedHandles();
      if(predecessorFailed) throw new AggregateError([predecessorFailure],'raw-predecessor-close-unconfirmed');
      await repo?.close(); repo=null;
      await lease?.close(); lease=null;
      release(); workers.delete(cleanup);
    });
    const cleanup=()=>workerScope.close();
    workers.add(cleanup);
    pending=(async()=>{
      try{await predecessor;}catch(error){predecessorFailed=true;predecessorFailure=error;return;}
      if(!active||disposed)return;
      try{
        check();lease=openNamespace({...policy,writable:true});
        repo=new RawRepository(path.join(policy.directory,'raw.sqlite'),lease);
        await scan();
      }catch(error){if(active&&!disposed)diagnose(error);}
      finally{if(repo&&active&&!disposed){timer=setTimeout(tick,policy.intervalMs);timer.unref?.();}}
    })();
    try{child.effect(()=>cleanup);}catch(error){cleanup().catch(()=>{});throw error;}
    return cleanup;
  });}catch(error){disposed=true;try{policy.revoke();}catch{}for(const stop of workers)stop().catch(()=>{});throw error;}
  const stopScope=createResourceScope();
  let injectionClosed=false;
  stopScope.defer(async()=>{
    const results=await Promise.allSettled([...workers].map(stop=>Promise.resolve().then(stop)));
    const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);
    if(!injectionClosed){try{await (typeof injection==='function'?injection():injection?.dispose?.());injectionClosed=true;}catch(error){errors.push(error);}}
    if(errors.length)throw new AggregateError(errors,'raw host cleanup failed');
  });
  return ()=>{disposed=true;policy.revoke();return stopScope.close();};
}
