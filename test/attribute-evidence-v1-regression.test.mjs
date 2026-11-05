import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAttributeEvidenceV1 as analyze } from '../src/attribute-evidence-v1.mjs';

const q = 'bm25的颜色是什么';
const hit = (text, extra = {}) => ({ text, ...extra });

test('analysis does not expose hits through a patched array entries method', () => {
  const hits = [hit('BM25的颜色是红色。'), hit('BM25的颜色是蓝色。')];
  const expected = analyze(q, hits);
  const originalEntries = Array.prototype.entries;
  let observedHits = false;
  let actual;
  try {
    Array.prototype.entries = function (...args) {
      if (this === hits) observedHits = true;
      return originalEntries.apply(this, args);
    };
    actual = analyze(q, hits);
  } finally {
    Array.prototype.entries = originalEntries;
  }
  assert.equal(observedHits, false);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.candidates.map(candidate => candidate.hit.index), [0, 1]);
});

test('mapped whitespace and fullwidth stops preserve true boundaries and UTF-16 slices', () => {
  for (const prefix of ['😀前文。 ', '😀前文。\n  ', '😀前文．\t ', '  ']) {
    const text = 'BM25的颜色是红色．BM25的颜色是蓝色。';
    const originalText = prefix + text + '尾部。';
    const windowStart = prefix.length;
    const r = analyze(q, [hit(text, { originalText, windowStart, windowEnd: windowStart + text.length, startsAtBoundary: true, truncated: true })]);
    assert.deepEqual(r.candidates.map(c => c.rawValue), ['红色', '蓝色'], prefix);
    assert.equal(r.contextIncomplete, true);
    assert.equal(r.semanticUncertain, false);
    assert.equal(r.hasConflict, true);
    for (const c of r.candidates) {
      assert.equal(text.slice(...c.sentenceSpan), c.sentence);
      assert.equal(text.slice(...c.valueSpan), c.rawValue);
      assert.equal(originalText.slice(...c.originalSentenceSpan), c.sentence);
      assert.equal(originalText.slice(...c.originalValueSpan), c.rawValue);
    }
  }
});

test('mapped whitespace after non-boundary and contradictory metadata remain conservative', () => {
  const text = 'BM25的颜色是红色。BM25的颜色是蓝色。';
  for (const [prefix, startsAtBoundary] of [['😀前缀  ', undefined], ['😀前缀  ', true], ['😀前文．  ', false]]) {
    const originalText = prefix + text;
    const windowStart = prefix.length;
    const r = analyze(q, [hit(text, { originalText, windowStart, windowEnd: originalText.length, startsAtBoundary })]);
    assert.deepEqual(r.candidates.map(c => c.rawValue), ['蓝色'], prefix);
    assert.equal(r.contextIncomplete, true);
    assert.equal(r.semanticUncertain, true);
  }
});

test('fullwidth full stop separates and terminates unmapped sentences', () => {
  const r = analyze(q, [hit('😀前文．BM25的颜色是红色．BM25的颜色是蓝色。')]);
  assert.deepEqual(r.candidates.map(c => c.rawValue), ['红色', '蓝色']);
  assert.equal(r.status, 'ambiguous');
});

test('mapped sentence boundaries retain first literal candidate with UTF-16 spans', () => {
  for (const delimiter of ['。', '！', '？', '!', '?', '；', ';', '\n', '.']) {
    for (const metadata of [{}, { truncated: true }]) {
      const originalText = `😀前文${delimiter}BM25的颜色是红色。BM25的颜色是蓝色。尾部。`;
      const windowStart = originalText.indexOf('BM25');
      const text = 'BM25的颜色是红色。BM25的颜色是蓝色。';
      const r = analyze(q, [hit(text, { originalText, windowStart, windowEnd: windowStart + text.length, ...metadata })]);
      assert.deepEqual(r.candidates.map(c => c.rawValue), ['红色', '蓝色'], delimiter);
      assert.equal(r.contextIncomplete, true);
      assert.equal(r.semanticUncertain, false);
      assert.equal(r.hasConflict, true);
      assert.equal(r.status, 'uncertain');
      for (const c of r.candidates) {
        assert.equal(originalText.slice(...c.originalSentenceSpan), c.sentence);
        assert.equal(originalText.slice(...c.originalValueSpan), c.rawValue);
      }
    }
  }
});

