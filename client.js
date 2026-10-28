/**
 * memjudge —— DeepSeek Harness 前端半侧（浏览器）
 *
 * 在「系统设置」左侧栏注册一个「记忆库」入口（与通用设置/模型/插件管理同级）。
 * 数据走 DSH 宿主 RPC：ctx.connection.rpc.call('/memjudge', <endpoint>)，
 * 对应 host 半侧 src/rpc.mjs 注册的通道。面板只读，删除仍在对话里走工具。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memjudge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    const { useState, useEffect, useCallback } = react;

    const CHANNEL = '/memjudge';

    // ---------------------------------------------------------------- 基础

    const C = {
      bg: '#0b0c0e', panel: '#131519', line: '#23272e', fg: '#e8e6e1',
      dim: '#8b8f96', ok: '#5fb87a', warn: '#d9a441', bad: '#c9615a',
      mono: "ui-monospace,'Cascadia Mono','SF Mono',Consolas,monospace",
      serif: "Georgia,'Songti SC',serif",
    };
    const h = react.createElement;

    function fmt(n) {
      return Number(n ?? 0).toLocaleString('zh-CN');
    }
    function kb(n) {
      return (Number(n ?? 0) / 1024).toFixed(1);
    }
    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ------------------------------------------------------------ 原子块

    function Card({ title, children, span }) {
      return h('div', { style: { background: C.panel, border: '1px solid ' + C.line, padding: '14px 16px', gridColumn: span || 'auto' } },
        h('div', { style: { color: C.dim, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' } }, title),
        children);
    }
    function Stat({ k, v, n, color }) {
      return h('div', { style: { background: C.panel, border: '1px solid ' + C.line, padding: '14px 16px' } },
        h('div', { style: { color: C.dim, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' } }, k),
        h('div', { style: { fontSize: 19, marginTop: 5, fontVariantNumeric: 'tabular-nums', color: color || C.fg } }, v),
        n ? h('div', { style: { color: C.dim, fontSize: 11, marginTop: 3 } }, n) : null);
    }
    function Bar({ used, limit }) {
      const pct = Math.min(100, (Number(used) / Number(limit)) * 100);
      const col = pct > 85 ? C.warn : C.ok;
      return h('div', { style: { height: 5, background: '#1c2026', marginTop: 10, overflow: 'hidden' } },
        h('div', { style: { height: '100%', width: pct.toFixed(1) + '%', background: col } }));
    }
    function FlagRow({ name, on, desc }) {
      return h('tr', {},
        h('td', { style: sCell }, name),
        h('td', { style: Object.assign({}, sCell, { color: on ? C.ok : C.dim }) }, on ? 'ON' : 'OFF'),
        h('td', { style: Object.assign({}, sCell, { color: C.dim }) }, desc));
    }

    const sCell = { padding: '7px 10px 7px 0', borderBottom: '1px solid #191c21', verticalAlign: 'top' };
    const sHead = { textAlign: 'left', color: C.dim, fontWeight: 400, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', padding: '6px 10px 6px 0', borderBottom: '1px solid ' + C.line };

    // ------------------------------------------------------------ 面板

    function MemjudgePanel({ rpc }) {
      const [status, setStatus] = useState(null);
      const [mems, setMems] = useState(null);
      const [conf, setConf] = useState(null);
      const [err, setErr] = useState(null);
      const [loading, setLoading] = useState(true);

      const load = useCallback(() => {
        setLoading(true); setErr(null);
        Promise.all([
          rpc('status', {}).then((r) => (r && r.ok ? r.value : null)),
          rpc('memories', { limit: 120 }).then((r) => (r && r.ok ? r.value : null)),
          rpc('conflicts', {}).then((r) => (r && r.ok ? r.value : null)),
        ]).then(([s, m, c]) => {
          setStatus(s); setMems(m); setConf(c);
          if (!s && !m && !c) setErr('宿主 RPC 未响应');
          setLoading(false);
        }).catch((e) => { setErr(String(e && e.message ? e.message : e)); setLoading(false); });
      }, [rpc]);

      useEffect(() => { load(); }, [load]);

      const cfg = status && status.config;
      const stats = status && status.stats;
      const driving = status && stats ? Object.assign({}, stats) : null;
      const pct = driving ? Math.min(100, (driving.bytes / driving.limitBytes) * 100) : 0;

      const flags = cfg ? cfg.flags : null;
      const abilityOK = driving && driving.withinLimit;

      return h('div', { style: { color: C.fg, fontFamily: C.mono, fontSize: 13, maxWidth: 980, lineHeight: 1.5, padding: '26px 4px 50px' } },
        // 头部
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' } },
          h('div', {},
            h('div', { style: { fontFamily: C.serif, fontSize: 24, letterSpacing: '.02em' } }, 'memjudge'),
            h('div', { style: { color: C.dim, fontSize: 11, marginTop: 3 } },
              '记忆库 · ' + (err ? esc(err) : loading ? '读取中…' : '已连接宿主 RPC')),
          ),
          h('button', {
            onClick: load, disabled: loading,
            style: {
              background: 'transparent', color: C.fg, border: '1px solid ' + C.line,
              padding: '6px 16px', cursor: loading ? 'default' : 'pointer', fontFamily: C.mono, fontSize: 12,
            },
          }, loading ? '刷新中…' : '↻ 刷新')),
        h('div', { style: { height: 1, background: C.line, margin: '18px 0 22px' } }),

        // 库体
        h('div', { style: { color: C.dim, fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', marginBottom: 10 } }, '库体'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14 } },
          h(Stat, { k: '记忆条目', v: driving ? fmt(driving.memories) : '—', n: driving ? fmt(driving.segments) + ' 段' : '' }),
          h(Stat, { k: '三元组', v: driving ? fmt(driving.facts) : '—', n: driving ? fmt(driving.attrCount) + ' 个属性' : '' }),
          h(Stat, { k: '正文字数', v: driving ? fmt(driving.textChars) : '—' }),
          h(Stat, {
            k: '占用', v: driving ? kb(driving.bytes) + 'KB' : '—',
            n: driving ? '上限 ' + kb(driving.limitBytes) + 'KB · 余 ' + kb(driving.limitBytes - driving.bytes) + 'KB' : '',
            color: abilityOK ? C.ok : C.bad,
          }),
        ),
        driving ? h(Bar, { used: driving.bytes, limit: driving.limitBytes }) : null,

        // 模块
        h('div', { style: { color: C.dim, fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', margin: '28px 0 10px' } }, '模块'),
        flags ? h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
          h('thead', {}, h('tr', {},
            h('th', { style: sHead }, '模块'), h('th', { style: sHead }, '状态'), h('th', { style: sHead }, '说明'))),
          h('tbody', {},
            h(FlagRow, { name: 'jieba 分词', on: flags.jieba, desc: '搜索引擎模式切词，替代 CJK 二元组' }),
            h(FlagRow, { name: '向量融合', on: flags.vector, desc: 'Qwen3-Embedding-8B 64 维 int8，BM25+RRF' }),
            h(FlagRow, { name: '精排 rerank', on: flags.rerank, desc: 'Qwen3-Reranker-8B（综合题实测零增量）' }),
            h(FlagRow, { name: '查询扩展', on: flags.expand, desc: 'LLM 拆子查询' }),
            h(FlagRow, { name: 'LLM 选段', on: flags.llmSelect, desc: '候选段交模型挑选' }),
            h(FlagRow, { name: 'LLM 提取', on: flags.llmExtract, desc: '离线重建 facts' }),
          ))
        : h('div', { style: { color: C.dim } }, '等待宿主数据…'),

        // 密钥
        h('div', { style: { color: C.dim, fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', margin: '28px 0 10px' } }, '模型与密钥'),
        cfg ? h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(180px,220px) 1fr', rowGap: 8, fontSize: 12 } },
          hKeyRow('密钥', cfg.hasKey,
            cfg.hasKey ? '已配置（' + esc(cfg.keySource) + '）' + (cfg.keyMasked ? ' · ' + esc(cfg.keyMasked) : '') : '未配置',
            cfg.hasKey ? C.ok : C.warn),
          hKeyRow('端点', null, esc(cfg.baseUrl)),
          hKeyRow('对话 / 提取', null, esc(cfg.chatModel)),
          hKeyRow('向量', null, esc(cfg.embedModel) + ' · ' + (cfg.dims || 64) + ' 维'),
          hKeyRow('精排', null, esc(cfg.rerankModel)),
          hKeyRow('密钥文件', null, '~/.dsh/memjudge/secrets.json'),
        ) : null,

        // 记忆
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '28px 0 10px' } },
          h('span', { style: { color: C.dim, fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase' } }, '记忆'),
          h('span', { style: { color: C.dim, fontSize: 11 } }, mems && mems.rows ? mems.rows.length + ' 条' : '')),
        mems && mems.rows && mems.rows.length
          ? h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
              h('thead', {}, h('tr', {},
                h('th', { style: sHead }, '章'), h('th', { style: sHead }, '重要'),
                h('th', { style: sHead }, '内容'))),
              h('tbody', {}, mems.rows.map((r) => h('tr', { key: r.id },
                h('td', { style: Object.assign({}, sCell, { color: C.dim, whiteSpace: 'nowrap' }), title: r.id }, esc(r.chapter || '—')),
                h('td', { style: Object.assign({}, sCell, { color: C.dim, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }) }, r.importance != null ? Number(r.importance).toFixed(2) : '—'),
                h('td', { style: sCell },
                  h('div', { style: { maxWidth: 560, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#c9ccd2' }, title: r.text },
                    esc(r.text))),
              ))))
          : h('div', { style: { color: C.dim, fontSize: 12, padding: '10px 0' } }, '库里还没有记忆。'),

        // 冲突
        h('div', { style: { color: C.dim, fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', margin: '28px 0 10px' } },
          '冲突候选' + (conf && conf.conflicts ? ' · ' + conf.conflicts.length + ' 组' : '')),
        conf && conf.conflicts && conf.conflicts.length
          ? h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
              h('tbody', {}, conf.conflicts.slice(0, 30).map((c) => h('tr', { key: c.attr },
                h('td', { style: sCell }, esc(c.attr)),
                h('td', { style: Object.assign({}, sCell, { color: C.dim }) }, esc(c.values.join(' · ')))))))
          : h('div', { style: { color: C.dim, fontSize: 12, padding: '10px 0' } }, '没有同属性多值。'),

        h('div', { style: { color: C.dim, fontSize: 11, marginTop: 26, borderTop: '1px solid ' + C.line, paddingTop: 12 } },
          '删除记忆请用对话里的 memjudge_forget · 打开增强模块需在 secrets.json 填自己的 key'),
      );
    }

    function hKeyRow(k, color, v, fg) {
      return h('div', {},
        h('div', { style: { color: C.dim, fontSize: 12 } }, k),
        h('div', { style: { color: fg || (color === 'bad' ? C.warn : C.fg) } }, h('span', null, v)));
    }

    // ------------------------------------------------------------ apply

    function apply(ctx) {
      const rpcCall = (endpoint, payload) => {
        try {
          return ctx.connection.rpc.call(CHANNEL, endpoint, payload, undefined);
        } catch (e) {
          return Promise.resolve({ ok: false, error: { code: 'call', message: String(e && e.message ? e.message : e) } });
        }
      };
      ctx.effect(() => {
        return ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'memjudge',
          order: 47,
          label: () => '记忆库',
        }, () => react.createElement(MemjudgePanel, { rpc: rpcCall })));
      }, 'memjudge: settings section');
    }

    exports.name = 'dsh-memjudge';
    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
