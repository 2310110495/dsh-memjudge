// memjudge 的 mem-eval 适配器。
//
// 关键立场：本文件**不复刻检索逻辑**。它把插件真身（src/index.mjs 的 apply）挂到一个
// 最小的宿主壳上（tools / systemPrompt / effect 三个面，语义复刻
// @deepseek-ai/dsh-scope/lib/index.js:29 的 NamedEntries 重名抛错），
// 然后调用插件自己注册的 memjudge_remember / memjudge_recall 的 execute，
// 并用这两个工具自己声明的 output.render 渲染返回串。
//
// 也就是说：LLM 在评测里看到的字符串，与真装在 DSH 里看到的字符串走同一条代码路径。
//
// 写入粒度由 MEMJUDGE_GRANULARITY 控制：
//   chapter（默认）= 一章一条记忆，对应「用户整章倾倒」；与 t10/t13 的落库口径一致。
//   seg           = 按空行切段，一章 N 段，对应 t11 检索层的 294 段口径。
// 两种都跑、都留档，谁高谁低照实写进 COMPARE.md，不挑好看的报。

import path from 'node:path';
import fs from 'node:fs';

import { apply, SECTION_NAME } from '../src/index.mjs';
import { open as openStore } from '../src/store.mjs';

// 默认段级：评测语料是长文档，「一段一条事实」是 remember 工具的正常用法，也是
// 检索层 t11 的口径（294 段）。设 MEMJUDGE_GRANULARITY=chapter 可切到「一章一条」。
const GRANULARITY = process.env.MEMJUDGE_GRANULARITY === 'chapter' ? 'chapter' : 'seg';

/** 复刻宿主 NamedEntries：同层重名直接抛错，不静默覆盖。 */
class NamedEntries {
  constructor(kind) {
    this.kind = kind;
    this.map = new Map();
  }

  insert(name, value) {
    if (this.map.has(name)) {
      throw new Error(
        `${this.kind} "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`,
      );
    }
    this.map.set(name, value);
    return () => {
      this.map.delete(name);
    };
  }
}

/** 复刻宿主 tools.register / systemPrompt.section 的硬校验（dsh-tools/lib/index.js:2878）。 */
class MiniContext {
  constructor() {
    this.tools = new NamedEntries('tool');
    this.systemPrompt = new NamedEntries('prompt section');
    this._effects = [];
    this.tools.register = (definition) => {
      const output = definition?.output;
      if (!output || typeof output !== 'object' || typeof output.render !== 'function') {
        throw new TypeError(`tool "${definition.name}" must declare output { schema, render, presentationMeta? }`);
      }
      if (definition.name === 'run_code') {
        throw new Error('tool name "run_code" is reserved for the PTC mode presentation transport');
      }
      return this.tools.insert(definition.name, definition);
    };
    this.systemPrompt.section = (section) => {
      if (!Number.isFinite(section?.order)) {
        throw new TypeError(`prompt section "${section?.name}" order must be a finite number`);
      }
      return this.systemPrompt.insert(section.name, section);
    };
  }

  effect(fn) {
    const cleanup = fn();
    const entry = { cleanup, active: true };
    this._effects.push(entry);
    return () => {
      if (!entry.active) return;
      entry.active = false;
      if (typeof entry.cleanup === 'function') entry.cleanup();
    };
  }

  dispose() {
    for (const entry of this._effects.splice(0).reverse()) {
      if (!entry.active) continue;
      entry.active = false;
      if (typeof entry.cleanup === 'function') entry.cleanup();
    }
  }
}

const state = { ctx: null, dbPath: null, reader: null, writeFallback: [] };

const toolOf = (name) => {
  const t = state.ctx?.tools.map.get(name);
  if (!t) throw new Error(`memjudge ${name} 未注册`);
  return t;
};

