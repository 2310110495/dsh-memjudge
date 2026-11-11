// assistant 长回复的结构化切段（T90）。
//
// 为什么必须切段而不是放宽 maxChars：
//   真实工作里助手的回复普遍 800–3000 字。旧的 A4 闸把 >1200 的整篇直接丢弃，
//   结果是最有价值的输出全被扔掉（实测 129 条库里只有 1 条 assistant 记忆）。
//   而把整篇塞进库里同样不对——一条 3000 字的记忆会把注入面挤死，检索也命中不到重点。
//   唯一正确的解法是**按语义切成多条独立记忆**：每条落在 200–1200，各自可检索、各自去重。
//
// 切点规则（顺序即优先级）：
//   1. ``` / ~~~ 围栏：围栏内整块丢弃（代码不是结论），围栏标记行本身也丢弃。
//   2. ATX 标题（#..######）与独立成行的加粗小标题（**…**）：作为小节边界，
//      不单独成段，而是原样前置到该小节每一段的首行——切段后仍能读出上下文。
//   3. 表格行（| … |）与分隔线（---）：成组丢弃（排版产物，检索读不懂）。
//   4. 空行：段落边界。
//   5. 其余连续行：一个段落 atom。
//
// 合并规则：
//   - 相邻 atom 同属一个小节（标题相同）且拼接后 ≤ maxChars → 合并。
//   - 单个 atom 超过 maxChars → 用 judge.mjs 的 splitSentences 按句贪心装箱。
//   - 单句本身超过 maxChars → 整句丢弃（绝不截断）。
//   - 装箱后或合并后仍 < minChars 的段 → 丢弃（Dropped 里留痕，供测试对账）。
//
// 设计性丢弃的内容（围栏、表格、超长单句、过短段）全部记进 dropped，并保证：
//   输入的非空行 ⊆ 段文本的行 ∪ dropped 的行（集合语义，标题行可重复出现）。
// 这条不变量是「切段不丢内容」的可验证形式。

import { splitSentences } from './judge.mjs';

