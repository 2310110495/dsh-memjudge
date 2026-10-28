/**
 * memjudge —— DeepSeek Harness 前端半侧（浏览器）
 *
 * 在「系统设置」左侧栏注册一个「记忆库」入口（与通用设置/模型/插件管理同级）；
 * 另在对话右侧栏（sidebar.right）注册同名 tab，正文复用同一个面板组件。
 * 数据走 DSH 宿主 RPC：ctx.connection.rpc.call('/memjudge', <endpoint>)，
 * 对应 host 半侧 src/rpc.mjs 注册的通道。
 *
 * 视觉与信息架构见 docs/panel-spec.md（A 概览 / B 增强能力与密钥 / C 记忆条目 /
 * D 冲突候选 / E 页脚）。颜色只用宿主令牌 var(--dsw-alias-*)，代码里没有一个 hex
 * 常量——硬编码灰在宿主浅色主题下会掉到 3.2:1，那正是「太淡看不清」的根因。
 *
 * 右栏 tab 走延迟注入（ctx.inject(['sidebarRightTabs'])）：只有宿主真的提供
 * 该服务时才注册，任何异常都在本地回滚，绝不连带设置面板。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memjudge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    const { useState, useEffect, useCallback, useRef } = react;

    const CHANNEL = '/memjudge';

    // ------------------------------------------------------------ 令牌（§1）

    // 全部取自宿主自身：--dsw-alias-* 由宿主按明暗主题解析，结构性颜色不需要
    // body[data-ds-dark-theme] 分支（§9）。
    const C = {
      fg: 'var(--dsw-alias-label-primary)',
      fg2: 'var(--dsw-alias-label-secondary)',
      fg3: 'var(--dsw-alias-label-tertiary)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      line1: 'var(--dsw-alias-border-l1)',
      line2: 'var(--dsw-alias-border-l2)',
      line3: 'var(--dsw-alias-border-l3)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      fill: 'var(--dsw-alias-button-primary-fill)',
      onFill: 'var(--dsw-alias-label-primary-foreground)',
      mono: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace)',
      radius: 'var(--dsw-radius-xl)',
      radiusSm: 'calc(var(--dsw-radius-xl) / 2)',
      dur: 'var(--ds-transition-duration, .2s)',
      ease: 'var(--ds-ease-in-out, ease)',
    };

    const h = react.createElement;

    // -------------------------------------------------------------- 工具

    function fmt(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '—';
      return v.toLocaleString('zh-CN');
    }

    function kb(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '—';
      return (v / 1024).toFixed(1);
    }

    // React 文本节点自带转义，此函数只用于把文本拼进非 React 输出的字符串场景；
    // 保留是为了对齐全仓工具名，不要在 createElement 的 children 里再调它，
    // 否则页面上会看到字面量 &amp;。
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
    }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function absTime(ts) {
      const t = Number(ts);
      if (!Number.isFinite(t) || t <= 0) return '—';
      const d = new Date(t);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
        + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    /** §6 相对时间：≤60min 分钟 / ≤24h 小时 / ≤7d 天 / 更早 MM-DD（跨年带年）。 */
    function relTime(ts) {
      const t = Number(ts);
      if (!Number.isFinite(t) || t <= 0) return '—';
      const diff = Date.now() - t;
      if (diff < 0) return '刚刚';
      const mins = Math.floor(diff / 60000);
      if (mins <= 60) return mins + ' 分钟前';
      if (diff <= 86400000) return Math.floor(diff / 3600000) + ' 小时前';
      const days = Math.floor(diff / 86400000);
      if (days <= 7) return days + ' 天前';
      const d = new Date(t);
      const md = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + '-' + md;
    }

    /** 重要度分档：≥0.6 重要 / 0.3~0.6 普通 / <0.3 未标注（含缺失）。 */
    function impTier(v) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0.3) return 'low';
      return n < 0.6 ? 'mid' : 'high';
    }

    function impColor(tier) {
      if (tier === 'high') return C.ok;
      if (tier === 'mid') return C.warn;
      return C.line3;
    }

    /** 占用比阈值（§3）：<70% 正常，70~89% 警告，≥90% 危险。 */
    function pctOf(used, limit) {
      const u = Number(used);
      const l = Number(limit);
      if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0) return 0;
      const p = (u / l) * 100;
      if (!Number.isFinite(p) || p < 0) return 0;
      return Math.min(100, p);
    }

    function usageColor(pct) {
      if (pct >= 90) return C.bad;
      if (pct >= 70) return C.warn;
      return C.ok;
    }

    /**
     * 掩码降级：hasKey 为真但服务端没回里 keyMasked 时，不能显示空字符串
     * （用户会以为没生效），也不能显示「未配置」。给出明确的中性说明。
     */
    function maskText(cfg) {
      if (!cfg || !cfg.hasKey) return '—';
      const m = cfg.keyMasked;
      return (typeof m === 'string' && m.trim()) ? m.trim() : '（服务端未返回掩码）';
    }

    function errMsg(res) {
      if (res && res.error && res.error.message) return String(res.error.message);
      if (res && res.error && res.error.code) return String(res.error.code);
      if (res && res.ok === false) return '宿主返回失败（无 message）';
      return '宿主 RPC 未响应';
    }

    function importantBuckets(rows) {
      const out = { high: 0, mid: 0, low: 0, total: 0 };
      for (const r of rows || []) {
        out[impTier(r && r.importance)] += 1;
        out.total += 1;
      }
      return out;
    }

    /**
     * C 区口径（§2）：memories 端点历史上返回「最早」120 条，后端补了
     * order/total 之后才可能是「最新」。文案必须与实际排序一致，不能默认说「最近」。
     * total 优先端点回传，退 status.stats.memories，都缺才退 rows.length。
     */
    function countLabel(mems, stats) {
      const rows = (mems && mems.rows) || [];
      const n = rows.length;
      const total = (mems && Number.isFinite(mems.total)) ? mems.total
        : (stats && Number.isFinite(stats.memories)) ? stats.memories : n;
      const desc = !!(mems && mems.order === 'desc');
      if (n === 120 && total > 120) {
        return (desc ? '最新 120 条' : '显示最早 120 条') + ' · 共 ' + fmt(total) + ' 条';
      }
      return fmt(n) + ' 条';
    }

    // ----------------------------------------------------- 注入 CSS（§10）
    //
    // 内联 style 有四个硬缺口：:hover、:focus-visible、@container、后代选择器。
    // 只有这四类能力进 CSS；宽度相关的盒模型属性（padding/列数/换行）必须写在
    // CSS 里，因为内联样式无法被 @container 覆盖。
    const CSS_ID = 'dsh-memjudge/panel.css';
    const CSS = [
      '.mj-panel{padding:24px 28px 40px;max-width:1120px;box-sizing:border-box}',
      '.mj-sec{margin-top:20px}',
      '.mj-card{padding:14px 16px;box-sizing:border-box}',
      '.mj-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}',
      '.mj-num{font-size:20px;line-height:1.2;font-weight:600;font-variant-numeric:tabular-nums}',
      '.mj-modrow{display:flex;align-items:center;gap:10px;padding:8px 0}',
      '.mj-modname{flex:0 0 96px;width:96px;min-width:0}',
      '.mj-moddesc{flex:1 1 auto;min-width:0}',
      '.mj-switchwrap{flex:0 0 auto;margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:2px;min-width:0;max-width:46%}',
      '.mj-keyrow{display:flex;align-items:center;gap:8px}',
      '.mj-keyinput{flex:1 1 auto;min-width:0;position:relative;display:flex}',
      '.mj-keyact{display:flex;align-items:center;gap:8px}',
      '.mj-meta{display:flex;align-items:center;gap:8px;flex-wrap:nowrap}',
      '.mj-conf{display:flex;gap:10px;align-items:flex-start;padding:8px 0}',
      '.mj-confattr{flex:0 0 96px;width:96px;min-width:0}',
      // 按钮的 display 必须走 CSS：内联值优先级高于 @container，删掉这一条会让
      // 窄档的 .mj-fold 显隐失效。
      '.mj-btn,.mj-primary{display:inline-flex;align-items:center;justify-content:center}',
      '.mj-fold{display:none}',
      '.mj-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mj-primary:hover{filter:brightness(1.06)}',
      '.mj-link:hover{text-decoration:underline}',
      '.mj-memrow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mj-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      // 窄档下 .mj-confattr 会占满整行，所以行容器必须能换行，hint 也必须脱开 96px 栅格。
      '.mj-textrow{flex-wrap:wrap}',
      '.mj-text{flex:1 1 auto;min-width:0}',
      '.mj-texthint{margin-top:3px;padding-left:106px;width:100%}',
      '.mj-text::placeholder{color:var(--dsw-alias-label-tertiary)}',
      // 焦点环用 static-accent：宿主主题切换时它不跟着语义层漂移；
      // 兜底给 label-primary，令牌改名时焦点环不会静默消失。
      '.mj-text:focus-visible{outline:2px solid var(--dsw-static-accent-500,var(--dsw-alias-label-primary));outline-offset:1px}',
      '.mj-btn:focus-visible,.mj-primary:focus-visible,.mj-icon:focus-visible,'
        + '.mj-link:focus-visible,.mj-switch:focus-visible,.mj-memrow:focus-visible,'
        + '.mj-fold:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}',
      '.mj-scroll{scrollbar-width:thin;overscroll-behavior:contain}',
      '.mj-scroll::-webkit-scrollbar{width:8px;height:8px}',
      '.mj-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border-radius:999px}',
      '@container memjudge (max-width:520px){'
        + '.mj-panel{padding:16px 20px 32px}'
        + '.mj-sec{margin-top:12px}'
        + '.mj-card{padding:10px 12px}'
        + '.mj-grid{grid-template-columns:repeat(2,minmax(0,1fr))}'
        + '.mj-keyrow{flex-wrap:wrap}'
        + '.mj-keyinput{flex:1 1 100%}'
        + '.mj-keyact{margin-left:auto}'
        + '}',
      '@container memjudge (max-width:400px){'
        + '.mj-panel{padding:12px 12px 28px}'
        + '.mj-num{font-size:18px}'
        + '.mj-modrow{flex-wrap:wrap;row-gap:4px}'
        + '.mj-moddesc{flex:1 0 100%;order:3}'
        + '.mj-keyact{width:100%;margin-left:0;gap:8px}'
        + '.mj-keyact>*{flex:1 1 0;min-width:0}'
        + '.mj-meta{flex-wrap:wrap}'
        + '.mj-conf{flex-wrap:wrap}'
        + '.mj-confattr{flex:1 0 100%;width:auto}'
        + '.mj-texthint{padding-left:0}'
        + '.mj-membody[data-collapsed="1"]{display:none}'
        + '.mj-fold{display:inline-flex}'
        + '}',
    ].join('');

    function ensureCss() {
      try {
        if (typeof document === 'undefined' || !document.head) return;
        if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) return;
        const el = document.createElement('style');
        el.dataset.plugin = 'dsh-memjudge';
        el.dataset.pluginCss = CSS_ID;
        el.textContent = CSS;
        document.head.appendChild(el);
      } catch (e) {
        // 注入失败只是少了 hover/焦点/窄栏适配，面板本身照常渲染
      }
    }

    // ------------------------------------------------------------ 原子块

    /** 卡片：底 bg-layer-1 + 1px border-l2 + radius-xl（§3 层级与圆角）。 */
    function Card({ title, right, children, style }) {
      return h('div', {
        className: 'mj-card',
        style: Object.assign({ background: C.layer1, border: '1px solid ' + C.line2, borderRadius: C.radius }, style || null),
      },
        title ? h('div', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 },
        },
          h('span', { style: { fontSize: 13, lineHeight: '1.4', fontWeight: 600, color: C.fg } }, title),
          right || null) : null,
        children);
    }

    function SectionTitle({ children, right }) {
      return h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
          h('span', {
            style: { display: 'inline-block', width: 3, height: 13, background: C.line3, borderRadius: 2, flex: '0 0 3px' },
          }),
          h('span', { style: { fontSize: 13, lineHeight: '1.4', fontWeight: 600, color: C.fg } }, children)),
        right || null);
    }

    /** 指标格：说明 12/secondary + 大数字 20/600 tabular + 副标 12/secondary。 */
    function Stat({ label, value, sub, tone }) {
      return h('div', {
        style: {
          background: C.layer2, border: '1px solid ' + C.line2, borderRadius: C.radiusSm,
          padding: '10px 12px', minWidth: 0,
        },
      },
        h('div', { style: { fontSize: 12, lineHeight: '1.5', color: C.fg2 } }, label),
        h('div', { className: 'mj-num', style: { color: tone || C.fg, marginTop: 4 } }, value),
        h('div', { style: { fontSize: 12, lineHeight: '1.5', color: C.fg2, marginTop: 2, minHeight: 18 } }, sub || ''));
    }

    /** 占用条：6px 轨道 + 阈值色 + 右侧 40px 百分比（§3）。 */
    function Bar({ used, limit }) {
      const pct = pctOf(used, limit);
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 } },
        h('div', {
          style: {
            flex: '1 1 auto', minWidth: 0, height: 6, background: C.layer2,
            borderRadius: 999, overflow: 'hidden',
          },
        },
          h('div', {
            style: {
              height: '100%', width: pct.toFixed(1) + '%', background: usageColor(pct),
              transition: 'width ' + C.dur + ' ' + C.ease,
            },
          })),
        h('div', {
          style: {
            flex: '0 0 40px', width: 40, textAlign: 'right', fontSize: 13, lineHeight: '1.5',
            color: C.fg2, fontFamily: C.mono, fontVariantNumeric: 'tabular-nums',
          },
        }, pct.toFixed(0) + '%'));
    }

    /** 重要度三段堆叠条 + 图例（不画环形图，理由见 §3）。 */
    function ImportanceBar({ buckets }) {
      const total = buckets ? buckets.total : 0;
      const seg = (n, color, key) => (total > 0 && n > 0
        ? h('div', {
          key: key,
          style: { height: '100%', width: ((n / total) * 100).toFixed(2) + '%', background: color },
        })
        : null);
      return h('div', { style: { marginTop: 10 } },
        h('div', {
          style: {
            display: 'flex', height: 8, background: C.layer2, borderRadius: 999, overflow: 'hidden',
          },
        },
          seg(buckets ? buckets.high : 0, C.ok, 'h'),
          seg(buckets ? buckets.mid : 0, C.warn, 'm'),
          seg(buckets ? buckets.low : 0, C.line3, 'l')),
        h('div', { style: { fontSize: 12, lineHeight: '1.5', color: C.fg2, marginTop: 6 } },
          '重要 ' + (buckets ? buckets.high : 0)
          + ' · 普通 ' + (buckets ? buckets.mid : 0)
          + ' · 未标注 ' + (buckets ? buckets.low : 0)
          + '（当前 ' + total + ' 条采样）'));
    }

    function Btn({ children, onClick, disabled, primary, danger, className, title, ariaLabel, minHeight, style, ...rest }) {
      const base = {
        borderRadius: C.radiusSm, fontSize: 13, lineHeight: '1.4',
        fontFamily: 'inherit', boxSizing: 'border-box',
        minHeight: minHeight || (primary ? 32 : 28),
        padding: primary ? '0 16px' : '0 12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
        transition: 'background ' + C.dur + ' ' + C.ease,
      };
      const look = danger
        ? { background: C.bad, color: C.onFill, border: '1px solid ' + C.bad }
        : primary
          ? { background: C.fill, color: C.onFill, border: '1px solid ' + C.fill, fontWeight: 600 }
          : { background: 'transparent', color: C.fg, border: '1px solid ' + C.line2 };
      return h('button', Object.assign({
        type: 'button',
        className: (primary || danger ? 'mj-primary' : 'mj-btn') + (className ? ' ' + className : ''),
        onClick: disabled ? undefined : onClick,
        disabled: !!disabled,
        title: title,
        'aria-label': ariaLabel,
        style: Object.assign(base, look, style || null),
      }, rest || null), children);
    }

    /** 开关：role="switch" 的原生 button，36×20 轨道，命中区 28 高（§5/§8）。 */
    function Switch({ checked, disabled, busy, label, onClick }) {
      const track = checked ? C.fill : C.line3;
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        className: 'mj-switch',
        disabled: !!disabled,
        onClick: disabled ? undefined : onClick,
        style: {
          width: 36, height: 28, padding: '4px 0', border: 'none', background: 'transparent',
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
          display: 'inline-flex', alignItems: 'center', flex: '0 0 auto', boxSizing: 'border-box',
        },
      },
        h('span', {
          style: {
            position: 'relative', display: 'block', width: 36, height: 20, borderRadius: 999,
            background: track, opacity: busy ? 0.6 : 1,
            transition: 'background ' + C.dur + ' ' + C.ease,
          },
        },
          h('span', {
            style: {
              position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16,
              borderRadius: 999, background: C.onFill,
              transition: 'left ' + C.dur + ' ' + C.ease,
            },
          })));
    }

    function Link({ children, onClick, tone }) {
      return h('button', {
        type: 'button',
        className: 'mj-link',
        onClick: onClick,
        style: {
          padding: 0, border: 'none', background: 'transparent', cursor: 'pointer',
          fontSize: 12, lineHeight: '1.5', fontFamily: 'inherit',
          color: tone || C.warn, textDecoration: 'underline',
        },
      }, children);
    }

    function Hint({ children, tone, mono, style, className }) {
      return h('div', {
        className: className,
        style: Object.assign({
          fontSize: 12, lineHeight: '1.5', color: tone || C.fg2,
          fontFamily: mono ? C.mono : 'inherit',
        }, style || null),
      }, children);
    }

    /**
     * 受控单行输入：左 96px 标签（与 .mj-modname / .mj-confattr 同一栅格）+ 右侧 input。
     * locked 是「被环境变量钉死」，disabled 是「本次提交在飞」——两者都不可编辑，
     * 但原因不同，所以 title 分开写；locked 还要在 hint 上补一句，否则用户只知道点不动。
     * 密钥不归它管：密钥有自己的密码框 + 显隐按钮（keyFormBlock）。
     */
    function TextField({ label, value, onChange, placeholder, hint, mono, disabled, locked, type, inputMode, maxLength }) {
      const off = !!disabled || !!locked;
      const reason = locked ? '该项由环境变量决定，改面板不生效' : disabled ? '正在保存，稍候' : undefined;
      return h('div', { style: { padding: '5px 0' } },
        h('div', { className: 'mj-textrow', style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('div', {
            className: 'mj-confattr',
            'aria-hidden': 'true',
            style: { fontSize: 12, lineHeight: '1.5', color: C.fg2 },
          }, label),
          h('input', {
            className: 'mj-text',
            type: type || 'text',
            value: value == null ? '' : String(value),
            placeholder: placeholder,
            'aria-label': label,
            inputMode: inputMode,
            maxLength: maxLength,
            disabled: off,
            title: reason,
            spellCheck: false,
            autoComplete: 'off',
            onChange: off ? undefined : (e) => onChange(e.target.value),
            style: {
              background: C.layer2, border: '1px solid ' + C.line2, borderRadius: C.radiusSm,
              height: 28, padding: '0 8px', fontSize: 13, lineHeight: '1.5',
              color: C.fg, fontFamily: mono ? C.mono : 'inherit', outline: 'none',
              opacity: off ? 0.55 : 1, cursor: off ? 'not-allowed' : 'text',
            },
          })),
        hint || locked
          ? h(Hint, { className: 'mj-texthint' },
            hint || '',
            locked ? (hint ? ' 被环境变量锁定。' : '被环境变量锁定。') : '')
          : null);
    }

    /** 错误块：摘要 + 等宽原因行（state-error-primary）+ 重试。 */
    function ErrorBlock({ title, detail, onRetry, retryLabel }) {
      return h('div', { style: { padding: '4px 0 6px' } },
        h('div', { style: { fontSize: 13, lineHeight: '1.55', color: C.fg } }, title),
        detail ? h(Hint, { tone: C.bad, mono: true, style: { marginTop: 2, wordBreak: 'break-word' } }, detail) : null,
        onRetry ? h('div', { style: { marginTop: 10 } },
          h(Btn, { onClick: onRetry, minHeight: 28 }, retryLabel || '重试')) : null);
    }

    // ------------------------------------------------ 接口与模型（值型设置）
    //
    // 回读（configReport）是唯一真值来源，这里只放「恢复默认」用的出厂值。
    // 出厂值必须与 src/config.mjs 的 load() 默认分支逐字一致，否则按回去的是另一套配置。
    const SETTING_DEFAULTS = {
      baseUrl: 'https://api.siliconflow.cn/v1',
      chatModel: 'deepseek-ai/DeepSeek-V4-Flash',
      embedModel: 'Qwen/Qwen3-Embedding-8B',
      rerankModel: 'Qwen/Qwen3-Reranker-8B',
      dims: '64',
      storageLimitBytes: '2048',
      maxChars: '0',
    };

    /** 七行输入的顺序、文案与键盘类型；storageLimitBytes 走 kb:true 的字节↔KB 换算。 */
    const SETTING_ROWS = [
      {
        key: 'baseUrl', label: '接口地址', mono: true,
        placeholder: 'https://api.siliconflow.cn/v1',
        hint: 'OpenAI 兼容的 /v1 根地址。改完立刻生效，无需重启。',
      },
      { key: 'chatModel', label: '对话模型', mono: true, hint: '测试连接与 LLM 选段/提取用这个模型。' },
      { key: 'embedModel', label: '向量模型', mono: true, hint: '换模型会重建向量缓存，旧向量不会串用。' },
      { key: 'rerankModel', label: '重排模型', mono: true },
      { key: 'dims', label: '向量维度', inputMode: 'numeric', hint: '须与向量模型输出维度一致。' },
      {
        key: 'storageLimitBytes', label: '存储上限', inputMode: 'numeric', kb: true,
        hint: '仅统计口径，超过会标红但不会阻止写入。',
      },
      {
        key: 'maxChars', label: '写入硬限', inputMode: 'numeric',
        hint: '0 = 不设限。设为正数后超限的写入会被拒绝，不截断。',
      },
    ];

    /** 回读值 → 输入框文本。数值项直接 String()（64.0 会变 '64'）；存储上限按 KB 取整。 */
    function settingText(key, cfg) {
      if (!cfg) return '';
      const raw = cfg[key];
      if (key === 'storageLimitBytes') {
        const n = Number(raw);
        return Number.isFinite(n) ? String(Math.round(n / 1024)) : '';
      }
      return raw == null ? '' : String(raw);
    }

    /**
     * 输入框文本 → 提交值。刻意不在前端清洗数字：空串/非数字原样递给后端，
     * 由后端整批拒绝并回它自己的原话（「dims：必须是整数」），面板只负责显示。
     * 存储上限在界面上是 KB，提交必须是字节。
     */
    function settingValue(key, text) {
      const s = String(text == null ? '' : text).trim();
      if (key === 'storageLimitBytes') {
        const n = Number(s);
        return Number.isFinite(n) ? n * 1024 : null;
      }
      if (key === 'dims' || key === 'maxChars') {
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      }
      return s;
    }

    // ---------------------------------------------------------- 模块定义

    const MODULES = [
      { key: 'jieba', name: 'jieba 分词', desc: '搜索引擎模式切词，替代 CJK 二元组', readonly: true },
      { key: 'vector', name: '向量融合', desc: 'Qwen3-Embedding-8B 64 维 int8，BM25+RRF', gated: true },
      { key: 'rerank', name: '精排 rerank', desc: 'Qwen3-Reranker-8B（综合题实测零增量）', gated: true },
      { key: 'expand', name: '查询扩展', desc: 'LLM 拆子查询', gated: true },
      { key: 'llmSelect', name: 'LLM 选段', desc: '候选段交模型挑选', gated: true },
      { key: 'llmExtract', name: 'LLM 提取', desc: '离线重建 facts', gated: true },
    ];

    const NO_KEY_TITLE = '这五项都要调外部模型，没有 key 会在每次检索时等超时，所以被强制关闭。';

    /**
     * 模块行（§5）。四类门控必须视觉可分：
     * 只读(jieba) / 无 key 强制关（先填密钥）/ env 锁定 / 正常可切。
     */
    function FlagRow({ m, checked, needKey, locked, busy, note, onToggle, onNeedKey }) {
      const readonly = !!m.readonly;
      const disabled = readonly || needKey || locked || busy;
      const right = [];
      if (readonly) {
        right.push(h(Hint, { key: 'ro', style: { whiteSpace: 'normal', textAlign: 'right' } },
          '只读 · 由环境变量 MEMJUDGE_NO_JIEBA 控制'));
      } else if (needKey) {
        right.push(h(Link, { key: 'nk', onClick: onNeedKey }, '先填密钥'));
      } else if (locked) {
        right.push(h(Hint, { key: 'lk' }, '由环境变量锁定'));
      } else {
        right.push(h(Switch, {
          key: 'sw',
          checked: !!checked,
          disabled: disabled,
          busy: busy,
          label: m.name,
          onClick: onToggle,
        }));
      }
      if (note) {
        right.push(h(Hint, { key: 'nt', tone: C.warn, style: { marginTop: 2, whiteSpace: 'normal' } }, note));
      }
      const rowTitle = readonly
        ? '只读项，由环境变量控制'
        : needKey ? NO_KEY_TITLE : (locked ? '该项由环境变量决定，写 config 不生效' : undefined);
      return h('div', { className: 'mj-modrow', title: rowTitle },
        h('div', {
          className: 'mj-modname',
          style: { fontSize: 13, lineHeight: '1.55', color: C.fg, wordBreak: 'break-word' },
        }, m.name),
        h('div', { className: 'mj-moddesc' },
          h(Hint, null, m.desc)),
        h('div', { className: 'mj-switchwrap', style: { flexDirection: 'column', alignItems: 'flex-end' } },
          right));
    }

    // -------------------------------------------------------- 远程数据 hook

    // memories 传 order:'desc'（后端补上后即为最新 120 条）；旧后端会忽略它并返回
    // 最早 120 条，C 区口径文案按返回的 order 字段如实标注，不写「最近」。
    const ENDPOINT_PAYLOAD = {
      status: {},
      memories: { limit: 120, order: 'desc' },
      conflicts: { cap: 40 },
    };

    function useEndpoint(rpc, endpoint) {
      const [state, setState] = useState({ phase: 'loading', data: null, error: '' });
      const alive = useRef(true);
      // 重新挂载时必须把标记置回 true，否则 StrictMode 下第一次 cleanup 之后
      // 所有落地回调都被丢弃，面板永远停在「读取中…」。
      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);
      const load = useCallback(() => {
        setState((prev) => ({ phase: 'loading', data: prev.data, error: '' }));
        let p;
        try {
          p = rpc(endpoint, ENDPOINT_PAYLOAD[endpoint]);
        } catch (e) {
          p = Promise.reject(e);
        }
        return Promise.resolve(p).then((res) => {
          if (!alive.current) return;
          if (res && res.ok) {
            setState({ phase: 'ready', data: res.value || null, error: '' });
            return;
          }
          setState({ phase: 'error', data: null, error: errMsg(res) });
        }, (e) => {
          if (!alive.current) return;
          setState({ phase: 'error', data: null, error: e && e.message ? String(e.message) : String(e) });
        });
      }, [rpc, endpoint]);
      useEffect(() => { load(); }, [load]);
      return [state, load, setState];
    }

    // -------------------------------------------------------------- 面板

    function MemjudgePanel({ rpc }) {
      ensureCss();

      const [statusSt, reloadStatus, setStatusSt] = useEndpoint(rpc, 'status');
      const [memsSt, reloadMems] = useEndpoint(rpc, 'memories');
      const [confSt, reloadConf] = useEndpoint(rpc, 'conflicts');

      const reloadAll = useCallback(() => {
        reloadStatus(); reloadMems(); reloadConf();
      }, [reloadStatus, reloadMems, reloadConf]);

      const cfg = statusSt.data && statusSt.data.config ? statusSt.data.config : null;
      const stats = statusSt.data && statusSt.data.stats ? statusSt.data.stats : null;
      const rows = (memsSt.data && Array.isArray(memsSt.data.rows)) ? memsSt.data.rows : null;
      const conflicts = (confSt.data && Array.isArray(confSt.data.conflicts)) ? confSt.data.conflicts : null;

      // ---- 密钥区状态（§4）——不乐观更新，一切以 status 回读为准
      const keyRef = useRef(null);
      const [keyInput, setKeyInput] = useState('');
      const [keyShown, setKeyShown] = useState(false);
      const [keyBusy, setKeyBusy] = useState('');
      const [keyMsg, setKeyMsg] = useState(null);
      const [confirmClear, setConfirmClear] = useState(false);
      const fadeTimer = useRef(null);
      const armTimer = useRef(null);

      useEffect(() => () => {
        if (fadeTimer.current) clearTimeout(fadeTimer.current);
        if (armTimer.current) clearTimeout(armTimer.current);
      }, []);

      const setFeedback = useCallback((msg, fade) => {
        setKeyMsg(msg);
        if (fadeTimer.current) clearTimeout(fadeTimer.current);
        if (fade) {
          fadeTimer.current = setTimeout(() => {
            setKeyMsg((cur) => (cur === msg ? null : cur));
          }, 4000);
        }
      }, []);

      const resetConfirm = useCallback(() => {
        if (armTimer.current) clearTimeout(armTimer.current);
        armTimer.current = null;
        setConfirmClear(false);
      }, []);

      const pullStatus = useCallback(() => {
        return Promise.resolve(rpc('status', {})).then((res) => {
          if (res && res.ok) { setStatusSt({ phase: 'ready', data: res.value || null, error: '' }); return res.value; }
          setStatusSt({ phase: 'error', data: null, error: errMsg(res) });
          return null;
        }, (e) => {
          setStatusSt({ phase: 'error', data: null, error: e && e.message ? String(e.message) : String(e) });
          return null;
        });
      }, [rpc, setStatusSt]);

      const saveKey = useCallback(() => {
        const v = keyInput.trim();
        if (!v || keyBusy) return;
        setKeyBusy('save');
        setFeedback(null);
        Promise.resolve(rpc('saveKey', { key: v })).then((res) => {
          if (!(res && res.ok)) {
            setFeedback({ kind: 'err', text: '保存失败：' + errMsg(res) });
            return null;
          }
          return pullStatus().then(() => {
            setKeyInput('');
            setFeedback({ kind: 'ok', text: '已保存，密钥即刻生效。' }, true);
            return null;
          });
        }, (e) => {
          setFeedback({ kind: 'err', text: '保存失败：' + (e && e.message ? e.message : String(e)) });
        }).then(() => { setKeyBusy(''); });
      }, [keyInput, keyBusy, rpc, pullStatus, setFeedback]);

      const testKey = useCallback(() => {
        if (keyBusy) return;
        setKeyBusy('test');
        setFeedback(null);
        const payload = keyInput.trim() ? { key: keyInput.trim() } : {};
        Promise.resolve(rpc('testKey', payload)).then((res) => {
          if (!(res && res.ok)) {
            setFeedback({ kind: 'err', text: '连接失败：' + errMsg(res) });
            return;
          }
          const v = res.value || {};
          if (v.ok) {
            setFeedback({
              kind: 'ok',
              text: '连接正常 · ' + (Number.isFinite(v.latencyMs) ? v.latencyMs : '—')
                + ' ms · 模型 ' + (v.model || (cfg && cfg.chatModel) || '未知'),
            });
          } else {
            setFeedback({
              kind: 'err',
              text: '连接失败：' + (v.status != null ? v.status + ' ' : '') + (v.message || '无返回信息')
                + '\n401 表示 key 无效或已过期；连不上表示端点不可达。',
            });
          }
        }, (e) => {
          setFeedback({ kind: 'err', text: '连接失败：' + (e && e.message ? e.message : String(e)) });
        }).then(() => { setKeyBusy(''); });
      }, [keyBusy, keyInput, rpc, cfg, setFeedback]);

      const clearKey = useCallback(() => {
        if (keyBusy) return;
        if (!confirmClear) {
          setConfirmClear(true);
          if (armTimer.current) clearTimeout(armTimer.current);
          armTimer.current = setTimeout(() => { setConfirmClear(false); }, 5000);
          return;
        }
        resetConfirm();
        setKeyBusy('clear');
        setFeedback(null);
        Promise.resolve(rpc('clearKey', {})).then((res) => {
          if (!(res && res.ok)) {
            setFeedback({ kind: 'err', text: '清除失败：' + errMsg(res) });
            return null;
          }
          return pullStatus().then(() => {
            setFeedback({ kind: 'ok', text: '密钥已清除，增强模块已停用。' }, true);
            return null;
          });
        }, (e) => {
          setFeedback({ kind: 'err', text: '清除失败：' + (e && e.message ? e.message : String(e)) });
        }).then(() => { setKeyBusy(''); });
      }, [keyBusy, confirmClear, rpc, pullStatus, resetConfirm, setFeedback]);

      const focusKeyInput = useCallback(() => {
        const el = keyRef.current;
        if (!el) return;
        try { if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); } catch (e) { /* 老宿主忽略 */ }
        try { el.focus(); } catch (e2) { /* 忽略 */ }
      }, []);

      // ---- 模块开关（§5）——saveConfig → 重拉 status → 按回读渲染
      const [flagBusy, setFlagBusy] = useState({});
      const [flagNote, setFlagNote] = useState({});

      const toggleFlag = useCallback((flag, next) => {
        setFlagBusy((p) => Object.assign({}, p, { [flag]: true }));
        setFlagNote((p) => { const n = Object.assign({}, p); delete n[flag]; return n; });
        Promise.resolve(rpc('saveConfig', { patch: { [flag]: next } })).then((res) => {
          if (!(res && res.ok)) {
            setFlagNote((p) => Object.assign({}, p, { [flag]: '保存失败：' + errMsg(res) }));
            return null;
          }
          return pullStatus().then((value) => {
            const actual = value && value.config && value.config.flags ? value.config.flags[flag] : undefined;
            if (actual !== undefined && !!actual !== !!next) {
              setFlagNote((p) => Object.assign({}, p, {
                [flag]: '已保存，但被环境变量覆盖为' + (actual ? '开启' : '关闭'),
              }));
            }
            return null;
          });
        }, (e) => {
          setFlagNote((p) => Object.assign({}, p, {
            [flag]: '保存失败：' + (e && e.message ? e.message : String(e)),
          }));
        }).then(() => {
          setFlagBusy((p) => { const n = Object.assign({}, p); delete n[flag]; return n; });
        });
      }, [rpc, pullStatus]);

      // ---- 「有 key 但五项全关」引导卡（§5 补）——同样不乐观更新，按回读 flags 报数
      const GATED_FLAG_KEYS = ['vector', 'rerank', 'expand', 'llmSelect', 'llmExtract'];
      const [bulkBusy, setBulkBusy] = useState(false);
      const [bulkErr, setBulkErr] = useState('');
      // 成功项数：成功后五项已全亮，卡片条件本会立刻失效，这行结果就没处落。
      // 留着它 4 秒再撤，用户才看得到「已打开 N 项」。
      const [bulkDone, setBulkDone] = useState(null);
      const bulkTimer = useRef(null);

      useEffect(() => () => {
        if (bulkTimer.current) clearTimeout(bulkTimer.current);
      }, []);

      const openAllFlags = useCallback(() => {
        if (bulkBusy) return;
        const cur = statusSt.data && statusSt.data.config ? statusSt.data.config : null;
        const locked = cur && cur.envLocked && typeof cur.envLocked === 'object' ? cur.envLocked : {};
        // 被环境变量钉死的项写不进 config.json，patch 里干脆不给它
        const targets = GATED_FLAG_KEYS.filter((f) => locked[f] !== true);
        if (targets.length === 0) return;
        setBulkBusy(true);
        setBulkErr('');
        setBulkDone(null);
        if (bulkTimer.current) clearTimeout(bulkTimer.current);
        const patch = {};
        for (const f of targets) patch[f] = true;
        Promise.resolve(rpc('saveConfig', { patch })).then((res) => {
          if (!(res && res.ok)) {
            setBulkErr('打开失败：' + errMsg(res));
            return null;
          }
          return pullStatus().then((value) => {
            const fl = value && value.config && value.config.flags ? value.config.flags : {};
            const n = targets.filter((f) => !!fl[f]).length;
            setBulkDone(n);
            bulkTimer.current = setTimeout(() => { setBulkDone(null); }, 4000);
            return null;
          });
        }, (e) => {
          setBulkErr('打开失败：' + (e && e.message ? e.message : String(e)));
        }).then(() => { setBulkBusy(false); });
      }, [bulkBusy, rpc, pullStatus, statusSt.data]);

      // ---- 接口与模型（§5 补）——draft 只在用户动过时存在，保存成功即丢弃，回读为准
      const [settingsDraft, setSettingsDraft] = useState(null);
      const [settingsBusy, setSettingsBusy] = useState(false);
      const [settingsMsg, setSettingsMsg] = useState(null);
      const settingsTimer = useRef(null);

      useEffect(() => () => {
        if (settingsTimer.current) clearTimeout(settingsTimer.current);
      }, []);

      const settingsLocked = cfg && cfg.envLockedSettings && typeof cfg.envLockedSettings === 'object'
        ? cfg.envLockedSettings : null;

      const editSetting = useCallback((key, text) => {
        setSettingsDraft((prev) => Object.assign({}, prev || {}, { [key]: text }));
        setSettingsMsg(null);
      }, []);

      // 「恢复默认」只改输入框，不发请求：用户可能只想拿回默认值再手改两个字段。
      const restoreSettingDefaults = useCallback(() => {
        setSettingsMsg(null);
        setSettingsDraft(Object.assign({}, SETTING_DEFAULTS));
      }, []);

      const saveSettings = useCallback(() => {
        if (settingsBusy) return;
        // 只提交与回读值不同的字段；空串也算改动，交给后端报「不能为空」。
        const patch = {};
        for (const row of SETTING_ROWS) {
          const base = settingText(row.key, cfg);
          const cur = settingsDraft && Object.prototype.hasOwnProperty.call(settingsDraft, row.key)
            ? settingsDraft[row.key] : base;
          if (String(cur) === String(base)) continue;
          patch[row.key] = settingValue(row.key, cur);
        }
        if (Object.keys(patch).length === 0) {
          setSettingsMsg({ kind: 'info', text: '没有改动需要保存。' });
          return;
        }
        setSettingsBusy(true);
        setSettingsMsg(null);
        Promise.resolve(rpc('saveSettings', { settings: patch })).then((res) => {
          if (!(res && res.ok)) {
            setSettingsMsg({ kind: 'err', text: '保存失败：' + errMsg(res) });
            return null;
          }
          const vecReset = !!(res.value && res.value.vecCacheReset === true);
          setSettingsDraft(null);
          // 不乐观更新：保存成功也重拉 status，输入框显示的是配置层真正的生效值
          // （被 env 钉住的项写进 config.json 也不会变，只有回读能说出这件事）。
          return pullStatus().then(() => {
            setSettingsMsg({
              kind: 'ok',
              text: '已保存。',
              extra: vecReset ? '向量缓存已切换到新模型，下次检索会重建。' : '',
            });
            if (settingsTimer.current) clearTimeout(settingsTimer.current);
            settingsTimer.current = setTimeout(() => { setSettingsMsg(null); }, 4000);
            return null;
          });
        }, (e) => {
          setSettingsMsg({ kind: 'err', text: '保存失败：' + (e && e.message ? e.message : String(e)) });
        }).then(() => { setSettingsBusy(false); });
      }, [settingsBusy, settingsDraft, cfg, rpc, pullStatus]);

      // ---- C 区折叠：宽档由 CSS 忽略 data-collapsed，窄档默认收起（§7）
      const [memCollapsed, setMemCollapsed] = useState(true);
      // 同一组件会同时挂在设置页和右栏，aria-controls 的 id 必须按实例唯一。
      const memBodyId = useRef('mj-mem-body-' + Math.random().toString(36).slice(2, 8));

      // ---- 头部状态行（§2 三态）
      const allFailed = statusSt.phase === 'error' && memsSt.phase === 'error' && confSt.phase === 'error';
      const anyLoading = statusSt.phase === 'loading' || memsSt.phase === 'loading' || confSt.phase === 'loading';
      const firstLoad = (statusSt.phase === 'loading' && statusSt.data === null)
        || (memsSt.phase === 'loading' && memsSt.data === null)
        || (confSt.phase === 'loading' && confSt.data === null);
      const statusLine = allFailed
        ? '读取失败：' + (statusSt.error || '宿主 RPC 未响应')
        : firstLoad ? '正在读取记忆库…'
          : anyLoading ? '刷新中…' : '已连接宿主 RPC';

      const header = h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontSize: 20, lineHeight: '1.3', fontWeight: 600, color: C.fg } }, '记忆库'),
          h('div', { style: { fontSize: 13, lineHeight: '1.5', color: C.fg2, marginTop: 2 } }, statusLine)),
        h(Btn, {
          onClick: reloadAll,
          disabled: anyLoading,
          title: '重新拉取库体、记忆与冲突',
        }, anyLoading ? '刷新中…' : '↻ 刷新'));

      const rootStyle = {
        containerType: 'inline-size',
        containerName: 'memjudge',
        fontSize: 13,
        lineHeight: 1.55,
        color: C.fg,
        boxSizing: 'border-box',
      };

      // ======================================================== 首屏全挂
      // 规格：只保留 A 区壳 + 一个重试，C/D 不再各自报错。
      if (allFailed) {
        return h('div', { className: 'mj-panel', style: rootStyle },
          header,
          h('div', { className: 'mj-sec' },
            h(SectionTitle, null, '概览'),
            h(Card, null,
              h('div', { className: 'mj-grid' }, emptyStats()),
              h(ErrorBlock, { title: '读不到库体数据', detail: statusSt.error }))),
          h('div', { style: { marginTop: 16 } },
            h(Btn, { primary: true, onClick: reloadAll }, '重试')));
      }

      // ============================================================ 概览 A
      const overviewError = statusSt.phase === 'error';
      const overviewEmpty = !!stats && Number(stats.memories) === 0;

      const sectionA = h('div', { className: 'mj-sec' },
        h(SectionTitle, null, '概览'),
        overviewError
          ? h(Card, null,
            h(ErrorBlock, { title: '读不到库体数据', detail: statusSt.error, onRetry: reloadStatus }))
          : h(Card, null,
            h('div', { className: 'mj-grid' }, stats ? [
              h(Stat, {
                key: 'm', label: '记忆条目', value: fmt(stats.memories),
                sub: fmt(stats.segments) + ' 段',
              }),
              h(Stat, {
                key: 'f', label: '三元组', value: fmt(stats.facts),
                sub: fmt(stats.attrCount) + ' 个属性',
              }),
              h(Stat, { key: 'c', label: '正文字数', value: fmt(stats.textChars), sub: fmt(stats.textBytes) + ' 字节' }),
              h(Stat, {
                key: 'b', label: '占用',
                value: kb(stats.bytes) + 'KB',
                sub: '上限 ' + kb(stats.limitBytes) + 'KB · 余 ' + kb(Math.max(0, Number(stats.limitBytes) - Number(stats.bytes))) + 'KB',
                tone: stats.withinLimit === false ? C.bad : C.fg,
              }),
              h(Stat, {
                key: 'w', label: '已磨损段', value: fmt(stats.wornSegments),
                sub: '占全部段 ' + (Number.isFinite(Number(stats.wear)) ? (Number(stats.wear) * 100).toFixed(0) : '—') + '%',
              }),
              h(Stat, {
                key: 'x', label: '单条上限',
                value: Number(stats.maxChars) > 0 ? fmt(stats.maxChars) : '不限',
                sub: '字符 / 条',
              }),
            ] : emptyStats()),
            stats ? h(Bar, { used: stats.bytes, limit: stats.limitBytes }) : null,
            rows && rows.length ? h(ImportanceBar, { buckets: importantBuckets(rows) }) : null,
            overviewEmpty
              ? h(Hint, { style: { marginTop: 10 } }, '库里还没有记忆。在对话里用 memjudge_remember 写入第一条。')
              : null));

      // ==================================================== 增强能力与密钥 B
      const gatedModules = MODULES.filter((m) => !m.readonly);
      const hasKey = !!(cfg && cfg.hasKey);
      const envLocked = cfg && cfg.envLocked && typeof cfg.envLocked === 'object' ? cfg.envLocked : null;
      const cfgLoading = statusSt.phase === 'loading' && !cfg;
      // 密钥到位但五项增强一盏都没亮：用户看不出因果，必须当场告诉他打开。
      // bulkDone 是成功后 4 秒的宽限，让「已打开 N 项」有地方落地。
      const showBulkCard = statusSt.phase === 'ready' && hasKey && !!cfg && !!cfg.flags
        && (GATED_FLAG_KEYS.every((f) => !cfg.flags[f]) || bulkDone !== null);

      const keyCardBody = statusSt.phase === 'error'
        ? h('div', null,
          h(ErrorBlock, { title: '配置读取失败：' + (statusSt.error || '未知原因'), onRetry: reloadStatus }))
        : cfgLoading
          ? h(Hint, null, '读取配置中…')
          : cfg
            ? h('div', null, keyStatusBlock(), keyFormBlock(), keyFeedbackBlock())
            : h(Hint, null, '读取配置中…');

      function keyStatusBlock() {
        const src = cfg.keySource;
        const envSrc = src === 'env';
        return h('div', { style: { marginBottom: 10 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', {
              style: {
                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
                borderRadius: 999, fontSize: 12, lineHeight: '1.5',
                background: C.layer2, border: '1px solid ' + C.line2,
                color: hasKey ? C.ok : C.warn,
              },
            }, hasKey ? '已配置' : '未配置'),
            envSrc ? h('span', {
              title: '环境变量里的 key 不跟着这台机器走',
              style: { fontSize: 12, color: C.warn, lineHeight: '1.5' },
            }, '· 环境变量来源') : null),
          hasKey
            ? h('div', {
              style: { fontFamily: C.mono, fontSize: 13, lineHeight: '1.55', color: C.fg, marginTop: 6, wordBreak: 'break-all' },
            }, maskText(cfg))
            : h('div', { style: { fontSize: 13, lineHeight: '1.55', color: C.fg, marginTop: 6 } },
              '填上你自己的 API key，下面五项增强才能打开。'),
          hasKey
            ? h(Hint, { style: { marginTop: 2 } },
              envSrc ? '来自环境变量 MEMJUDGE_LLM_KEY（换机器要重新填）'
                : src === 'secrets.json' ? '你自己填的，存于本机 secrets.json'
                  : '来源未知，增强能力可能无法调用外部模型')
            : h(Hint, { style: { marginTop: 2 } },
              '向量、重排、查询扩展、LLM 选段、LLM 提取五项增强全部停用，检索退回关键词匹配。'));
      }

      function keyFormBlock() {
        const busy = !!keyBusy;
        const canSave = keyInput.trim().length > 0 && !busy;
        return h('div', { className: 'mj-keyrow' },
          h('div', { className: 'mj-keyinput' },
            h('input', {
              ref: keyRef,
              className: 'mj-input',
              type: keyShown ? 'text' : 'password',
              value: keyInput,
              disabled: busy,
              placeholder: '粘贴 API key（sk-...）',
              'aria-label': 'API key',
              autoComplete: 'off',
              spellCheck: false,
              onChange: (e) => setKeyInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && canSave) saveKey(); },
              style: {
                width: '100%', minHeight: 32, padding: '0 34px 0 10px', boxSizing: 'border-box',
                background: C.layer1, border: '1px solid ' + C.line2, borderRadius: C.radiusSm,
                color: C.fg, fontSize: 13, lineHeight: '1.5', fontFamily: C.mono, outline: 'none',
              },
            }),
            h('button', {
              type: 'button',
              className: 'mj-icon',
              'aria-label': keyShown ? '隐藏密钥' : '显示密钥',
              'aria-pressed': keyShown ? 'true' : 'false',
              onClick: () => setKeyShown((v) => !v),
              style: {
                position: 'absolute', right: 2, top: 2, bottom: 2, width: 28, height: 'auto',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                border: 'none', borderRadius: C.radiusSm, background: 'transparent',
                color: C.fg2, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
              },
            }, keyShown ? '隐' : '显')),
          h('div', { className: 'mj-keyact' },
            h(Btn, { primary: true, disabled: !canSave, onClick: saveKey },
              keyBusy === 'save' ? '保存中…' : '保存密钥'),
            h(Btn, { disabled: busy, onClick: testKey },
              keyBusy === 'test' ? '测试中…' : '测试连接'),
            hasKey ? h(Btn, {
              danger: confirmClear,
              disabled: busy,
              onClick: clearKey,
              title: confirmClear ? '5 秒内再点一次即清除' : '清除本机 secrets.json 里的密钥',
            }, keyBusy === 'clear' ? '清除中…' : confirmClear ? '确认清除' : '清除') : null));
      }

      function keyFeedbackBlock() {
        if (!keyMsg) return h('div', { 'aria-live': 'polite', style: { minHeight: 18, marginTop: 6 } });
        const tone = keyMsg.kind === 'ok' ? C.ok : keyMsg.kind === 'err' ? C.bad : C.fg2;
        return h('div', {
          'aria-live': 'polite',
          style: { fontSize: 12, lineHeight: '1.5', color: tone, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
        }, keyMsg.text);
      }

      /**
       * 引导卡（§5 补）：有密钥但五项增强全关。
       * 不乐观更新——按钮只发 saveConfig，灯亮不亮看 status 回读；
       * 被环境变量锁定的项不进 patch，全锁时按钮直接禁用。
       */
      function bulkCardBody() {
        const lockedKeys = GATED_FLAG_KEYS.filter((f) => !!(envLocked && envLocked[f] === true));
        const openableKeys = GATED_FLAG_KEYS.filter((f) => lockedKeys.indexOf(f) < 0);
        const allLocked = openableKeys.length === 0;
        // 部分锁定：按钮呈禁用态（opacity/cursor/aria-disabled），但 patch 里剔掉被锁项后
        // 仍可提交——否则「只写没锁的」分支永远走不到，用户也没法一次打开剩下的几项。
        const softLocked = !allLocked && lockedKeys.length > 0;
        const lookDisabled = allLocked || softLocked;
        // 成功后五项已全亮，卡片主体不再成立：只留一行结果，4 秒后整张卡撤掉。
        if (bulkDone !== null) {
          return h('div', { 'aria-live': 'polite', style: { fontSize: 12, lineHeight: '1.5', color: C.ok } },
            '已打开 ' + bulkDone + ' 项。');
        }
        return h('div', null,
          h('div', {
            style: { fontSize: 13, lineHeight: '1.5', fontWeight: 600, color: C.fg },
          }, '密钥已就位，但五项增强全部关闭'),
          h('div', {
            style: { fontSize: 13, lineHeight: '1.55', color: C.fg2, marginTop: 6 },
          }, '现在检索只走关键词匹配（BM25）。打开后会用向量召回与重排，代价是每次检索都要多调一次外部模型。'),
          lockedKeys.length
            ? h('div', {
              style: { fontSize: 12, lineHeight: '1.5', color: C.fg2, marginTop: 6 },
            }, '有 ' + lockedKeys.length + ' 项被环境变量锁定，无法在面板打开。')
            : null,
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' },
          },
            h(Btn, {
              primary: true,
              disabled: bulkBusy || allLocked,
              onClick: openAllFlags,
              'aria-disabled': lookDisabled ? 'true' : undefined,
              title: allLocked ? '五项都被环境变量锁定，面板无法写入'
                : softLocked ? '被环境变量锁定的项不会写入，只打开其余 ' + openableKeys.length + ' 项'
                  : '一次打开五项增强',
              style: lookDisabled ? { opacity: 0.5, cursor: 'not-allowed' } : null,
            }, bulkBusy ? '打开中…' : '全部打开'),
            h('div', {
              'aria-live': 'polite',
              style: { minHeight: 18, fontSize: 12, lineHeight: '1.5' },
            }, bulkErr
              ? h('span', { style: { color: C.bad, wordBreak: 'break-word' } }, bulkErr)
              : null)));
      }

      function moduleListBlock() {
        if (cfgLoading) {
          return h('div', null, MODULES.map((m) => h('div', { key: m.key, className: 'mj-modrow' },
            h('div', { className: 'mj-modname', style: { fontSize: 13, color: C.fg } }, m.name),
            h('div', { className: 'mj-moddesc' }, h(Hint, null, m.desc)),
            h('div', { className: 'mj-switchwrap' },
              h('span', {
                style: {
                  width: 36, height: 20, borderRadius: 999, background: C.layer2,
                  border: '1px solid ' + C.line2, opacity: 0.6, display: 'inline-block',
                },
              })))));
        }
        if (!cfg || !cfg.flags) {
          return h(Hint, { style: { padding: '8px 0' } }, '读取中…');
        }
        return h('div', null, MODULES.map((m) => {
          const locked = !!(envLocked && envLocked[m.key] === true);
          return h(FlagRow, {
            key: m.key,
            m: m,
            checked: !!cfg.flags[m.key],
            needKey: !m.readonly && !hasKey,
            locked: locked,
            busy: !!flagBusy[m.key],
            note: flagNote[m.key] || '',
            onToggle: () => toggleFlag(m.key, !cfg.flags[m.key]),
            onNeedKey: focusKeyInput,
          });
        }));
      }

      /**
       * 接口与模型：七行值型设置。回读（configReport）是唯一真值来源，
       * draft 只覆盖用户动过的键；保存成功后 draft 丢弃，输入框回到回读值。
       * 这一组存在的理由：不装硅基流动也必须能用——换成任何 OpenAI 兼容端点即可。
       */
      function settingsCardBody() {
        if (statusSt.phase === 'error') {
          return h(ErrorBlock, {
            title: '配置读取失败：' + (statusSt.error || '未知原因'),
            onRetry: reloadStatus,
          });
        }
        if (!cfg) return h(Hint, null, '读取配置中…');
        const rows7 = SETTING_ROWS.map((row) => {
          const base = settingText(row.key, cfg);
          const val = settingsDraft && Object.prototype.hasOwnProperty.call(settingsDraft, row.key)
            ? settingsDraft[row.key] : base;
          const locked = !!(settingsLocked && settingsLocked[row.key] === true);
          return h(TextField, {
            key: row.key,
            label: row.label,
            value: val,
            onChange: (text) => editSetting(row.key, text),
            placeholder: row.placeholder,
            hint: row.hint,
            mono: row.mono,
            inputMode: row.inputMode,
            locked: locked,
            disabled: settingsBusy,
          });
        });
        const tone = settingsMsg
          ? (settingsMsg.kind === 'err' ? C.bad : settingsMsg.kind === 'ok' ? C.ok : C.fg2)
          : C.fg2;
        return h('div', null,
          rows7,
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' },
          },
            h(Btn, { primary: true, disabled: settingsBusy, onClick: saveSettings },
              settingsBusy ? '保存中…' : '保存'),
            h(Btn, {
              disabled: settingsBusy,
              onClick: restoreSettingDefaults,
              title: '只把七个输入框填回出厂值，不提交',
            }, '恢复默认'),
            h('div', {
              'aria-live': 'polite',
              style: {
                display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
                minHeight: 18, minWidth: 0, fontSize: 12, lineHeight: '1.5', color: tone,
              },
            },
              settingsMsg ? h('span', { style: { minWidth: 0, wordBreak: 'break-word' } }, settingsMsg.text) : null,
              settingsMsg && settingsMsg.extra
                ? h('span', { style: { minWidth: 0, wordBreak: 'break-word' } }, settingsMsg.extra)
                : null)),
          hasKey && cfg.hint ? h(Hint, { style: { marginTop: 8 } }, cfg.hint) : null);
      }

      const sectionB = h('div', { className: 'mj-sec' },
        h(SectionTitle, null, '增强能力与密钥'),
        h(Card, { title: '密钥' }, keyCardBody),
        showBulkCard ? h('div', { style: { height: 10 } }) : null,
        showBulkCard ? h(Card, null, bulkCardBody()) : null,
        h('div', { style: { height: 10 } }),
        h(Card, { title: '接口与模型' }, settingsCardBody()),
        h('div', { style: { height: 10 } }),
        h(Card, { title: '增强模块' }, moduleListBlock()));

      // ========================================================== 记忆条目 C
      const memCount = rows ? countLabel(memsSt.data, stats) : '';
      const memRight = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        rows ? h(Hint, null, memCount) : null,
        rows && rows.length
          ? h(Btn, {
            className: 'mj-fold',
            onClick: () => setMemCollapsed((v) => !v),
            'aria-expanded': memCollapsed ? 'false' : 'true',
            'aria-controls': memBodyId.current,
            minHeight: 28,
            style: { minHeight: 24, padding: '0 8px' },
          }, memCollapsed ? '展开 ' + rows.length + ' 条' : '收起')
          : null);

      let memBody;
      if (memsSt.phase === 'error') {
        memBody = h(ErrorBlock, { title: '记忆列表读取失败：' + (memsSt.error || '未知原因'), onRetry: reloadMems });
      } else if (!rows) {
        memBody = h('div', null, [0, 1, 2].map((i) => h('div', {
          key: 'sk' + i,
          style: {
            height: 54, marginBottom: 8, background: C.layer2,
            border: '1px solid ' + C.line2, borderRadius: C.radiusSm, opacity: 0.55,
          },
        })));
      } else if (rows.length === 0) {
        memBody = h(Hint, { style: { padding: '10px 0' } },
          '库里还没有记忆。在对话里用 memjudge_remember 写入第一条。');
      } else {
        memBody = h('div', { className: 'mj-scroll', style: { maxHeight: 320, overflowY: 'auto' } },
          groupRows(rows).map((g) => h('div', { key: 'g:' + (g.chapter || '__none') },
            h('div', {
              style: {
                position: 'sticky', top: 0, zIndex: 1, background: C.layer1,
                padding: '6px 0 4px', fontSize: 12, lineHeight: '1.5', color: C.fg2,
              },
            }, (g.chapter && g.chapter !== '0' ? '第 ' + g.chapter + ' 章' : '未标章') + ' · ' + g.rows.length + ' 条'),
            h('div', null, g.rows.map((r) => h(MemoryRow, { key: r.id, r: r }))))));
      }

      const sectionC = h('div', { className: 'mj-sec' },
        h(SectionTitle, { right: memRight }, '记忆条目'),
        h('div', {
          id: memBodyId.current,
          className: 'mj-membody',
          'data-collapsed': memCollapsed ? '1' : '0',
        }, memBody));

      // ========================================================== 冲突候选 D
      let confBody;
      if (confSt.phase === 'error') {
        confBody = h(ErrorBlock, { title: '冲突候选读取失败：' + (confSt.error || '未知原因'), onRetry: reloadConf });
      } else if (!conflicts) {
        confBody = h(Hint, { style: { padding: '8px 0' } }, '检查冲突中…');
      } else if (conflicts.length === 0) {
        confBody = h(Hint, { style: { padding: '8px 0' } },
          '没有冲突候选。只有同一属性出现过两个不同取值时才列在这里，现在是干净的。');
      } else {
        confBody = h('div', null, conflicts.map((c) => h('div', { key: c.attr, className: 'mj-conf' },
          h('div', {
            className: 'mj-confattr',
            style: { fontFamily: C.mono, fontSize: 13, lineHeight: '1.55', color: C.fg, wordBreak: 'break-all' },
          }, c.attr || '—'),
          h('div', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 13, lineHeight: '1.55', color: C.fg2, wordBreak: 'break-word' } },
            (Array.isArray(c.values) ? c.values : []).join(' · ')))));
      }

      const sectionD = h('div', { className: 'mj-sec' },
        h(SectionTitle, { right: conflicts ? h(Hint, null, conflicts.length + ' 组') : null }, '冲突候选'),
        h(Card, null, confBody));

      // ============================================================== 页脚 E
      const sectionE = h('div', { className: 'mj-sec' },
        h('div', {
          style: {
            borderTop: '1px solid ' + C.line1, paddingTop: 10,
            fontSize: 12, lineHeight: '1.6', color: C.fg3, wordBreak: 'break-all',
          },
        },
          h('div', null, '删除记忆请用对话里的 memjudge_forget；面板只读。'),
          cfg ? h('div', null, '配置文件 ' + cfg.configPath) : null,
          cfg ? h('div', null, '密钥文件 ' + cfg.secretsPath) : null));

      return h('div', { className: 'mj-panel', style: rootStyle },
        header, sectionA, sectionB, sectionC, sectionD, sectionE);

      // ------------------------------------------------------------ 内部渲染件

      function emptyStats() {
        const labels = [
          ['记忆条目', ''], ['三元组', ''], ['正文字数', ''], ['占用', ''],
          ['已磨损段', ''], ['单条上限', ''],
        ];
        return labels.map((l, i) => h(Stat, { key: 'e' + i, label: l[0], value: '—', sub: '' }));
      }
    }

    /** 同章连续合并；chapter 为空串的归入末尾组「未标章」（§6）。 */
    function groupRows(rows) {
      const groups = [];
      const untagged = [];
      let cur = null;
      for (const r of rows) {
        const ch = r && r.chapter != null ? String(r.chapter) : '';
        if (!ch) { untagged.push(r); continue; }
        if (!cur || cur.chapter !== ch) { cur = { chapter: ch, rows: [] }; groups.push(cur); }
        cur.rows.push(r);
      }
      if (untagged.length) groups.push({ chapter: '', rows: untagged });
      return groups;
    }

    /** source 列一列两用：无显式来源时存的是章段编码（c0-p0），那种不当来源显示。 */
    function sourceText(v) {
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s) return '';
      return /^c\d+-p\d+$/.test(s) ? '' : s;
    }

    /**
     * 单条记忆：2px 重要度竖条 + 正文（2 行 clamp，整行 button 展开）+ 元信息。
     * 整行是 button，键盘可达（§8）；id 与绝对时间落在 title（memjudge_forget 需要 id）。
     */
    function MemoryRow({ r }) {
      const [open, setOpen] = useState(false);
      const tier = impTier(r.importance);
      const created = Number(r.created);
      const accessed = Number(r.accessed);
      const showAccessed = Number.isFinite(accessed) && Number.isFinite(created) && accessed > created;
      const text = typeof r.text === 'string' ? r.text : '';
      const src = sourceText(r.source);
      const impText = Number.isFinite(Number(r.importance)) && Number(r.importance) >= 0.3
        ? '重要 ' + Number(r.importance).toFixed(2) : '';
      return h('button', {
        type: 'button',
        className: 'mj-memrow',
        onClick: () => setOpen((v) => !v),
        'aria-expanded': open ? 'true' : 'false',
        title: (r.id || '') + (Number.isFinite(created) ? '\n' + absTime(created) : ''),
        style: {
          display: 'flex', width: '100%', textAlign: 'left', gap: 8, alignItems: 'stretch',
          padding: '8px 0', border: 'none', background: 'transparent',
          color: C.fg, fontFamily: 'inherit', cursor: 'pointer', borderRadius: C.radiusSm,
        },
      },
        h('span', {
          'aria-hidden': 'true',
          style: { flex: '0 0 2px', width: 2, background: impColor(tier), borderRadius: 2 },
        }),
        h('span', { style: { flex: '1 1 auto', minWidth: 0, display: 'block' } },
          h('span', {
            style: open
              ? { display: 'block', fontSize: 13, lineHeight: '1.55', color: C.fg, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
              : {
                display: '-webkit-box',
                fontSize: 13, lineHeight: '1.55', color: C.fg,
                WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word',
              },
          }, text ? text : h('span', { style: { color: C.fg3 } }, '（空条目）')),
          h('span', { className: 'mj-meta', style: { marginTop: 3 } },
            h('span', { style: { fontSize: 12, lineHeight: '1.5', color: C.fg2 } }, relTime(r.created)),
            impText ? h('span', { style: { fontSize: 12, lineHeight: '1.5', color: C.fg2 } }, '· ' + impText) : null,
            showAccessed
              ? h('span', { style: { fontSize: 12, lineHeight: '1.5', color: C.fg2 } }, '· 最近访问 ' + relTime(r.accessed))
              : null,
            src
              ? h('span', {
                title: src,
                style: {
                  fontSize: 12, lineHeight: '1.5', color: C.fg2,
                  flex: '0 1 auto', minWidth: 0, maxWidth: 180,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                },
              }, '· 来自 ' + src)
              : null)));
    }

    // --------------------------------------------------------- 右栏 tab

    // tab 类型 id 同时是 body seat 的 key；kind 全局唯一，避免与内置/他人撞车。
    var SIDEBAR_ID = 'dsh-memjudge';

    // 右栏正文只负责撑满高度与纵向滚动；内边距由面板自己按容器宽度给（§7），
    // 这里再加一层水平 padding 会在窄栏里叠成双层留白。
    function SidebarPane({ rpc }) {
      return h('div', { style: { height: '100%', overflowY: 'auto', overflowX: 'hidden' } },
        h(MemjudgePanel, { rpc: rpc }));
    }

    // 注册右栏 tab 类型 + 正文。返回 disposer；服务缺失时返回空操作。
    function registerSidebarTab(ctx, rpcCall) {
      var handle;
      try {
        handle = ctx.inject(['sidebarRightTabs'], (injected) => {
          var disposers = [];
          var own = (r) => { if (typeof r === 'function') disposers.push(r); };
          var release = () => {
            for (var i = disposers.length - 1; i >= 0; i--) {
              try { disposers[i](); } catch (e) { /* 已释放 */ }
            }
            disposers.length = 0;
          };
          try {
            var tabs = injected && injected.sidebarRightTabs;
            if (!tabs || typeof tabs.register !== 'function') return;
            own(tabs.register({
              id: SIDEBAR_ID,
              kind: SIDEBAR_ID,
              title: () => '记忆库',
              guide: [{
                id: SIDEBAR_ID,
                order: 60,
                title: () => '记忆库',
                description: () => '库体占用、增强模块开关、三元组冲突候选',
              }],
            }));
            own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register({
              name: 'sidebar.right.pane.tab',
              key: SIDEBAR_ID,
            }, () => h(SidebarPane, { rpc: rpcCall }))));
          } catch (e) {
            // id 被占、registry 抛错、seat 不可用：只收起右栏登记，不影响设置面板。
            release();
            return;
          }
          return release;
        });
      } catch (e) {
        return;
      }
      return () => { if (handle && typeof handle.dispose === 'function') handle.dispose(); };
    }

    // ------------------------------------------------------------ apply

    function apply(ctx) {
      // host 侧 src/rpc.mjs 以 { authority: 'loopback' } 注册通道，浏览器侧连接必须自报
      // loopback 才被放行。必须在任何 rpc 调用之前完成；严格模式下 defineProperty 可能
      // 失败（对象被冻结），退回直接赋值。
      if (ctx && ctx.connection) {
        try {
          Object.defineProperty(ctx.connection, 'isLoopback', { value: true, writable: true, configurable: true });
        } catch (e) {
          try { ctx.connection.isLoopback = true; } catch (e2) { /* 无法打标，rpc 会由宿主拒绝 */ }
        }
      }
      const rpcCall = (endpoint, payload) => {
        try {
          return ctx.connection.rpc.call(CHANNEL, endpoint, payload, undefined);
        } catch (e) {
          console.log('[memjudge] rpc 调用失败', CHANNEL, endpoint, e);
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

      // 右栏独立一条 effect：装配失败只让这一条失效，设置面板照旧挂载。
      ctx.effect(() => registerSidebarTab(ctx, rpcCall), 'memjudge: sidebar right tab');
    }

    exports.name = 'dsh-memjudge';
    exports.apply = apply;
    // connection：RPC 客户端服务，缺失时 ctx.connection 为 undefined，三个端点全挂。
    exports.inject = ['slots', 'connection'];
    return module.exports;
  },
});
