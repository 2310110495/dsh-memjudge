import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAttributeEvidenceV1 as analyze } from '../src/attribute-evidence-v1.mjs';

const q = 'bm25的颜色是什么';
const hit = (text, extra = {}) => ({ text, ...extra });

test('fullwidth, emoji and UTF-16 original and window spans recover exact slices', () => {
  const originalText = '😀前言。ＢＭ２５的颜色是红色。结尾。';
  const windowStart = originalText.indexOf('Ｂ');
  const text = originalText.slice(windowStart);
  const result = analyze(q, [hit(text, { id: 'h1', version: 2, truncated: true, startsAtBoundary: true, windowStart, windowEnd: originalText.length, originalText })]);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.contextIncomplete, true);
  const c = result.candidates[0];
  assert.equal(c.rawValue, '红色');
  assert.equal(c.normalizedValue, '红色');
  assert.deepEqual(c.hit, { id: 'h1', version: 2, index: 0 });
  assert.equal(text.slice(...c.sentenceSpan), c.sentence);
  assert.equal(text.slice(...c.valueSpan), c.rawValue);
  assert.equal(originalText.slice(...c.originalSentenceSpan), c.sentence);
  assert.equal(originalText.slice(...c.originalValueSpan), c.rawValue);
});

test('metadata absence and invalid original mapping are explicit', () => {
  const [a] = analyze(q, [hit('BM25的颜色是红色。')]).candidates;
  assert.deepEqual(a.hit, { id: null, version: null, index: 0 });
  assert.equal(a.originalSentenceSpan, null);
  assert.equal(a.originalValueSpan, null);
  const [b] = analyze(q, [hit('BM25的颜色是红色。', { truncated: true, startsAtBoundary: true, windowStart: 3, windowEnd: 13, originalText: 'not matching' })]).candidates;
  assert.equal(b.originalValueSpan, null);
});

test('two different values are ambiguous independent of hit order', () => {
  const a = hit('BM25的颜色是红色。', { id: 'a' });
  const b = hit('BM25的颜色是蓝色。', { id: 'b' });
  for (const hits of [[a, b], [b, a]]) {
    const r = analyze(q, hits);
    assert.equal(r.status, 'ambiguous');
    assert.deepEqual(new Set(r.candidates.map(x => x.normalizedValue)), new Set(['红色', '蓝色']));
    assert.deepEqual(r.candidates.map(x => x.hit.id), hits.map(x => x.id));
  }
});

test('uncertain language, negation, correction and unknown semantics stay conservative across hits', () => {
  for (const text of ['BM25的颜色不是红色。', 'BM25的颜色是红色或者蓝色。', 'BM25的颜色是红色待确认。', 'BM25的颜色是神秘色。', '后来改为蓝色。', '这个说法是假的。']) {
    assert.equal(analyze(q, [hit('BM25的颜色是红色。'), hit(text)]).status, 'uncertain', text);
  }
});

test('fragments are never concatenated and truncated starts require a boundary', () => {
  assert.notEqual(analyze(q, [hit('BM25的颜色是'), hit('红色。')]).status, 'candidates');
  assert.notEqual(analyze(q, [hit('BM25的颜色是红色。', { truncated: true })]).status, 'candidates');
  assert.notEqual(analyze(q, [hit('BM25的颜色是红色')]).status, 'candidates');
  assert.equal(analyze(q, [hit('残句。BM25的颜色是蓝色。', { truncated: true, startsAtBoundary: false })]).candidates[0].rawValue, '蓝色');
});

test('unsupported query and english known values', () => {
  assert.equal(analyze('BM25是什么', [hit('BM25的颜色是红色。')]).status, 'unsupported');
  const r = analyze("what is bm25's color?", [hit("BM25's color is RED.")]);
  assert.equal(r.status, 'candidates');
  assert.equal(r.candidates[0].normalizedValue, 'red');
  assert.equal(r.supported, true);
});

test('cross-sentence and cross-hit negative hypothetical and historical context is uncertain', () => {
  for (const context of ['这不是真的。', '假设如此。', '这是过去的情况。', 'This is not true.', 'Suppose this is true.', 'Previously.']) {
    assert.equal(analyze(q, [hit(`BM25的颜色是红色。${context}`)]).status, 'uncertain', context);
    assert.equal(analyze(q, [hit('BM25的颜色是红色。'), hit(context)]).status, 'uncertain', context);
    assert.equal(analyze(q, [hit(context), hit('BM25的颜色是红色。')]).status, 'uncertain', context);
  }
});

test('any truncated context marks the result incomplete even at a boundary', () => {
  const r = analyze(q, [hit('BM25的颜色是红色。', { truncated: true, startsAtBoundary: true })]);
  assert.equal(r.status, 'uncertain');
  assert.equal(r.contextIncomplete, true);
  assert.equal(analyze(q, [hit('无关。')]).contextIncomplete, false);
  assert.equal(analyze(q, [hit('无关。', { truncated: true })]).contextIncomplete, true);
});

test('gray and grey normalize equally while preserving input source indices', () => {
  const r = analyze("what is bm25's color?", [null, hit("BM25's color is grey."), hit("BM25's color is gray.")]);
  assert.equal(r.status, 'uncertain');
  assert.deepEqual(r.candidates.map(c => c.normalizedValue), ['gray', 'gray']);
  assert.deepEqual(r.candidates.map(c => c.hit.index), [1, 2]);
  assert.equal(analyze("what is bm25's color?", [hit("BM25's color is grey."), hit("BM25's color is gray.")]).status, 'candidates');
});
