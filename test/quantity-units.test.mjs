// 缺陷 2 回归：数值单位白名单补齐中文小说常用量纲（尺/寸/步/里），
// 且多字单位不被尾字单位拆错（厘米/公里/海里 不能被 米/里 抢走前半截）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractQuantities } from '../src/judge.mjs';

const pairs = (text) => extractQuantities(text).map((q) => `${q.num}|${q.unit}`);

test('尺/寸/步/里 能被抽出且数值与单位配对正确', () => {
  assert.deepEqual(pairs('木桩高一尺。'), ['一|尺']);
  assert.deepEqual(pairs('铁钉长五寸。'), ['五|寸']);
  assert.deepEqual(pairs('渠堤相距二百步。'), ['二百|步']);
  assert.deepEqual(pairs('堤岸长三里。'), ['三|里']);
  assert.deepEqual(pairs('堤岸长三里，铁钉长五寸，渠堤相距二百步，木桩高一尺。'), ['三|里', '五|寸', '二百|步', '一|尺']);
});

test('多字单位不被尾字单位拆错', () => {
  assert.deepEqual(pairs('渠宽三十五公里。'), ['三十五|公里']);
  assert.deepEqual(pairs('航程一百八十七海里。'), ['一百八十七|海里']);
  assert.deepEqual(pairs('深度十一厘米。'), ['十一|厘米']);
  assert.deepEqual(pairs('厚度三毫米。'), ['三|毫米']);
  // 同句混排：公里/海里 各自完整，米 不被前半截吃掉。
  assert.deepEqual(pairs('渠宽三十五公里，航程一百八十七海里，深十一厘米，厚三毫米，桩高一尺。'),
    ['三十五|公里', '一百八十七|海里', '十一|厘米', '三|毫米', '一|尺']);
});

test('单位词出现在非计量语境时不产生数量', () => {
  // 「尺寸」没有数值前缀，本来就不是数量。
  assert.deepEqual(pairs('尺寸不合。'), []);
  assert.deepEqual(pairs('按尺寸放样。'), []);
  // 「里」只在数值后成立，孤立的方位词不命中。
  assert.deepEqual(pairs('往里走去。'), []);
});
