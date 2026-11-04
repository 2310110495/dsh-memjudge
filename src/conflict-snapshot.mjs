import { DatabaseSync } from 'node:sqlite';

export const POSITION_QUERY = `SELECT rowid AS ord,
  coalesce(length(CAST(source AS BLOB)), 0) + coalesce(length(CAST(document_id AS BLOB)), 0)
  + coalesce(length(CAST(chapter AS BLOB)), 0) + coalesce(length(CAST(para AS BLOB)), 0) AS bytes
  FROM memory_occurrences INDEXED BY ux_memory_occurrences_position WHERE memory_id = ?
  ORDER BY source IS NULL, coalesce(source, ''), document_id IS NULL,
    coalesce(document_id, ''), chapter IS NULL, coalesce(chapter, 0), para IS NULL, coalesce(para, 0)`;

// Trusted internal seam: passing a connection is not a security boundary.
export function createFixedReader(db, limits) {
  const nextMemory = db.prepare(`SELECT rowid AS ord, length(CAST(id AS BLOB)) AS idBytes,
    length(CAST(text AS BLOB)) AS textBytes FROM memories WHERE (? IS NULL OR rowid > ?) ORDER BY rowid LIMIT 1`);
  const memory = db.prepare('SELECT id, text FROM memories WHERE rowid = ?');
  const nextPosition = db.prepare(POSITION_QUERY);
  const position = db.prepare('SELECT source, document_id, chapter, para FROM memory_occurrences WHERE rowid = ?');
  let cursor = null, records = 0, occurrences = 0, textBytes = 0, occurrenceBytes = 0;
  let ended = false, reason = null;
  function next() {
    if (ended) return { done: true, scanIncomplete: reason !== null, reason };
    const meta = nextMemory.get(cursor, cursor);
    if (!meta) { ended = true; return { done: true, scanIncomplete: false, reason: null }; }
    if (records >= limits.records) reason = 'records';
    else if (meta.idBytes > limits.identifierBytes) reason = 'identifierBytes';
    else if (meta.textBytes > limits.recordTextBytes) reason = 'recordTextBytes';
    else if (textBytes + meta.textBytes > limits.textBytes) reason = 'textBytes';
    if (reason) { ended = true; return { done: true, scanIncomplete: true, reason }; }
    const row = memory.get(meta.ord), positions = [];
    let currentBytes = 0;
    for (const pos of nextPosition.iterate(row.id)) {
      if (occurrences + positions.length >= limits.occurrences) reason = 'occurrences';
      else if (occurrenceBytes + currentBytes + pos.bytes > limits.occurrenceBytes) reason = 'occurrenceBytes';
      if (reason) { ended = true; return { done: true, scanIncomplete: true, reason }; }
      positions.push(position.get(pos.ord));
      currentBytes += pos.bytes;
    }
    cursor = meta.ord;
    records++; occurrences += positions.length; textBytes += meta.textBytes; occurrenceBytes += currentBytes;
    return { done: false, value: { ...row, occurrences: positions } };
  }
  return { next };
}

// Call close() in finally, including on completion, budget exhaustion or early
// abandonment. DELETE journal snapshots can block writers until released.
// A path reopened here is not proof of identity with an existing store handle.
export function openConflictSnapshot(file, options = {}) {
  if (typeof file !== 'string' || !file || file === ':memory:') throw new TypeError('file-backed database required');
  const limits = { records: 1000, occurrences: 5000, textBytes: 1048576,
    recordTextBytes: 65536, occurrenceBytes: 1048576, identifierBytes: 4096, ...options };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`invalid limit: ${key}`);
  }
  const db = new DatabaseSync(file, { readOnly: true });
  let closed = false, transactionStarted = false;
  try {
    db.exec('BEGIN DEFERRED');
    transactionStarted = true;
    db.prepare('SELECT rowid FROM memories ORDER BY rowid LIMIT 1').get();
    const reader = createFixedReader(db, limits);
    let closeFailed = false, closeFailure;
    function close() {
      if (closed) {
        if (closeFailed) throw closeFailure;
        return;
      }
      closed = true;
      const errors = [];
      try { db.exec('ROLLBACK'); } catch (error) { errors.push(error); }
      try { db.close(); } catch (error) { errors.push(error); }
      if (errors.length) {
        closeFailed = true;
        closeFailure = errors.length === 1 ? errors[0] :
          new AggregateError(errors, 'snapshot rollback and close failed', { cause: errors[0] });
        throw closeFailure;
      }
    }
    function next() {
      if (closed) throw new Error('snapshot closed');
      try {
        return reader.next();
      } catch (error) {
        try { close(); } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'snapshot read and cleanup failed', { cause: error });
        }
        throw error;
      }
    }
    return { next, close };
  } catch (error) {
    const errors = [error];
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch (cleanup) { errors.push(cleanup); }
    }
    try { db.close(); } catch (cleanup) { errors.push(cleanup); }
    if (errors.length > 1) throw new AggregateError(errors, 'snapshot initialization and cleanup failed', { cause: error });
    throw error;
  }
}
