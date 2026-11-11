// 轮级 assistant 文本累积器（T90 A10）。
//
// 为什么必须累积到「轮」再判：
//   实测宿主每发一条 assistant/message 就是**一个 step**，一次工具循环算一步。
//   一个真实回合（turn）有 50–100 步，每步正文平均 8.5 字，39/41 步不足 50 字。
//   任何「按消息」判长度的闸门都只会看到碎片，200 字下限必然全灭——
//   这才是「库里只有 1 条 assistant 记忆」的真因，不是监听器没挂上。
//   而一轮累积起来中位 2535 字（max 7912，23/25 轮 ≥200 字），正好落在
//   分段算法 200–1200 的设计区间。所以累积是前置条件，分段落库才是交付。
//
// 语义：
//   - key = sessionId + turn；同一步重复投递（流式重放、宿主重试）**覆盖**而非追加。
//   - push 后累积超过 flushAtChars → 立即软冲（返回可落库文本并清空 parts），
//     这样即便长时间不结束的轮次也不会把内存与延迟顶爆。
//   - turn/end 走 drain：取出全部并删除该轮状态（会话结束不会有第二轮同号）。
//   - 所有上限都是防御性的（maxTurns / maxCharsPerTurn），触发时丢最老的轮，
//     宁可少记一轮，也不要一个异常会话把进程内存吃满。

const DEFAULT_FLUSH_AT_CHARS = 2400;
const DEFAULT_MAX_TURNS = 64;
const DEFAULT_MAX_CHARS_PER_TURN = 24000;

const KEY_SEP = '\u0000';

function keyOf(sessionId, turn) {
  return `${sessionId}${KEY_SEP}${turn}`;
}

/**
 * @param {{flushAtChars?: number, maxTurns?: number, maxCharsPerTurn?: number}} [options]
 */
export function createTurnBuffer(options = {}) {
  const cfg = options && typeof options === 'object' ? options : {};
  const flushAtChars = Number.isFinite(Number(cfg.flushAtChars)) && Number(cfg.flushAtChars) > 0
    ? Math.trunc(Number(cfg.flushAtChars))
    : DEFAULT_FLUSH_AT_CHARS;
  const maxTurns = Number.isFinite(Number(cfg.maxTurns)) && Number(cfg.maxTurns) > 0
    ? Math.trunc(Number(cfg.maxTurns))
    : DEFAULT_MAX_TURNS;
  const maxCharsPerTurn = Number.isFinite(Number(cfg.maxCharsPerTurn)) && Number(cfg.maxCharsPerTurn) > 0
    ? Math.trunc(Number(cfg.maxCharsPerTurn))
    : DEFAULT_MAX_CHARS_PER_TURN;

  /** @type {Map<string, {sessionId: string, turn: number, steps: Map<number, string>, chars: number, lastStep: number}>} */
  const turns = new Map();

  const render = (entry) => {
    const steps = [...entry.steps.keys()].sort((a, b) => a - b);
    const parts = [];
    for (const step of steps) {
      const text = entry.steps.get(step);
      if (typeof text === 'string' && text.trim() !== '') parts.push(text);
    }
    return parts.join('\n');
  };

  const evictIfNeeded = () => {
    while (turns.size > maxTurns) {
      const oldest = turns.keys().next();
      if (oldest.done) return;
      turns.delete(oldest.value);
    }
  };

  return {
    /**
     * 记录一步正文。
     * @returns {{flush: {sessionId: string, turn: number, step: number, text: string}|null, reason: string}}
     */
    push(sessionId, turn, step, text) {
      const miss = { flush: null, reason: '' };
      try {
        if (typeof sessionId !== 'string' || sessionId.trim() === '') return { ...miss, reason: 'invalid-session' };
        if (!Number.isSafeInteger(turn) || turn < 0) return { ...miss, reason: 'invalid-turn' };
        if (!Number.isSafeInteger(step) || step < 0) return { ...miss, reason: 'invalid-step' };
        const body = typeof text === 'string' ? text : '';
        if (body.trim() === '') return { ...miss, reason: 'empty' };

        const key = keyOf(sessionId, turn);
        let entry = turns.get(key);
        if (!entry) {
          entry = { sessionId, turn, steps: new Map(), chars: 0, lastStep: step };
          turns.set(key, entry);
          evictIfNeeded();
        }

        // 同一步重复投递：覆盖，不累加（幂等的第一道保险）。
        const prev = entry.steps.get(step);
        if (typeof prev === 'string') entry.chars -= [...prev].length;
        entry.steps.set(step, body);
        entry.chars += [...body].length;
        entry.lastStep = Math.max(entry.lastStep, step);

        if (entry.chars >= maxCharsPerTurn) {
          // 极端轮次：达到硬上限就整体交出，避免无限增长。
          const textOut = render(entry);
          turns.delete(key);
          return { flush: { sessionId, turn, step: entry.lastStep, text: textOut }, reason: 'turn-cap' };
        }
        if (entry.chars >= flushAtChars) {
          const textOut = render(entry);
          entry.steps.clear();
          entry.chars = 0;
          return { flush: { sessionId, turn, step: entry.lastStep, text: textOut }, reason: 'threshold' };
        }
        return miss;
      } catch {
        return { flush: null, reason: 'error' };
      }
    },

    /**
     * 取出并删除某一轮的全部文本（turn/end 用）。
     * @returns {{sessionId: string, turn: number, step: number, text: string}|null}
     */
    drain(sessionId, turn) {
      try {
        if (typeof sessionId !== 'string' || sessionId.trim() === '') return null;
        if (!Number.isSafeInteger(turn) || turn < 0) return null;
        const key = keyOf(sessionId, turn);
        const entry = turns.get(key);
        if (!entry) return null;
        turns.delete(key);
        const text = render(entry);
        if (text.trim() === '') return null;
        return { sessionId, turn, step: entry.lastStep, text };
      } catch {
        return null;
      }
    },

    /** 清掉一个会话的全部轮（会话销毁时用）。 */
    forget(sessionId) {
      try {
        if (typeof sessionId !== 'string') return 0;
        const prefix = `${sessionId}${KEY_SEP}`;
        let removed = 0;
        for (const key of [...turns.keys()]) {
          if (key.startsWith(prefix)) { turns.delete(key); removed += 1; }
        }
        return removed;
      } catch {
        return 0;
      }
    },

    /** 只读快照，给测试与排障。 */
    peek(sessionId, turn) {
      const entry = turns.get(keyOf(sessionId, turn));
      if (!entry) return null;
      return { turn: entry.turn, step: entry.lastStep, chars: entry.chars, text: render(entry) };
    },

    get size() { return turns.size; },
    get flushAtChars() { return flushAtChars; },
    get maxCharsPerTurn() { return maxCharsPerTurn; },
  };
}
