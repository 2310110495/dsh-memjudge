import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { types as utilTypes } from 'node:util';

export const RAW_SCHEMA_VERSION = 2;
// Inspect a private snapshot, including committed WAL frames. Even SQLite's
// read-only open may create SHM files; unknown originals must remain untouched.
function preflightSchema(file) {
  if (!fs.existsSync(file)) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-schema-'));
  let db;
  try {
    const copy = path.join(root, 'raw.sqlite');
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, copy + suffix);
    db = new DatabaseSync(copy, { readOnly: true });
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== RAW_SCHEMA_VERSION) throw Error(version === 0 ? 'raw-schema-migration-required' : 'unsupported-raw-schema:' + version);
  } finally { if (db) db.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
import { encodeIdentity, domainHash, equalBytes, eventKey, utf16le, snapshotBytes } from './raw-codec.mjs';

// SQL TEXT receives only JSON-escaped identities, never raw UTF16 strings.
const sessionKey = value => JSON.stringify(value);
export const isIdentityFailure = error =>
  (error instanceof RangeError && ['identity-byte-limit','identity-node-limit','identity-depth-limit'].includes(error.message)) ||
  (error instanceof TypeError && error.message === 'unsupported-identity');

// Bounded, non-authoritative evidence: exceeding a limit disables reuse, not capture.
// String accounting assumes six JSON code units per input unit, plus structure.
const PRESERVATION_LIMITS=Object.freeze({nodes:4096,properties:8192,units:65536});
function preservationBytes(value) {
  const seen=new Map(), queue=[], nodes=[];
  let units=128,properties=0;
  const charge=n=>{units+=n;if(units>PRESERVATION_LIMITS.units)throw Error('preservation-budget');};
  const ref=v=>{
    if(v===null){charge(16);return ['null'];}
    const t=typeof v;
    if(t==='undefined'){charge(24);return ['undefined'];}
    if(t==='string'||t==='boolean'||t==='bigint'){
      if(t==='string')charge(v.length*6+32);
      else if(t==='bigint'){if(v > (1n<<1024n)||v < -(1n<<1024n))throw Error('preservation-budget');charge(2048);}
      else charge(32);
      return [t,String(v)];
    }
    if(t==='number'){charge(64);return [t,Object.is(v,-0)?'-0':String(v)];}
    if(t!=='object')throw new TypeError('opaque-preservation');
    charge(32);
    if(seen.has(v))return ['ref',seen.get(v)];
    if(queue.length>=PRESERVATION_LIMITS.nodes)throw Error('preservation-budget');
    const id=queue.length;seen.set(v,id);queue.push(v);return ['ref',id];
  };
  try {
    const root=ref(value);
    for(let i=0;i<queue.length;i++) {
      const v=queue[i];
      // Proxy traps can report a changing graph; never reuse their observations.
      if(utilTypes.isProxy(v))return null;
      const p=Object.getPrototypeOf(v),array=Array.isArray(v);
      if(array ? p!==Array.prototype : p!==Object.prototype&&p!==null)return null;
      const props=[];
      charge(64);
      const keys=Reflect.ownKeys(v);
      properties+=keys.length;
      if(properties>PRESERVATION_LIMITS.properties)return null;
      for(const key of keys) {
        if(typeof key!=='string')return null;
        charge(key.length*6+64);
        const d=Object.getOwnPropertyDescriptor(v,key);
        if(!d||!Object.hasOwn(d, 'value'))return null;
        props.push([key,Object.hasOwn(d,'enumerable') && !!d.enumerable,Object.hasOwn(d,'configurable') && !!d.configurable,Object.hasOwn(d,'writable') && !!d.writable,ref(d.value)]);
      }
      nodes.push([array?'array':p===null?'null-prototype':'object',props]);
    }
    return utf16le(JSON.stringify(['host-preservation-graph-v1',root,nodes]));
  } catch {
    // Reflection may fail for any reason; opaque graphs cannot be deduplicated.
    return null;
  }
}
// Copy only plain data, checking for proxies before any reflective operation.
function observationSnapshot(value, source = false) {
  const active = new Set();
  let nodes = 0, units = 0;
  function copy(v, depth) {
    if (++nodes > 100000 || depth > 256) throw Error('raw-invalid-observation');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      units += v.length;
      if (units > 2000000) throw Error('raw-invalid-observation');
      return v;
    }
    if (typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0)) return v;
    if (typeof v !== 'object' || utilTypes.isProxy(v) || active.has(v)) throw Error('raw-invalid-observation');
    const array = Array.isArray(v), prototype = Object.getPrototypeOf(v);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw Error('raw-invalid-observation');
    const keys = Reflect.ownKeys(v);
    if (keys.some(k => typeof k !== 'string')) throw Error('raw-invalid-observation');
    const out = array ? [] : Object.create(null);
    if (array && !source) Object.setPrototypeOf(out, null);
    active.add(v);
    try {
      const length = array ? Object.getOwnPropertyDescriptor(v, 'length').value : 0;
      if (array && (!Number.isSafeInteger(length) || length > 100000 || keys.length !== length + 1)) throw Error('raw-invalid-observation');
      for (const key of keys) {
        if (array && key === 'length') continue;
        units += key.length;
        if (units > 2000000 || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw Error('raw-invalid-observation');
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) throw Error('raw-invalid-observation');
        Object.defineProperty(out, key, { value: copy(d.value, depth + 1), enumerable: true, writable: false, configurable: false });
      }
      return Object.freeze(out);
    } finally { active.delete(v); }
  }
  return copy(value, 0);
}

// A module-wide process incarnation, never supplied by a caller or a receipt.
const hostProcess = randomUUID();
// Per-batch work budgets, never whole-input truncation limits.
export const RAW_CAPTURE_LIMITS = Object.freeze({ nodes: 50000, properties: 200000, segmentUnits: 32768, rows: 1024, bytes: 256 * 1024 });

