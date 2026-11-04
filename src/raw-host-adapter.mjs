import path from 'node:path';
import { types } from 'node:util';
import { createRawIngestPolicy } from './raw-ingest-policy.mjs';
import { openNamespace } from './raw-namespace.mjs';
import { RawRepository } from './raw-repository.mjs';
import { encodeIdentity, equalBytes } from './raw-codec.mjs';
import { observeRaw, OBSERVATION_LIMITS, ownLimit } from './raw-observation.mjs';

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
  const injection=ctx.inject(['sessions','sessionPersistence'], child=>{
    const backend=child.sessionPersistence;
    policy.assertBackend(backend);
    const predecessor=previousClosed;
    let release,lease,repo;
    previousClosed=new Promise(resolve=>release=resolve);
    let active=true,timer=null;
    const diagnostics=new Set();
    const diagnose=error=>{const message=String(error.message).slice(0,160);if(diagnostics.size<16&&!diagnostics.has(message)){diagnostics.add(message);console.error('[memjudge raw archive]',message);}};
    const abort=new AbortController();
    const check=header=>{if(disposed||!active||child.sessionPersistence?.identity!==backend.identity)throw Error('raw-stale-epoch');policy.assertBackend(backend);if(header)policy.authorize(header);};
    const scan=async()=>{
      check();
      const listed=await backend.list({signal:abort.signal});
      for(const entry of listed){
        check();
        let handle, horizon=null, events, provenance, unknown=false, cloneFailed=false, publishing=false;
        const variants=[], untrusted=new Set();
        const preserve=()=>{publishing=true;for(const event of [...events,...variants]){check(entry.header);const result=repo.ingestHostEvent({fullSessionId:entry.header.id,event,source:provenance,untrustedIdentity:untrusted.has(event)});if(result.classification==='pending')throw Error('raw-preservation-pending');}};
        try{
          check(entry.header);
          if(entry.sizeBytes===undefined){repo.recordHostDirty({fullSessionId:entry.header.id,nextSeq:null,reason:'list-pending'});continue;}
          // open(read) itself reads JSONL bodies: authorization precedes it.
          check(entry.header);
          handle=await backend.open(entry.header.id,'read',{signal:abort.signal});
          check(handle.header);
          if(!same(entry.header,handle.header))throw Error('raw-header-changed');
          const inherited=handle.inheritedEventCount;
          const first=await handle.read(0,Number.MAX_SAFE_INTEGER,{signal:abort.signal});
          check(handle.header);
          provenance={...policy.binding,scope:policy.authorize(entry.header),header:entry.header,inheritedEventCount:inherited};
          events=first.events;
          if(!Array.isArray(events)||!events.length){repo.recordHostDirty({fullSessionId:entry.header.id,nextSeq:null,reason:'read-empty-unknown'});continue;}
          const unknownPositions=[];
          events=events.map((event,index)=>{
            try { encodeIdentity(event); }
            catch (error) {
              unknown=true; unknownPositions.push(index);
              untrusted.add(event);
              return event;
            }
            try { return structuredClone(event); }
            catch { unknown=true; cloneFailed=true; unknownPositions.push(index); untrusted.add(event); return event; }
          });
          const sequence=events.map(event=>{try{const d=Object.getOwnPropertyDescriptor(event,'seq');return d && Object.hasOwn(d, 'value')?d.value:undefined;}catch{return undefined;}});
          if(unknownPositions.length){
            // Positions bound identity only when the complete sequence proves its order.
            const ordered=sequence.every((seq,i)=>seq===i);
            repo.markHostUncertain({fullSessionId:entry.header.id,provenance,startSeq:ordered?unknownPositions[0]:0,endSeq:events.length});
          }
          const H=sequence.at(-1)+1;horizon=H;
          if(!Number.isSafeInteger(H)||H!==events.length||sequence.some((seq,i)=>seq!==i))throw Error('raw-sequence-gap');
          for(let start=0;start<H;start+=policy.pageSize){
            check(handle.header);
            const offset=Math.max(0,start-1),n=Math.min(H-offset,policy.pageSize+1);
            const page=await handle.read(offset,n,{signal:abort.signal});
            if(!Array.isArray(page.events)||page.events.length!==n)throw Error('raw-prefix-changed');
            check(handle.header);
            for(let i=0;i<n;i++) {
              let baseline, current, baselineError, currentError;
              try { baseline=encodeIdentity(events[offset+i]); } catch(error) { baselineError=error; }
              try { current=encodeIdentity(page.events[i]); } catch(error) { currentError=error; }
              if(baselineError || currentError) {
                unknown=true;
                // Neither read establishes equality when either identity is unavailable.
                // Preserve both as observations, never as a proven version conflict.
                untrusted.add(events[offset+i]);
                untrusted.add(page.events[i]);
                repo.markHostUncertain({fullSessionId:entry.header.id,provenance,startSeq:0,endSeq:H});
                // Unknown equality is not true. Preserve each read version;
                // repository evidence dedup never grants identity or a proof.
                variants.push(page.events[i]);
                continue;
              }
              if(!equalBytes(current,baseline))throw Error('raw-prefix-changed');
            }
          }
          check(handle.header);
          const after=await backend.stat(entry.header.id,{signal:abort.signal});
          check(handle.header);
          if(!after||after.revision!==entry.revision||!same(after.header,entry.header)||handle.inheritedEventCount!==inherited)throw Error('raw-revision-changed');
          await handle.close();handle=null;
          check(entry.header);
          preserve();
          if(unknown)repo.recordHostDirty({fullSessionId:entry.header.id,nextSeq:H,reason:'unsupported-identity'});
          if(cloneFailed)continue;
          check(entry.header);
          if(!unknown)repo.clearHostUncertain({fullSessionId:entry.header.id,events,provenance});
          repo.recordHostPrefix({fullSessionId:entry.header.id,events,provenance});
        }catch(error){
          // Global authority/epoch errors escape; only this session is isolated.
          check();
          // Read instability does not erase already authorized opaque evidence.
          // Publication failures are never retried through a fallback branch.
          if(unknown&&!publishing){check(entry.header);preserve();}
          const reason=['raw-unresolved-scope','raw-invalid-session-header','raw-sequence-gap','raw-prefix-changed','raw-revision-changed','raw-header-changed'].includes(error.message)?error.message:'source-unavailable';
          repo.recordHostDirty({fullSessionId:typeof entry.header?.id==='string'?entry.header.id:'',nextSeq:horizon,reason});
          diagnose(error);
        }finally{if(handle){try{await handle.close();}catch{check();}}}
      }
    };
    let pending=Promise.resolve(),closing=false;
    const tick=()=>{pending=(async()=>{try{await scan();}catch(error){if(active&&!disposed)diagnose(error);}finally{if(active&&!disposed){timer=setTimeout(tick,policy.intervalMs);timer.unref?.();}}})();};
    const cleanup=()=>{
      if(closing)return;
      closing=true;active=false;abort.abort();clearTimeout(timer);workers.delete(cleanup);
      // Outstanding reads must settle and close before releasing ownership.
      return pending.finally(()=>{try{repo?.close();}finally{try{lease?.close();}finally{release();}}});
    };
    workers.add(cleanup);
    pending=(async()=>{
      await predecessor;
      if(!active||disposed)return;
      try{
        check();lease=openNamespace({...policy,writable:true});
        repo=new RawRepository(path.join(policy.directory,'raw.sqlite'),lease);
        await scan();
      }catch(error){if(active&&!disposed)diagnose(error);}
      finally{if(repo&&active&&!disposed){timer=setTimeout(tick,policy.intervalMs);timer.unref?.();}}
    })();
    child.effect(()=>cleanup);
    return cleanup;
  });
  return ()=>{disposed=true;policy.revoke();for(const stop of workers)stop();if(typeof injection==='function')injection();else injection?.dispose?.();};
}
