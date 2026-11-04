import { adaptContentSnapshot } from './content-snapshot-adapter.mjs';
import { index } from './search.mjs';

// Generation is owned by the caller and must advance on every local content change.
export function createContentSnapshotView(store, generation, options = {}) {
  if (typeof generation !== 'function') throw new TypeError('generation must be a function');
  const db = store.raw();
  const local = generation();
  const snapshot = store.contentSnapshot(options.snapshot);
  const adapted = adaptContentSnapshot(snapshot);
  const ix = index(adapted.docs, options.search);
  const facts = [...snapshot.facts.byOrd.values()].flat().map(f => ({ ...f }));
  const fullText = adapted.memories.map(m => m.text).join('\n');
  const version = Object.freeze({ dataVersion: snapshot.dataVersion, generation: local });
  function assertCurrent() {
    if (db.isTransaction) throw new Error('snapshot view requires an idle connection');
    if (generation() !== version.generation || db.prepare('PRAGMA data_version').get().data_version !== version.dataVersion) {
      throw new Error('snapshot view stale');
    }
  }
  assertCurrent();
  return Object.freeze({
    version, assertCurrent,
    search: (query, opts) => ix.search(query, opts),
    fullText: () => fullText,
    allFacts: () => facts.map(f => ({ ...f })),
    factsSlot: adapted.factsSlot,
  });
}