test('mapped non-boundary and contradictory false exclude only the first sentence', () => {
  for (const [prefix, startsAtBoundary, uncertain] of [['😀前缀', undefined, true], ['😀前文。', false, true]]) {
    const text = 'BM25的颜色是红色。BM25的颜色是蓝色。';
    const originalText = prefix + text + '尾部。';
    const windowStart = prefix.length;
    const r = analyze(q, [hit(text, { originalText, windowStart, windowEnd: windowStart + text.length, startsAtBoundary })]);
    assert.deepEqual(r.candidates.map(c => c.rawValue), ['蓝色']);
    assert.equal(r.contextIncomplete, true);
    assert.equal(r.semanticUncertain, uncertain);
    assert.equal(r.status, 'uncertain');
  }
});

test('known cross sentence correction clues downgrade literal candidates', () => {
  for (const clue of ['这句话是错的。', '实际上是蓝色。', 'It is false.']) {
    const r = analyze(q, [hit(`BM25的颜色是红色。${clue}`)]);
    assert.equal(r.semanticUncertain, true, clue);
    assert.equal(r.status, 'uncertain', clue);
  }
});

test('conflict, semantic uncertainty and incomplete context remain independently visible', () => {
  const r = analyze(q, [hit('BM25的颜色是红色。'), hit('BM25的颜色是蓝色。'), hit('这句话是错的。', { truncated: true })]);
  assert.equal(r.hasConflict, true);
  assert.equal(r.semanticUncertain, true);
  assert.equal(r.contextIncomplete, true);
  assert.equal(r.status, 'uncertain');
});

test('null text still carries truncation', () => {
  const r = analyze(q, [hit(null, { truncated: true })]);
  assert.equal(r.contextIncomplete, true);
  assert.equal(r.semanticUncertain, true);
});

test('valid subwindow proves incompleteness despite contradictory metadata', () => {
  const originalText = '前文。BM25的颜色是红色。后文。';
  const text = 'BM25的颜色是红色。';
  const windowStart = originalText.indexOf(text);
  const r = analyze(q, [hit(text, { originalText, windowStart, windowEnd: windowStart + text.length, truncated: false, startsAtBoundary: true })]);
  assert.equal(r.contextIncomplete, true);
  assert.equal(r.semanticUncertain, true);
  assert.equal(r.status, 'uncertain');
});

test('invalid supplied mapping is incomplete and uncertain', () => {
  const r = analyze(q, [hit('BM25的颜色是红色。', { originalText: '不同原文', windowStart: 0, windowEnd: 10 })]);
  assert.equal(r.contextIncomplete, true);
  assert.equal(r.semanticUncertain, true);
});

test('contradictory full window and claimed boundary are uncertain', () => {
  const text = 'BM25的颜色是红色。';
  const full = analyze(q, [hit(text, { originalText: text, windowStart: 0, windowEnd: text.length, truncated: true, startsAtBoundary: true })]);
  assert.equal(full.semanticUncertain, true);
  const originalText = `前缀${text}`;
  const partial = analyze(q, [hit(text, { originalText, windowStart: 2, windowEnd: originalText.length, startsAtBoundary: true })]);
  assert.equal(partial.semanticUncertain, true);
  assert.equal(partial.candidates.length, 0);
});

test('unrelated standalone history does not globally contaminate candidates', () => {
  const r = analyze(q, [hit('BM25的颜色是红色。'), hit('以前天气晴朗。')]);
  assert.equal(r.semanticUncertain, false);
  assert.equal(r.status, 'candidates');
});