// Flat, local graph IDs distinguish aliases, cycles and same-description Symbols.
// Reflection traps may throw; no accessor is evaluated. Every boundary is recorded.
function capture(db, value, kind) {
  const id = randomUUID(), seen = new WeakMap(), stack = [], issues = new Set();
  let nodes = 0, properties = 0, strings = 0;
  let batch = [], batchBytes = 0, batchNodes = 0, batchProperties = 0;
  let batches = 0, peakBatchRows = 0, peakBatchBytes = 0;
  const statements = new Map();
  const statement = sql => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  // Flush is NOT a commit. All batches, links, receipts and watermarks share
  // ingest's transaction. A failed batch throws; no partial acceptance escapes.
  const flush = () => {
    if (!batch.length) return;
    for (const [sql, args] of batch) statement(sql).run(...args);
    statement('INSERT INTO raw_capture_batches VALUES(?,?,?,?,?,?,?)').run(id,batches++,batch.length,batchBytes,batchNodes,batchProperties,'transaction-pending');
    peakBatchRows = Math.max(peakBatchRows,batch.length);
    peakBatchBytes = Math.max(peakBatchBytes,batchBytes);
    batch = []; batchBytes = 0; batchNodes = 0; batchProperties = 0;
  };
  const emit = (table, args) => {
    // Parameter payload accounting, not a claim about V8/SQLite heap overhead.
    const bytes = args.reduce((sum,v) => sum + (typeof v==='string' ? v.length*2 : v instanceof Uint8Array ? v.byteLength : 8),0);
    const node = Number(table==='raw_capture_nodes'), property = Number(table==='raw_capture_edges');
    if (batch.length && (batch.length >= RAW_CAPTURE_LIMITS.rows || batchBytes+bytes > RAW_CAPTURE_LIMITS.bytes || batchNodes+node > RAW_CAPTURE_LIMITS.nodes || batchProperties+property > RAW_CAPTURE_LIMITS.properties)) flush();
    if (bytes > RAW_CAPTURE_LIMITS.bytes) throw Error('capture-row-budget-exceeded');
    batch.push([`INSERT INTO ${table} VALUES(${args.map(()=>'?').join(',')})`,args]);
    batchBytes += bytes; batchNodes += node; batchProperties += property;
  };
  const add = (v, at, depth) => {
    const object = v !== null && (typeof v === 'object' || typeof v === 'function');
    if (object && seen.has(v)) return seen.get(v);
    const n = nodes++;
    if (object) seen.set(v,n);
    stack.push({ v, n, at, depth, entered:false, keys:null, ordinal:0 }); return n;
  };
  add(value,'$',0);
  while (stack.length) {
    const frame = stack[stack.length-1], {v,n,at,depth} = frame;
    if (!frame.entered) {
      frame.entered = true;
      const type = v === null ? 'null' : typeof v;
      emit('raw_capture_nodes',[id,n,type,null,null]);
      if (type === 'string') {
        strings++;
        for (let start=0, part=0; start<v.length || part===0; start+=RAW_CAPTURE_LIMITS.segmentUnits,part++) {
          const bytes=utf16le(v.slice(start,start+RAW_CAPTURE_LIMITS.segmentUnits));
          emit('raw_capture_blocks',[id,n,part,at,domainHash('raw-text-utf16le-v1',bytes),bytes]);
        }
      } else if (v !== null && (type === 'object' || type === 'function')) {
        try { frame.keys=Reflect.ownKeys(v); } catch { issues.add('own-keys-unavailable'); }
      }
    }
    if (!frame.keys || frame.ordinal===frame.keys.length) { stack.pop(); continue; }
    // One descriptor at a time: a wide parent never queues all child objects.
    // ownKeys arrays and the DFS/WeakMap identity state still scale with input.
    const local=frame.ordinal++, key=frame.keys[local], p=properties++;
    const labelText=typeof key==='symbol' ? key.description : key;
    let label=typeof key==='symbol' ? {type:'symbol',description:labelText??null,local} : {type:'string',key};
    if (labelText?.length > 1024) {
      label={type:typeof key==='symbol'?'symbol':'string',local,segmented:true};
      for(let start=0,part=0;start<labelText.length;start+=RAW_CAPTURE_LIMITS.segmentUnits,part++) {
        emit('raw_capture_labels',[id,p,part,utf16le(labelText.slice(start,start+RAW_CAPTURE_LIMITS.segmentUnits))]);
      }
    }
    let d, error=null, target=null;
    try { d=Object.getOwnPropertyDescriptor(v,key); } catch { error='descriptor-unavailable'; }
    if (d && Object.hasOwn(d, 'value')) target=add(d.value,depth<64 && typeof key==='string' && at.length+key.length<1024 ? `${at}[${JSON.stringify(key)}]` : `@node:${n}/property:${local}`,depth+1);
    else error ||= d ? 'accessor-not-evaluated' : 'descriptor-missing';
    if (error) issues.add(error);
    emit('raw_capture_edges',[id,p,n,target,encodeIdentity(label),error]);
  }
  flush();
  const classification=issues.size ? 'capture-partial' : 'capture-complete';
  db.prepare('INSERT INTO raw_captures VALUES(?,?,?,?,?,?)').run(id,kind,classification,nodes,strings,encodeIdentity([...issues]));
  // Visible batch records exist only after the enclosing COMMIT, never midway.
  db.prepare("UPDATE raw_capture_batches SET state='complete' WHERE capture_id=?").run(id);
  return {id,classification,nodes,strings,batches,peakBatchRows,peakBatchBytes};
}