/** 按空行切段。与 t11 检索层的 294 段一致（中位 98 字、max 267）。 */
function segments(chapter) {
  return String(chapter.text)
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default {
  meta: {
    name: 'memjudge',
    version: '0.1.0',
    repo: 'memjudge-plugin（自研）',
    kind: 'self-built',
    storage: 'node:sqlite 单文件（PRAGMA journal_mode=DELETE，无 WAL 残留）',
    index: 'CJK 二元组倒排 + BM25 + 章级聚合 + 段级装填',
    recall: '两阶段：段级 BM25 → 章级 top-2 → 章内按 2000 字符预算装填；命中即刷新 lastAccessed',
    inject: '默认关（0 字符）；本评测打开 autoInject 观测上限（索引不注全文）',
    writeGranularity: GRANULARITY === 'seg' ? '段级（一章 N 段）' : '章级（一章一条）',
    now: 'now 走全局 Date.now，--fake-clock 时随假时钟回填',
  },

  async open(dir) {
    state.writeFallback = [];
    // md_cg/灵枢那类「相对路径被判越界后静默不索引」的坑在这里同样成立：
    // sqlite 走 path.resolve，dbPath 必须是绝对路径。
    state.dbPath = path.resolve(dir, 'memjudge.db');
    fs.mkdirSync(path.dirname(state.dbPath), { recursive: true });

    const ctx = new MiniContext();
    // 与真装配置的差异只有一处：autoInject 打开。默认配置是关的（能力 8 的
    // 0 字符是优点），但只有打开才能量出「开启注入要花多少字符」这个上限。
    apply(ctx, { dbPath: state.dbPath, autoInject: true, injectBudget: 2000 });
    state.ctx = ctx;

    if (!ctx.tools.map.has('memjudge_remember') || !ctx.tools.map.has('memjudge_recall')) {
      throw new Error('memjudge 工具未注册成功');
    }
  },

  async write(chapters) {
    const remember = toolOf('memjudge_remember');
    for (const ch of chapters) {
      if (GRANULARITY === 'seg') {
        const segs = segments(ch);
        for (let i = 0; i < segs.length; i += 1) {
          await remember.execute({ text: segs[i], chapter: ch.n, para: i + 1 });
        }
      } else {
        await remember.execute({ text: String(ch.text), chapter: ch.n });
      }
      state.writeFallback.push(String(ch.text));
    }
  },

  async query(q) {
    const recall = toolOf('memjudge_recall');
    const args = { query: String(q) };
    // 诊断用：默认不传任何参数，走工具自己的默认（budget=2000、topChapters=2）。
    // 只有显式设了环境变量才覆盖，用来定位「跨章综合为什么拿不到」是选章数还是预算造成的。
    // 主结果（results/memjudge.json）永远是默认参数跑出来的。
    const topc = Number(process.env.MEMJUDGE_TOPC);
    const budget = Number(process.env.MEMJUDGE_BUDGET);
    if (Number.isFinite(topc) && topc > 0) args.topChapters = topc;
    if (Number.isFinite(budget) && budget > 0) args.budget = budget;
    const value = await recall.execute(args);
    // 用工具自己声明的 render：给 LLM 看的就是这段，不是 hit 对象。
    const blocks = recall.output.render(args, value);
    return blocks.map((b) => String(b?.text ?? '')).join('\n');
  },

  async inject() {
    const section = state.ctx.systemPrompt.map.get(SECTION_NAME);
    if (!section || typeof section.text !== 'function') return '';
    return String(section.text() ?? '');
  },

  /** 从库里真读回，不是拿 adapter 侧的写入缓存充数。 */
  async dump() {
    try {
      const reader = openStore(state.dbPath);
      const rows = reader.dump();
      reader.close();
      return rows.map((r) => r.text).join('\n\n');
    } catch {
      // 主连接持锁时退回缓存：dump 只用于 dumpChars 参考值，不参与任何评分。
      return state.writeFallback.join('\n\n');
    }
  },

  async close() {
    try {
      state.ctx?.dispose();
    } catch {
      // dispose 幂等
    }
    state.ctx = null;
  },
};