test('explicit non-boundary independently excludes first sentence', () => {
  for (const extra of [{ startsAtBoundary: false }, { startsAtBoundary: false, truncated: false }]) {
    const r = analyze(q, [hit('BM25的颜色是红色。BM25的颜色是蓝色。', extra)]);
    assert.equal(r.contextIncomplete, true);
    assert.equal(r.semanticUncertain, true);
    assert.equal(r.status, 'uncertain');
    assert.deepEqual(r.candidates.map(c => c.rawValue), ['蓝色']);
  }
});

test('non-boundary contradicting valid full-source mapping is semantically uncertain', () => {
  for (const originalText of ['', 'BM25的颜色是红色。', '前文。BM25的颜色是红色。']) {
    const windowStart = originalText.startsWith('前文。') ? 3 : 0;
    const text = originalText.slice(windowStart);
    const r = analyze(q, [hit(text, { originalText, windowStart, windowEnd: originalText.length, startsAtBoundary: false })]);
    assert.equal(r.contextIncomplete, true);
    assert.equal(r.semanticUncertain, true);
    assert.equal(r.candidates.length, 0);
  }
});

test('non-boundary preserves independent conflict and distinguishes empty from null text', () => {
  const r = analyze(q, [hit('残句。BM25的颜色是红色。BM25的颜色是蓝色。', { startsAtBoundary: false })]);
  assert.equal(r.contextIncomplete, true);
  assert.equal(r.semanticUncertain, false);
  assert.equal(r.hasConflict, true);
  assert.equal(r.status, 'uncertain');
  const empty = analyze(q, [hit('', { startsAtBoundary: false })]);
  const missing = analyze(q, [hit(null, { startsAtBoundary: false })]);
  assert.equal(empty.contextIncomplete, true);
  assert.equal(empty.semanticUncertain, false);
  assert.equal(missing.contextIncomplete, true);
  assert.equal(missing.semanticUncertain, true);
});

test('line separators split sentences consistently and preserve mapped UTF-16 spans', () => {
  for (const delimiter of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const originalText = `😀前文${delimiter}  BM25的颜色是红色。${delimiter}BM25的颜色是蓝色。${delimiter}这句话是错的。`;
    const full = analyze(q, [hit(originalText)]);
    assert.deepEqual(full.candidates.map(c => c.rawValue), ['红色', '蓝色'], JSON.stringify(delimiter));
    assert.equal(full.hasConflict, true);
    assert.equal(full.semanticUncertain, true);
    const windowStart = originalText.indexOf('BM25');
    const text = originalText.slice(windowStart);
    const mapped = analyze(q, [hit(text, { originalText, windowStart, windowEnd: originalText.length, startsAtBoundary: true })]);
    assert.deepEqual(mapped.candidates.map(c => c.rawValue), ['红色', '蓝色'], JSON.stringify(delimiter));
    assert.equal(mapped.hasConflict, true);
    assert.equal(mapped.contextIncomplete, true);
    assert.equal(mapped.semanticUncertain, true);
    for (const c of mapped.candidates) {
      assert.equal(text.slice(...c.sentenceSpan), c.sentence);
      assert.equal(text.slice(...c.valueSpan), c.rawValue);
      assert.equal(originalText.slice(...c.originalSentenceSpan), c.sentence);
      assert.equal(originalText.slice(...c.originalValueSpan), c.rawValue);
    }
    const clean = originalText.slice(0, originalText.indexOf('这句话是错的。'));
    const cleanStart = clean.indexOf('BM25');
    const cleanResult = analyze(q, [hit(clean.slice(cleanStart), { originalText: clean, windowStart: cleanStart, windowEnd: clean.length, startsAtBoundary: true })]);
    assert.equal(cleanResult.semanticUncertain, false, JSON.stringify(delimiter));
    assert.equal(cleanResult.hasConflict, true);
    assert.equal(cleanResult.status, 'uncertain');
  }
});