// Internal ingest-only repository. No raw reads, tools, RPC or production entry wiring.
export class RawRepository {
  #db; #lease;
  constructor(file, lease) {
    lease.assertWritable(); this.#lease = lease;
    preflightSchema(file);
    this.#db = new DatabaseSync(file);
    try {
    const version = this.#db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== RAW_SCHEMA_VERSION) throw Error('unsupported-raw-schema:' + version);
    this.#db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS raw_unresolved(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, session_id TEXT, reason TEXT NOT NULL, payload BLOB, available_strings BLOB NOT NULL, evidence BLOB NOT NULL, source BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_events(event_key TEXT PRIMARY KEY, namespace TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_versions(id TEXT PRIMARY KEY, event_key TEXT NOT NULL REFERENCES raw_events, identity_hash TEXT, identity BLOB, snapshot_hash TEXT, snapshot BLOB, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_blocks(version_id TEXT NOT NULL REFERENCES raw_versions, path TEXT NOT NULL, hash TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(version_id,path));
      CREATE TABLE IF NOT EXISTS raw_evidence(id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES raw_versions, hash TEXT NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_sources(id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES raw_versions, source BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_conflicts(id TEXT PRIMARY KEY, event_key TEXT NOT NULL REFERENCES raw_events, first_version TEXT NOT NULL REFERENCES raw_versions, second_version TEXT NOT NULL REFERENCES raw_versions, first_length INTEGER, second_length INTEGER, first_difference INTEGER);
      CREATE TABLE IF NOT EXISTS raw_receipts(id TEXT PRIMARY KEY, event_key TEXT NOT NULL REFERENCES raw_events, version_id TEXT NOT NULL REFERENCES raw_versions, classification TEXT NOT NULL, durability TEXT NOT NULL CHECK(durability='observed'));
      CREATE TABLE IF NOT EXISTS raw_watermarks(namespace TEXT NOT NULL, session_id TEXT NOT NULL, raw_next INTEGER NOT NULL DEFAULT 0, verified_next INTEGER NOT NULL DEFAULT 0, derived_next INTEGER NOT NULL DEFAULT 0, integrity_cap INTEGER, PRIMARY KEY(namespace,session_id));
      CREATE TABLE IF NOT EXISTS raw_host_uncertainty(namespace TEXT NOT NULL, session_id TEXT NOT NULL, source BLOB NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL, PRIMARY KEY(namespace,session_id,source));
      CREATE TABLE IF NOT EXISTS raw_watermark_history(id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, session_id TEXT NOT NULL, previous_next INTEGER NOT NULL, next_seq INTEGER NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_invalidations(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, session_id TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_capture_batches(capture_id TEXT NOT NULL, batch INTEGER NOT NULL, rows INTEGER NOT NULL, payload_bytes INTEGER NOT NULL, nodes INTEGER NOT NULL, properties INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(capture_id,batch));
      CREATE TABLE IF NOT EXISTS raw_capture_labels(capture_id TEXT NOT NULL, property INTEGER NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(capture_id,property,part));
      CREATE TABLE IF NOT EXISTS raw_capture_links(capture_id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_captures(id TEXT PRIMARY KEY, kind TEXT NOT NULL, classification TEXT NOT NULL, nodes INTEGER NOT NULL, strings INTEGER NOT NULL, issues BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS raw_capture_nodes(capture_id TEXT NOT NULL, node INTEGER NOT NULL, type TEXT NOT NULL, reserved1 BLOB, reserved2 BLOB, PRIMARY KEY(capture_id,node));
      CREATE TABLE IF NOT EXISTS raw_capture_edges(capture_id TEXT NOT NULL, property INTEGER NOT NULL, parent INTEGER NOT NULL, target INTEGER, label BLOB NOT NULL, error TEXT, PRIMARY KEY(capture_id,property));
      CREATE TABLE IF NOT EXISTS raw_capture_blocks(capture_id TEXT NOT NULL, node INTEGER NOT NULL, part INTEGER NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(capture_id,node,part));
    `);
    lease.assertWritable();
    this.#db.exec('PRAGMA user_version=2; COMMIT');
    } catch (e) { this.#db.close(); throw e; }
  }
  close() { this.#db.close(); }
  ingest(input) { return this.#ingest(input); }
  #ingest({ fullSessionId, event, evidence = null, source = null, untrustedIdentity = false }, preservation = null) {
    this.#lease.assertWritable();
    const namespace = this.#lease.namespace;
    let seq;
    try { const d = event && typeof event === 'object' ? Object.getOwnPropertyDescriptor(event, 'seq') : undefined; seq = d && Object.hasOwn(d, 'value') ? d.value : undefined; }
    catch { /* A hostile reflection trap is an unresolved identity, not a lost capture. */ }
    let key;
    try { key = eventKey(namespace, fullSessionId, seq); }
    catch {
      const id = randomUUID();
      let payload = null;
      try { payload = encodeIdentity(event); } catch { /* Available strings remain independent of unsupported fields. */ }
      const session = typeof fullSessionId === 'string' && fullSessionId ? sessionKey(fullSessionId) : null;
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#lease.assertWritable();
        const preserved = capture(this.#db,event,'unresolved-event');
        this.#db.prepare('INSERT INTO raw_capture_links VALUES(?,?,?)').run(preserved.id,'unresolved',id);
        const strings=encodeIdentity(preserved);
        const ev=this.#metadata(evidence,'evidence'), src=this.#metadata(source,'source');
        this.#db.prepare('INSERT INTO raw_unresolved VALUES(?,?,?,?,?,?,?,?)').run(id,namespace,session,'invalid-event-key',payload,strings,ev,src);
        if (session) {
          this.#db.prepare('INSERT OR IGNORE INTO raw_watermarks(namespace,session_id) VALUES(?,?)').run(namespace,session);
          this.#db.prepare('UPDATE raw_watermarks SET integrity_cap=CASE WHEN integrity_cap IS NULL THEN raw_next ELSE min(integrity_cap,raw_next) END WHERE namespace=? AND session_id=?').run(namespace,session);
        }
        this.#lease.assertWritable(); this.#db.exec('COMMIT');
        return Object.freeze({ unresolvedId: id, classification: 'unresolved', durability: 'observed', capture: preserved });
      } catch (e) { this.#db.exec('ROLLBACK'); throw e; }
    }
    let identity = null, snapshot = null, status = 'committed';
    try { if(untrustedIdentity)throw Error('raw-untrusted-identity'); identity = encodeIdentity(event); snapshot = snapshotBytes(event); } catch { identity=null; snapshot=null; status = 'unsupported-identity'; }
    if (seq === Number.MAX_SAFE_INTEGER) status = 'unresolved-seq';
    const session = sessionKey(fullSessionId);
    const hash = identity && domainHash('event-identity-v1', identity);
    const db = this.#db;
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#lease.assertWritable();
      const preserved=capture(db,event,'event');
      if (preserved.classification==='capture-partial') status='unsupported-identity';
      const evidenceBytes=this.#metadata(evidence,'evidence'), sourceBytes=this.#metadata(source,'source');
      if (seq === Number.MAX_SAFE_INTEGER) db.prepare('INSERT INTO raw_unresolved VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),namespace,session,'unresolved-seq',identity,encodeIdentity(preserved),evidenceBytes,sourceBytes);
      db.prepare('INSERT OR IGNORE INTO raw_watermarks(namespace,session_id) VALUES(?,?)').run(namespace,session);
      db.prepare('INSERT OR IGNORE INTO raw_events VALUES(?,?,?,?,?)').run(key,namespace,session,seq,status);
      const versions = db.prepare('SELECT * FROM raw_versions WHERE event_key=?').all(key);
      const same = identity && versions.find(v => v.identity_hash === hash && v.identity !== null && equalBytes(v.identity,identity));
      let id = same?.id;
      if (!id) {
        id = randomUUID();
        db.prepare('INSERT INTO raw_versions VALUES(?,?,?,?,?,?,?)').run(id,key,hash,identity,snapshot && domainHash('event-object-snapshot-v1',snapshot),snapshot,status);
        for (const block of db.prepare('SELECT * FROM raw_capture_blocks WHERE capture_id=? ORDER BY node,part').iterate(preserved.id)) {
          const count=db.prepare('SELECT count(*) AS n FROM raw_capture_blocks WHERE capture_id=? AND node=?').get(preserved.id,block.node).n;
          const at=count===1 ? block.path : `@segment:${block.node}:${block.part}`;
          db.prepare('INSERT INTO raw_blocks VALUES(?,?,?,?)').run(id,at,block.hash,block.bytes);
        }
      }
      db.prepare('INSERT INTO raw_capture_links VALUES(?,?,?)').run(preserved.id,'version',id);
      db.prepare('INSERT INTO raw_evidence VALUES(?,?,?,?)').run(randomUUID(),id,domainHash('event-evidence-v1',evidenceBytes),evidenceBytes);
      db.prepare('INSERT INTO raw_sources VALUES(?,?,?)').run(randomUUID(),id,sourceBytes);
      if (!same && versions.length) {
        status = 'conflict';
        for (const old of versions) {
          let diff = null;
          if (old.identity && identity) { diff=0; while(diff < Math.min(old.identity.length,identity.length) && old.identity[diff] === identity[diff]) diff++; }
          db.prepare('INSERT INTO raw_conflicts VALUES(?,?,?,?,?,?,?)').run(randomUUID(),key,old.id,id,old.identity?.length ?? null,identity?.length ?? null,diff);
        }
      }
      const existing = db.prepare('SELECT state FROM raw_events WHERE event_key=?').get(key).state;
      if (existing !== 'committed') status = existing === 'conflict' ? 'conflict' : status === 'committed' ? existing : status;
      db.prepare('UPDATE raw_events SET state=? WHERE event_key=?').run(status,key);
      db.prepare('INSERT INTO raw_receipts VALUES(?,?,?,?,?)').run(randomUUID(),key,id,status,'observed');
      const mark = db.prepare('SELECT * FROM raw_watermarks WHERE namespace=? AND session_id=?').get(namespace,session);
      let cap = mark.integrity_cap;
      if (status !== 'committed') cap = cap === null ? seq : Math.min(cap,seq);
      const uncertain=db.prepare('SELECT min(start_seq) AS n FROM raw_host_uncertainty WHERE namespace=? AND session_id=?').get(namespace,session).n;
      const limit=Math.min(cap ?? Number.MAX_SAFE_INTEGER,uncertain ?? Number.MAX_SAFE_INTEGER);
      let next = Math.min(mark.raw_next,limit);
      while (next < limit) {
        const row = db.prepare('SELECT state FROM raw_events WHERE event_key=?').get(eventKey(namespace,fullSessionId,next));
        if (!row || row.state !== 'committed') break;
        next++;
      }
      if (cap !== null && cap < mark.raw_next) db.prepare('INSERT INTO raw_invalidations VALUES(?,?,?,?,?,?)').run(randomUUID(),namespace,session,cap,mark.raw_next,status);
      db.prepare('UPDATE raw_watermarks SET raw_next=?,verified_next=?,derived_next=?,integrity_cap=? WHERE namespace=? AND session_id=?').run(next,Math.min(mark.verified_next,next),Math.min(mark.derived_next,next),cap,namespace,session);
      db.prepare('INSERT INTO raw_watermark_history(namespace,session_id,previous_next,next_seq,reason) VALUES(?,?,?,?,?)').run(namespace,session,mark.raw_next,next,status);
      if(preservation) {
        db.exec('CREATE TABLE IF NOT EXISTS raw_host_preservations(version_id TEXT PRIMARY KEY REFERENCES raw_versions, source BLOB NOT NULL, graph BLOB NOT NULL)');
        db.prepare('INSERT INTO raw_host_preservations VALUES(?,?,?)').run(id,preservation.source,preservation.graph);
      }
      this.#lease.assertWritable();
      db.exec('COMMIT');
      return Object.freeze({ eventKey: key, versionId: id, classification: status, durability: 'observed', rawCommittedNextSeq: next, capture: preserved });
    } catch(e) { db.exec('ROLLBACK'); throw e; }
  }
  ingestHostEvent(input) {
    this.#lease.assertWritable();
    const {fullSessionId,event,source}=input;
    if(input.untrustedIdentity){
      // A separate graph scan and capture cannot establish one observation.
      // Persist a retry marker without claiming that the event was preserved.
      {
        const db=this.#db, session=sessionKey(fullSessionId), src=encodeIdentity(source);
        db.exec('BEGIN IMMEDIATE');
        try {
          this.#lease.assertWritable();
          db.exec('CREATE TABLE IF NOT EXISTS raw_host_pending(namespace TEXT NOT NULL, session_id TEXT NOT NULL, source BLOB NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(namespace,session_id,source))');
          db.prepare('INSERT INTO raw_host_pending VALUES(?,?,?,?) ON CONFLICT(namespace,session_id,source) DO UPDATE SET reason=excluded.reason').run(this.#lease.namespace,session,src,'untrusted-snapshot-retry');
          this.#lease.assertWritable(); db.exec('COMMIT');
          return Object.freeze({classification:'pending',reason:'untrusted-snapshot-retry',durability:'pending'});
        } catch(error) { db.exec('ROLLBACK'); throw error; }
      }
    }
    let key;
    try {
      const d=event && typeof event==='object' ? Object.getOwnPropertyDescriptor(event,'seq') : undefined;
      const seq=d && Object.hasOwn(d,'value') ? d.value : undefined;
      key=eventKey(this.#lease.namespace,fullSessionId,seq);
    } catch { return this.ingest(input); }
    let bytes,src;
    // Restrict the catch to codec work; SQL and lease errors never select fallback.
    try { bytes=encodeIdentity(event); }
    catch {
      const graph=preservationBytes(event),sourceGraph=preservationBytes(source);
      if(!graph||!sourceGraph)return this.ingest(input);
      if(this.#db.prepare("SELECT name FROM sqlite_master WHERE name='raw_host_preservations'").get()) {
        const rows=this.#db.prepare('SELECT p.*,e.state FROM raw_host_preservations p JOIN raw_versions v ON v.id=p.version_id JOIN raw_events e ON e.event_key=v.event_key WHERE v.event_key=?').iterate(key);
        for(const row of rows)if(equalBytes(row.source,sourceGraph)&&equalBytes(row.graph,graph)) {
          this.#lease.assertWritable();
          return Object.freeze({eventKey:key,versionId:row.version_id,classification:row.state,durability:'observed',reused:true,preservationOnly:true});
        }
      }
      return this.#ingest(input,{source:sourceGraph,graph});
    }
    try { src=encodeIdentity(source); } catch { return this.ingest(input); }
    // Reuse only a complete identity AND the same bound source, not a hash hit.
    const rows=this.#db.prepare('SELECT v.* FROM raw_versions v JOIN raw_events e ON e.event_key=v.event_key WHERE e.event_key=? AND e.state=\'committed\'').all(key);
    if(rows.length===1 && rows[0].identity && equalBytes(rows[0].identity,bytes)) {
      for(const row of this.#db.prepare('SELECT source FROM raw_sources WHERE version_id=?').iterate(rows[0].id)) {
        if(equalBytes(row.source,src)){this.#lease.assertWritable();return Object.freeze({eventKey:key,versionId:rows[0].id,classification:'committed',durability:'observed',reused:true});}
      }
    }
    return this.ingest(input);
  }
  // Stores one observed string, not an object graph or an identity proof.
  recordHostText(input) {
    this.#lease.assertWritable();
    if (!input || typeof input !== 'object' || utilTypes.isProxy(input)) throw Error('raw-invalid-host-text');
    const field = name => {
      const d = Object.getOwnPropertyDescriptor(input, name);
      if (!d || !Object.hasOwn(d, 'value')) throw Error('raw-invalid-host-text');
      return d.value;
    };
    const fullSessionId=field('fullSessionId'), source=observationSnapshot(field('source'), true);
    const readId=field('readId'), slot=field('slot'), startSeq=field('startSeq'), endSeq=field('endSeq');
    const text=field('text'), unknown=field('unknown');
    if (typeof fullSessionId !== 'string' || !fullSessionId || typeof readId !== 'string' || !readId || readId.length > 4096 ||
        !Number.isSafeInteger(slot) || slot < 0 || !Number.isSafeInteger(startSeq) || startSeq < 0 ||
        !Number.isSafeInteger(endSeq) || endSeq <= startSeq || typeof text !== 'string' || text.length > 16777216 || typeof unknown !== 'boolean') throw Error('raw-invalid-host-text');
    const db=this.#db, namespace=this.#lease.namespace, session=sessionKey(fullSessionId), src=encodeIdentity(source), read=utf16le(readId), id=randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#lease.assertWritable();
      db.exec('CREATE TABLE IF NOT EXISTS raw_host_texts(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, session_id TEXT NOT NULL, source BLOB NOT NULL, read_id BLOB NOT NULL, slot INTEGER NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL, units INTEGER NOT NULL, unknown INTEGER NOT NULL, UNIQUE(namespace,session_id,source,read_id,slot)); CREATE TABLE IF NOT EXISTS raw_host_text_chunks(text_id TEXT NOT NULL REFERENCES raw_host_texts(id), part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(text_id,part))');
      if (db.prepare('SELECT 1 FROM raw_host_texts WHERE namespace=? AND session_id=? AND source=? AND read_id=? AND slot=?').get(namespace,session,src,read,slot)) throw Error('raw-host-text-duplicate');
      db.prepare('INSERT INTO raw_host_texts VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,namespace,session,src,read,slot,startSeq,endSeq,text.length,Number(unknown));
      const insert=db.prepare('INSERT INTO raw_host_text_chunks VALUES(?,?,?)');
      for(let start=0,part=0; start<text.length || part===0; start+=RAW_CAPTURE_LIMITS.segmentUnits,part++) insert.run(id,part,utf16le(text.slice(start,start+RAW_CAPTURE_LIMITS.segmentUnits)));
      if (unknown) {
        db.exec('CREATE TABLE IF NOT EXISTS raw_host_pending(namespace TEXT NOT NULL, session_id TEXT NOT NULL, source BLOB NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(namespace,session_id,source))');
        db.prepare('INSERT INTO raw_host_pending VALUES(?,?,?,?) ON CONFLICT(namespace,session_id,source) DO UPDATE SET reason=excluded.reason').run(namespace,session,src,'untrusted-snapshot-retry');
        db.prepare('INSERT OR IGNORE INTO raw_watermarks(namespace,session_id) VALUES(?,?)').run(namespace,session);
        const mark=db.prepare('SELECT * FROM raw_watermarks WHERE namespace=? AND session_id=?').get(namespace,session);
        db.prepare('INSERT INTO raw_host_uncertainty VALUES(?,?,?,?,?) ON CONFLICT(namespace,session_id,source) DO UPDATE SET start_seq=min(start_seq,excluded.start_seq),end_seq=max(end_seq,excluded.end_seq)').run(namespace,session,src,startSeq,Math.max(endSeq,mark.raw_next));
        if(startSeq<mark.raw_next)db.prepare('INSERT INTO raw_invalidations VALUES(?,?,?,?,?,?)').run(randomUUID(),namespace,session,startSeq,mark.raw_next,'host-text-unknown');
        db.prepare('UPDATE raw_watermarks SET raw_next=min(raw_next,?),verified_next=min(verified_next,?),derived_next=min(derived_next,?) WHERE namespace=? AND session_id=?').run(startSeq,startSeq,startSeq,namespace,session);
      }
      this.#lease.assertWritable();
      db.exec('COMMIT');
      return Object.freeze({textId:id,classification:'text-observation',completeGraph:false,unknown});
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  // The observation is captured by the caller, not reconstructed from a live event.
  recordHostObservation(input) {
    this.#lease.assertWritable();
    if (!input || typeof input !== 'object' || utilTypes.isProxy(input)) throw Error('raw-invalid-observation');
    const field = name => {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor) return undefined;
      if (!Object.hasOwn(descriptor, 'value')) throw Error('raw-invalid-observation');
      return descriptor.value;
    };
    const fullSessionId=field('fullSessionId'), source=observationSnapshot(field('source'), true);
    const observation=observationSnapshot(field('observation'));
    const startSeq=field('startSeq') ?? 0, endSeq=field('endSeq') ?? 1, pending=field('pending') ?? false;
    const metadata = Object.create(null);
    for (const key of ['readId', 'phase', 'revision']) {
      const value = field(key);
      if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > 4096)) throw Error('raw-invalid-observation-scope');
      metadata[key] = value === undefined ? null : utf16le(value);
    }
    for (const key of ['offset', 'slot']) {
      const value = field(key);
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw Error('raw-invalid-observation-scope');
      metadata[key] = value === undefined ? null : value;
    }
    if (typeof pending !== 'boolean') throw Error('raw-invalid-observation');
    if (typeof fullSessionId !== 'string' || !fullSessionId || !Number.isSafeInteger(startSeq) || startSeq < 0 || !Number.isSafeInteger(endSeq) || endSeq <= startSeq) throw Error('raw-invalid-observation-scope');
    if (!observation || observation.format !== 'raw-observation-v2' || observation.identity !== false || observation.completeGraph !== false || typeof observation.observedPartial !== 'boolean' || typeof observation.hiddenSlotsUnverified !== 'boolean') throw Error('raw-invalid-observation');
    const db=this.#db, namespace=this.#lease.namespace, session=sessionKey(fullSessionId), src=encodeIdentity(source);
    const payload=utf16le(JSON.stringify(observation)), id=randomUUID();
    db.exec('BEGIN IMMEDIATE');
    let receipt;
    try {
      db.exec('CREATE TABLE IF NOT EXISTS raw_host_samples(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, session_id TEXT NOT NULL, source BLOB NOT NULL, observation BLOB NOT NULL, observed_partial INTEGER NOT NULL, hidden_slots_unverified INTEGER NOT NULL)');
      const columns = new Set(db.prepare('PRAGMA table_info(raw_host_samples)').all().map(column => column.name));
      for (const [name, type] of [['start_seq','INTEGER'], ['end_seq','INTEGER'], ['read_id','BLOB'], ['phase','BLOB'], ['read_offset','INTEGER'], ['revision','BLOB'], ['slot','INTEGER']]) {
        if (!columns.has(name)) db.exec(`ALTER TABLE raw_host_samples ADD COLUMN ${name} ${type}`);
      }
      db.prepare('INSERT INTO raw_host_samples(id,namespace,session_id,source,observation,observed_partial,hidden_slots_unverified,start_seq,end_seq,read_id,phase,read_offset,revision,slot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,namespace,session,src,payload,Number(observation.observedPartial),Number(observation.hiddenSlotsUnverified),startSeq,endSeq,metadata.readId,metadata.phase,metadata.offset,metadata.revision,metadata.slot);
      if (pending) {
        db.exec('CREATE TABLE IF NOT EXISTS raw_host_pending(namespace TEXT NOT NULL, session_id TEXT NOT NULL, source BLOB NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(namespace,session_id,source))');
        db.prepare('INSERT INTO raw_host_pending VALUES(?,?,?,?) ON CONFLICT(namespace,session_id,source) DO UPDATE SET reason=excluded.reason').run(namespace,session,src,'untrusted-snapshot-retry');
      }
      db.prepare('INSERT OR IGNORE INTO raw_watermarks(namespace,session_id) VALUES(?,?)').run(namespace,session);
      const mark=db.prepare('SELECT * FROM raw_watermarks WHERE namespace=? AND session_id=?').get(namespace,session);
      db.prepare('INSERT INTO raw_host_uncertainty VALUES(?,?,?,?,?) ON CONFLICT(namespace,session_id,source) DO UPDATE SET start_seq=min(start_seq,excluded.start_seq),end_seq=max(end_seq,excluded.end_seq)').run(namespace,session,src,startSeq,Math.max(endSeq,mark.raw_next));
      if(startSeq<mark.raw_next)db.prepare('INSERT INTO raw_invalidations VALUES(?,?,?,?,?,?)').run(randomUUID(),namespace,session,startSeq,mark.raw_next,'host-observation-unknown');
      db.prepare('UPDATE raw_watermarks SET raw_next=min(raw_next,?),verified_next=min(verified_next,?),derived_next=min(derived_next,?) WHERE namespace=? AND session_id=?').run(startSeq,startSeq,startSeq,namespace,session);
      receipt=Object.freeze({observationId:id,classification:'observation',durability:'observed',rawCommittedNextSeq:Math.min(mark.raw_next,startSeq),observedPartial:observation.observedPartial,hiddenSlotsUnverified:observation.hiddenSlotsUnverified});
      this.#lease.assertWritable();
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
    return receipt;
  }
  markHostUncertain({fullSessionId, provenance, startSeq, endSeq}) {
    this.#lease.assertWritable();
    if(!Number.isSafeInteger(startSeq)||startSeq<0||!Number.isSafeInteger(endSeq)||endSeq<=startSeq)throw Error('raw-invalid-uncertainty');
    const db=this.#db, namespace=this.#lease.namespace, session=sessionKey(fullSessionId), source=encodeIdentity(provenance);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO raw_watermarks(namespace,session_id) VALUES(?,?)').run(namespace,session);
      const mark=db.prepare('SELECT * FROM raw_watermarks WHERE namespace=? AND session_id=?').get(namespace,session);
      db.prepare('INSERT INTO raw_host_uncertainty VALUES(?,?,?,?,?) ON CONFLICT(namespace,session_id,source) DO UPDATE SET start_seq=min(start_seq,excluded.start_seq),end_seq=max(end_seq,excluded.end_seq)').run(namespace,session,source,startSeq,Math.max(endSeq,mark.raw_next));
      if(startSeq<mark.raw_next)db.prepare('INSERT INTO raw_invalidations VALUES(?,?,?,?,?,?)').run(randomUUID(),namespace,session,startSeq,mark.raw_next,'host-identity-unknown');
      db.prepare('UPDATE raw_watermarks SET raw_next=min(raw_next,?),verified_next=min(verified_next,?),derived_next=min(derived_next,?) WHERE namespace=? AND session_id=?').run(startSeq,startSeq,startSeq,namespace,session);
      this.#lease.assertWritable();db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  clearHostUncertain({fullSessionId, provenance, events}) {
    this.#lease.assertWritable();
    const db=this.#db,namespace=this.#lease.namespace,session=sessionKey(fullSessionId),source=encodeIdentity(provenance);
    db.exec('BEGIN IMMEDIATE');
    try {
      const retryTable=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='raw_host_pending'").get();
      const retry=retryTable && db.prepare('SELECT 1 FROM raw_host_pending WHERE namespace=? AND session_id=? AND source=?').get(namespace,session,source);
      const pending=db.prepare('SELECT * FROM raw_host_uncertainty WHERE namespace=? AND session_id=? AND source=?').get(namespace,session,source);
      if(!retry && pending && events.length>=pending.end_seq) {
        let valid=true;
        for(let i=0;i<events.length;i++) {
          let bytes;try{bytes=encodeIdentity(events[i]);}catch{valid=false;break;}
          const rows=db.prepare("SELECT v.id,v.identity FROM raw_versions v JOIN raw_events e ON e.event_key=v.event_key WHERE e.event_key=? AND e.state='committed'").all(eventKey(namespace,fullSessionId,i));
          if(rows.length!==1||!rows[0].identity||!equalBytes(rows[0].identity,bytes)){valid=false;break;}
          const sources=db.prepare('SELECT source FROM raw_sources WHERE version_id=?').all(rows[0].id);
          if(!sources.some(row=>equalBytes(row.source,source))){valid=false;break;}
        }
        if(valid)db.prepare('DELETE FROM raw_host_uncertainty WHERE namespace=? AND session_id=? AND source=?').run(namespace,session,source);
      }
      const mark=db.prepare('SELECT * FROM raw_watermarks WHERE namespace=? AND session_id=?').get(namespace,session);
      if(mark){
        const unknown=db.prepare('SELECT min(start_seq) n FROM raw_host_uncertainty WHERE namespace=? AND session_id=?').get(namespace,session).n;
        const limit=Math.min(mark.integrity_cap ?? Number.MAX_SAFE_INTEGER,unknown ?? Number.MAX_SAFE_INTEGER);let next=Math.min(mark.raw_next,limit);
        while(next<limit){const row=db.prepare('SELECT state FROM raw_events WHERE event_key=?').get(eventKey(namespace,fullSessionId,next));if(!row||row.state!=='committed')break;next++;}
        db.prepare('UPDATE raw_watermarks SET raw_next=?,verified_next=min(verified_next,?),derived_next=min(derived_next,?) WHERE namespace=? AND session_id=?').run(next,next,next,namespace,session);
      }
      this.#lease.assertWritable();db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  recordHostDirty({fullSessionId, nextSeq, reason}) {
    this.#lease.assertWritable();
    const db=this.#db;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS raw_host_dirty(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, session_id TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER, reason TEXT NOT NULL)');
      const prior=db.prepare('SELECT id FROM raw_host_dirty WHERE namespace=? AND session_id=? AND reason=? LIMIT 1').get(this.#lease.namespace,sessionKey(fullSessionId),reason);
      if(!prior)db.prepare('INSERT INTO raw_host_dirty VALUES(?,?,?,?,?,?)').run(randomUUID(),this.#lease.namespace,sessionKey(fullSessionId),0,Number.isSafeInteger(nextSeq)?nextSeq:null,reason);
      this.#lease.assertWritable();db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  // Archive-only extension: existing core databases keep their schema/version.
  // No tables are added unless the host adapter explicitly uses this path.
  recordHostPrefix({ fullSessionId, events, provenance }) {
    this.#lease.assertWritable();
    if (!Array.isArray(events) || !events.length || events.some((e,i) => {
      try { const d=Object.getOwnPropertyDescriptor(e,'seq'); return !d || !Object.hasOwn(d, 'value') || d.value !== i; }
      catch { return true; }
    })) throw Error('raw-noncontiguous-host-prefix');
    const db=this.#db, namespace=this.#lease.namespace, session=sessionKey(fullSessionId);
    const source=encodeIdentity(provenance);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS raw_host_observations(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, session_id TEXT NOT NULL, process TEXT NOT NULL, next_seq INTEGER NOT NULL, provenance BLOB NOT NULL, snapshot BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS raw_replay_checkpoints(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, session_id TEXT NOT NULL, process TEXT NOT NULL, prior_observation TEXT NOT NULL REFERENCES raw_host_observations, next_seq INTEGER NOT NULL, provenance BLOB NOT NULL, proof BLOB NOT NULL, level TEXT NOT NULL CHECK(level='replayed'));`);
      const mark=db.prepare('SELECT * FROM raw_watermarks WHERE namespace=? AND session_id=?').get(namespace,session);
      if (!mark) throw Error('raw-prefix-not-committed');
      const cap=Math.min(events.length,mark.raw_next,mark.integrity_cap ?? Number.MAX_SAFE_INTEGER);
      db.exec(`CREATE TABLE IF NOT EXISTS raw_host_event_proofs(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, version_id TEXT NOT NULL REFERENCES raw_versions, provenance BLOB NOT NULL, process TEXT NOT NULL, observation TEXT NOT NULL REFERENCES raw_host_observations);
        CREATE TABLE IF NOT EXISTS raw_checkpoint_events(checkpoint TEXT NOT NULL REFERENCES raw_replay_checkpoints, seq INTEGER NOT NULL, proof_id TEXT NOT NULL REFERENCES raw_host_event_proofs, PRIMARY KEY(checkpoint,seq));`);
      let verified=0,priorId=null,observation=null;
      const candidates=[];
      for(let i=0;i<cap;i++) {
        const bytes=encodeIdentity(events[i]);
        const rows=db.prepare('SELECT v.* FROM raw_versions v JOIN raw_events e ON e.event_key=v.event_key WHERE e.event_key=? AND e.state=\'committed\'').all(eventKey(namespace,fullSessionId,i));
        if(rows.length!==1 || !equalBytes(rows[0].identity,bytes)) throw Error('raw-replay-byte-mismatch');
        let proof;
        for(const row of db.prepare('SELECT * FROM raw_host_event_proofs WHERE namespace=? AND session_id=? AND seq=? AND version_id=?').iterate(namespace,session,i,rows[0].id)) {
          if(equalBytes(row.provenance,source)){proof=row;break;}
        }
        if(!proof){
          if(!observation){
            observation=randomUUID();
            db.prepare('INSERT INTO raw_host_observations VALUES(?,?,?,?,?,?,?)').run(observation,namespace,session,hostProcess,cap,source,snapshotBytes({format:'event-proofs-v1'}));
          }
          proof={id:randomUUID(),process:hostProcess,observation};
          db.prepare('INSERT INTO raw_host_event_proofs VALUES(?,?,?,?,?,?,?,?)').run(proof.id,namespace,session,i,rows[0].id,source,hostProcess,observation);
        }
        // A prior process observed these exact immutable version bytes from this source.
        if(i===verified && proof.process!==hostProcess){verified++;priorId=proof.observation;candidates.push(proof.id);}
      }
      let checkpoint=null;
      if(priorId && verified>0) {
        const prior=db.prepare('SELECT * FROM raw_replay_checkpoints WHERE namespace=? AND session_id=? AND next_seq>=? ORDER BY next_seq DESC').iterate(namespace,session,verified);
        for(const row of prior)if(equalBytes(row.provenance,source)){checkpoint=row.id;break;}
        if(!checkpoint){
          checkpoint=randomUUID();
          db.prepare('INSERT INTO raw_replay_checkpoints VALUES(?,?,?,?,?,?,?,?,?)').run(checkpoint,namespace,session,hostProcess,priorId,verified,source,encodeIdentity({format:'event-proofs-v1',count:verified}),'replayed');
          for(let i=0;i<verified;i++)db.prepare('INSERT INTO raw_checkpoint_events VALUES(?,?,?)').run(checkpoint,i,candidates[i]);
        }
        if(mark.verified_next<verified)db.prepare('UPDATE raw_watermarks SET verified_next=min(raw_next,coalesce(integrity_cap,raw_next),max(verified_next,?)) WHERE namespace=? AND session_id=?').run(verified,namespace,session);
      }
      this.#lease.assertWritable(); db.exec('COMMIT');
      return Object.freeze({observedNext:events.length,replayedNext:verified,checkpoint,flushReturned:null});
    } catch(e) {db.exec('ROLLBACK');throw e;}
  }
  #metadata(value,kind) {
    try { return encodeIdentity(value); }
    catch { return encodeIdentity({classification:'unsupported-metadata',capture:capture(this.#db,value,kind)}); }
  }
}
