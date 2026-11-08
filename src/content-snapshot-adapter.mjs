import { normalizeKind, normalizeTier } from './store.mjs';

function chapterOf(memory) {
  let source = memory.source;
  if (typeof source === 'string' && source.startsWith('{')) {
    try { source = JSON.parse(source); } catch { source = null; }
  }
  const parsed = source && typeof source === 'object'
    ? { chapter: Number(source.chapter) || 0, para: Number(source.para) || 0 }
    : { chapter: 0, para: 0 };
  return parsed;
}

// This detached view does not include occurrence records.
export function adaptContentSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.rows) || !(snapshot.facts?.byOrd instanceof Map) || !(snapshot.facts?.slot instanceof Map)) {
    throw new TypeError('invalid content snapshot');
  }
  const reverse = new Map();
  for (const row of snapshot.rows) {
    if (!row.supersedes) continue;
    for (const id of JSON.parse(row.supersedes)) {
      if (!reverse.has(id)) reverse.set(id, []);
      reverse.get(id).push(row.id);
    }
  }
  const cloneFact = fact => ({ ...fact });
  const memories = snapshot.rows.map(row => ({
    id: row.id, text: row.text, createdAt: row.created_at,
    lastAccessed: row.last_accessed, accessCount: row.access_count,
    importance: row.importance,
    supersedes: row.supersedes ? JSON.parse(row.supersedes) : null,
    supersededBy: reverse.get(row.id) ?? null,
    source: row.source, kind: normalizeKind(row.kind), tier: normalizeTier(row.tier, row.kind),
    facts: (snapshot.facts.byOrd.get(row.ord) || []).map(cloneFact).sort((a, b) => a.at - b.at),
  }));
  const docs = memories.map(memory => ({
    id: memory.id, text: memory.text, source: chapterOf(memory), importance: memory.importance,
    accessCount: memory.accessCount, createdAt: memory.createdAt, lastAccessed: memory.lastAccessed,
    supersededBy: memory.supersededBy?.slice() ?? null,
  }));
  const slots = new Map([...snapshot.facts.slot].map(([key, entries]) => [key, entries.map(({ ord, fact }) => ({ ord, fact: cloneFact(fact) }))]));
  return {
    memories, docs, dataVersion: snapshot.dataVersion,
    factsSlot: attr => (slots.get(attr) || []).map(({ ord, fact }) => ({ ord, fact: cloneFact(fact) })),
  };
}