const WS_RE = /\s+/g;
const FENCE_RE = /^[ \t]*(?:```|~~~)/;
const HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+\S/;
const BOLD_TITLE_RE = /^[ \t]{0,3}\*\*[^*\n]{2,60}\*\*[ \t]*:?[ \t]*$/;
const TABLE_ROW_RE = /^[ \t]*\|/;
const RULE_RE = /^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;

export const SEGMENT_DEFAULTS = Object.freeze({ minChars: 200, maxChars: 1200 });

/** 去空白后的有效长度。与 auto-capture-assistant.mjs 的 weight 同一把尺。 */
export function segmentWeight(text) {
  return String(text ?? '').replace(WS_RE, '').length;
}

/**
 * 把一条长回复按 Markdown 结构切成候选段。
 *
 * @param {string} text 已剔除 reasoning/tool-call 的助手正文
 * @param {{minChars?: number, maxChars?: number}} [options]
 * @returns {{segments: {text: string, index: number, weight: number, title: string}[],
 *            dropped: {reason: string, lines: string[], weight: number}[]}}
 */
export function planSegments(text, options = {}) {
  const cfg = options && typeof options === 'object' ? options : {};
  const minChars = Number.isFinite(Number(cfg.minChars)) && Number(cfg.minChars) > 0
    ? Number(cfg.minChars) : SEGMENT_DEFAULTS.minChars;
  const maxChars = Number.isFinite(Number(cfg.maxChars)) && Number(cfg.maxChars) >= minChars
    ? Number(cfg.maxChars) : Math.max(minChars, SEGMENT_DEFAULTS.maxChars);

  const empty = { segments: [], dropped: [] };
  try {
    const raw = typeof text === 'string' ? text : '';
    if (raw.trim() === '') return empty;

    const dropped = [];
    const atoms = scanAtoms(raw, dropped);
    const segments = [];

    // 累加器：同一小节内的相邻 atom 合并到 maxChars 以内。
    let cur = null; // {title, parts: string[]}
    const flushCur = () => {
      if (!cur) return;
      const body = cur.parts.join('\n');
      const w = segmentWeight(body);
      if (w < minChars) {
        dropped.push({ reason: 'too-short', lines: body.split('\n'), weight: w });
      } else {
        segments.push({ text: body, title: cur.title, weight: w });
      }
      cur = null;
    };

    for (const atom of atoms) {
      const rendered = renderAtom(atom);
      const w = segmentWeight(rendered);
      if (w > maxChars) {
        // 超长段落：先收口，再按句装箱。装箱产生的每一桶本身就是一个语义段。
        flushCur();
        for (const chunk of packBySentence(rendered, minChars, maxChars, dropped)) {
          const cw = segmentWeight(chunk);
          if (cw < minChars) {
            dropped.push({ reason: 'too-short', lines: chunk.split('\n'), weight: cw });
          } else {
            segments.push({ text: chunk, title: atom.title, weight: cw });
          }
        }
        continue;
      }
      if (cur && cur.title === atom.title) {
        const merged = [...cur.parts, rendered].join('\n');
        if (segmentWeight(merged) <= maxChars) {
          cur.parts.push(rendered);
          continue;
        }
      }
      flushCur();
      cur = { title: atom.title, parts: [rendered] };
    }
    flushCur();

    return {
      segments: segments.map((seg, i) => ({ ...seg, index: i + 1 })),
      dropped,
    };
  } catch {
    return empty;
  }
}

/** 扫行 → atom 列表。围栏与表格整块丢弃并留痕。 */
function scanAtoms(raw, dropped) {
  const atoms = [];
  let title = '';
  let para = [];
  let fence = null; // {lines: string[]}
  let table = null; // string[]

  const flushPara = () => {
    if (para.length === 0) return;
    atoms.push({ title, lines: para });
    para = [];
  };
  const flushTable = () => {
    if (!table) return;
    const lines = table;
    table = null;
    dropped.push({ reason: 'table', lines, weight: segmentWeight(lines.join('\n')) });
  };
  const flushAll = () => { flushPara(); flushTable(); };

  for (const line of String(raw ?? '').split('\n')) {
    if (FENCE_RE.test(line)) {
      flushAll();
      if (fence) {
        fence.lines.push(line);
        dropped.push({
          reason: 'code-fence',
          lines: fence.lines,
          weight: segmentWeight(fence.lines.join('\n')),
        });
        fence = null;
      } else {
        fence = { lines: [line] };
      }
      continue;
    }
    if (fence) { fence.lines.push(line); continue; }

    if (line.trim() === '') { flushAll(); continue; }

    if (RULE_RE.test(line)) {
      flushAll();
      dropped.push({ reason: 'rule', lines: [line], weight: segmentWeight(line) });
      continue;
    }

    if (TABLE_ROW_RE.test(line)) {
      flushPara();
      if (!table) table = [];
      table.push(line);
      continue;
    }
    flushTable();

    if (HEADING_RE.test(line) || BOLD_TITLE_RE.test(line)) {
      flushPara();
      title = line;
      continue;
    }

    para.push(line);
  }

  // 未闭合围栏：删到结尾（与 stripCodeFences 同口径），但留痕。
  if (fence) {
    dropped.push({ reason: 'code-fence-unclosed', lines: fence.lines, weight: segmentWeight(fence.lines.join('\n')) });
  }
  flushAll();
  return atoms;
}

/** 渲染一个 atom：标题行原样前置，保证切段后仍有上下文。 */
function renderAtom(atom) {
  const body = (atom.lines || []).join('\n');
  if (!atom.title) return body;
  return body ? `${atom.title}\n${body}` : atom.title;
}

/**
 * 按句贪心装箱。splitSentences 保留句末标点，拼接后与原文逐字一致（不丢字）。
 * 单句超 maxChars 整句丢弃 —— 截断会造出库里没有、原文也没有的半句话。
 */
function packBySentence(rendered, minChars, maxChars, dropped) {
  const chunks = [];
  let bucket = '';
  const flushBucket = () => {
    if (bucket.trim() !== '') chunks.push(bucket);
    bucket = '';
  };

  let sentences;
  try {
    sentences = splitSentences(rendered);
  } catch {
    sentences = [{ text: rendered }];
  }
  if (!Array.isArray(sentences) || sentences.length === 0) sentences = [{ text: rendered }];

  for (const sentence of sentences) {
    const piece = typeof sentence?.text === 'string' ? sentence.text : '';
    if (piece.trim() === '') continue;
    const pw = segmentWeight(piece);
    if (pw > maxChars) {
      flushBucket();
      dropped.push({ reason: 'oversize-sentence', lines: piece.split('\n'), weight: pw });
      continue;
    }
    const next = bucket === '' ? piece : `${bucket}${piece}`;
    if (segmentWeight(next) <= maxChars) {
      bucket = next;
      continue;
    }
    flushBucket();
    bucket = piece;
  }
  flushBucket();
  return chunks;
}
