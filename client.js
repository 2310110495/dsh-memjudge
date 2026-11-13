/**
 * memjudge —— DeepSeek Harness 前端半侧（浏览器）
 *
 * 在「系统设置」左侧栏注册一个「记忆库」入口（与通用设置/模型/插件管理同级）；
 * 另在对话右侧栏（sidebar.right）注册同名 tab，正文复用同一个面板组件。
 * 数据走宿主同源 Fetch 路由：POST /api/memjudge.<endpoint>，
 * 对应 host 半侧 src/rpc.mjs 用 ctx.connection.fetch.register 注册的 exact 路由。
 * 同源请求自动带浏览器会话 cookie，不再需要旧式通道调用与 loopback 标记。
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

    // host 侧 src/rpc.mjs 为每条端点注册 /api/memjudge.<endpoint> 的 exact 路由。
    const RPC_PATH_PREFIX = '/api/memjudge.';

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
      accent: 'var(--dsw-static-accent-500, var(--dsw-alias-button-primary-fill))',
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
     * 掩码降级：该组已配置但服务端没回 keyMasked 时，不能显示空字符串
     * （用户会以为没生效），也不能显示「未配置」。给出明确的中性说明。
     */
    function maskOf(view) {
      if (!view || !view.keyConfigured) return '—';
      const m = view.keyMasked;
      return (typeof m === 'string' && m.trim()) ? m.trim() : '（服务端未返回掩码）';
    }

    /** 一组密钥的来源短标：面板上必须一眼看出「自己的 / 继承的 / 环境变量钉死的」。 */
    function keySourceLabel(view) {
      if (view.keyEnvLocked) return '环境变量锁定';
      if (view.keyInherited) return '继承对话模型';
      if (view.keySource === 'env') return '环境变量';
      if (view.keySource === 'secrets.json') return '本机 secrets.json';
      if (view.keySource === 'override') return '运行时覆盖';
      return view.keyConfigured ? '来源未知' : '未配置';
    }

    // Model actions never render exception text or provider response bodies.
    function modelError(res) {
      const code = res && (res.code || (res.error && res.error.code));
      const labels = {
        'missing-key': '未配置密钥', disabled: '该组已禁用',
        'incomplete-config': '端点或模型为空', 'bad-request': '参数无效，请检查输入',
        'invalid-response': '响应结构或内容无效', 'http-error': '服务返回 HTTP 错误',
        'network-error': '网络请求失败', timeout: '请求超时',
      };
      return labels[code] || '调用失败，请重试';
    }

    function modelSaved(res) {
      return !!(res && res.ok === true && !(res.value && res.value.ok === false));
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
    function countLabel(mems, stats, shownCount) {
      const list = (mems && (Array.isArray(mems.items) ? mems.items : mems.rows)) || [];
      const n = Number.isFinite(shownCount) ? shownCount : list.length;
      const total = (mems && Number.isFinite(mems.total)) ? mems.total
        : (stats && Number.isFinite(stats.memories)) ? stats.memories : n;
      const desc = !!(mems && mems.order === 'desc');
      if (n === 120 && total > 120) {
        return (desc ? '最新 120 条' : '显示最早 120 条') + ' · 共 ' + fmt(total) + ' 条';
      }
      if (total > n && n >= 0) {
        return '显示 ' + fmt(n) + ' / 共 ' + fmt(total) + ' 条';
      }
      return fmt(n) + ' 条';
    }

    // ----------------------------------------------------- v2 范畴、层级与空间元数据

    const CATEGORIES = [
      { id: 'rule', label: '铁律', short: '铁律', en: 'rule', color: C.bad, borderColor: C.bad, desc: '不可违背的硬约束与约定（L0 常驻）' },
      { id: 'profile', label: '画像', short: '画像', en: 'profile', color: C.accent, borderColor: C.accent, desc: '用户身份、习惯偏好与环境底座（L0 常驻）' },
      { id: 'decision', label: '决策', short: '决策', en: 'decision', color: C.warn, borderColor: C.warn, desc: '架构选型、技术取舍与项目裁决' },
      { id: 'experience', label: '经验', short: '经验', en: 'experience', color: C.fg2, borderColor: C.line3, desc: '实践教训、排障记录与一般事件' },
      { id: 'state', label: '单活状态', short: '单活状态', en: 'state', color: C.ok, borderColor: C.ok, desc: '按 slotKey 原地覆写的当前活跃状态（L0 常驻）' },
    ];

    const CATEGORY_MAP = (() => {
      const out = {};
      for (const c of CATEGORIES) out[c.id] = c;
      return out;
    })();

    const LAYERS = [
      { id: 'L0', num: 0, label: 'L0', name: '恒温', color: C.bad, borderColor: C.bad, desc: 'L0 核心恒温层：铁律/画像/单活状态，豁免衰减' },
      { id: 'L1', num: 1, label: 'L1', name: '活跃', color: C.ok, borderColor: C.ok, desc: 'L1 温水原子层：近期活跃，动态检索直命中' },
      { id: 'L2', num: 2, label: 'L2', name: '知识', color: C.warn, borderColor: C.warn, desc: 'L2 聚类知识层：沉淀编译进持久化 Wiki 页' },
      { id: 'L3', num: 3, label: 'L3', name: '归档', color: C.fg3, borderColor: C.line3, desc: 'L3 冷压缩层：多对一高倍浓缩归档' },
    ];

    const LAYER_MAP = (() => {
      const out = {};
      for (const l of LAYERS) out[l.id] = l;
      return out;
    })();

    function resolveItemCategory(r) {
      if (!r || typeof r !== 'object') return null;
      if (typeof r.category === 'string' && CATEGORY_MAP[r.category]) return r.category;
      if (r.kind === 'promise') return 'rule';
      if (r.kind === 'person') return 'profile';
      if (r.kind === 'event') return 'experience';
      return null;
    }

    function resolveItemLayer(r) {
      if (!r || typeof r !== 'object') return null;
      if (typeof r.layer === 'string') {
        const up = r.layer.trim().toUpperCase();
        if (LAYER_MAP[up]) return up;
      }
      if (Number.isInteger(r.lTier) && r.lTier >= 0 && r.lTier <= 3) return 'L' + r.lTier;
      if (Number.isInteger(r.tier) && r.tier >= 0 && r.tier <= 3) return 'L' + r.tier;
      return null;
    }

    function canDemoteMemory(r) {
      if (!r || typeof r !== 'object' || !r.id) return false;
      const cat = resolveItemCategory(r);
      const layer = resolveItemLayer(r);
      if (layer === 'L0') return true;
      if (cat && cat !== 'experience') return true;
      if (r.kind === 'person' || r.kind === 'promise') return true;
      return false;
    }

    /** 提取工作区友好路径标签：优先可读目录尾段，避免裸露 workspace:hex 哈希。 */
    function friendlyPathTail(rawPath) {
      const s = typeof rawPath === 'string' ? rawPath.trim().replace(/\\/g, '/').replace(/\/+$/, '') : '';
      if (!s) return '';
      const parts = s.split('/').filter(Boolean);
      if (parts.length === 0) return s;
      if (parts.length === 1) return parts[0];
      const last2 = parts.slice(-2).join('/');
      return last2.length <= 36 ? last2 : parts[parts.length - 1];
    }

    function friendlySpaceLabel(sp) {
      if (!sp) return '全局';
      if (typeof sp === 'string') {
        if (sp === 'all') return '全部空间';
        if (sp === 'global') return '全局';
        if (/^workspace:/i.test(sp)) {
          const tail = sp.slice('workspace:'.length);
          return '工作区 ' + (tail.length > 8 ? tail.slice(0, 8) + '…' : tail);
        }
        return sp;
      }
      const id = String(sp.spaceId || sp.id || '');
      if (!id || id === 'global') return '全局';
      if (id === 'all') return '全部空间';
      const fromRoot = friendlyPathTail(sp.rootPath);
      if (fromRoot) return fromRoot;
      const lbl = typeof sp.label === 'string' ? sp.label.trim() : '';
      if (lbl && lbl.toLowerCase() !== id.toLowerCase()) {
        const fromLbl = friendlyPathTail(lbl);
        return fromLbl || lbl;
      }
      if (/^workspace:/i.test(id)) {
        const tail = id.slice('workspace:'.length);
        return '工作区 ' + (tail.length > 8 ? tail.slice(0, 8) + '…' : tail);
      }
      return id;
    }

    function buildSpaceOptions(rawSpaces, stats, allItems, activeSpace) {
      const list = Array.isArray(rawSpaces) ? rawSpaces : [];
      const seen = new Set();
      let globalEntry = null;
      const workspaces = [];
      let sumKnown = 0;

      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const id = String(raw.spaceId || raw.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const cnt = Number.isFinite(Number(raw.memoryCount)) ? Number(raw.memoryCount) : null;
        if (cnt !== null) sumKnown += cnt;
        if (id === 'global') {
          globalEntry = {
            id: 'global',
            kind: 'global',
            label: '全局 (global)',
            shortLabel: '全局',
            rootPath: '',
            count: cnt,
          };
        } else {
          const friendly = friendlySpaceLabel(raw);
          workspaces.push({
            id: id,
            kind: raw.kind || (id.indexOf('workspace:') === 0 ? 'workspace' : 'custom'),
            label: friendly,
            shortLabel: friendly,
            rootPath: typeof raw.rootPath === 'string' ? raw.rootPath : '',
            rawLabel: typeof raw.label === 'string' ? raw.label : '',
            count: cnt,
          });
        }
      }

      if (Array.isArray(allItems)) {
        for (const it of allItems) {
          const spId = it && typeof it.spaceId === 'string' ? it.spaceId.trim() : '';
          if (spId && spId !== 'global' && !seen.has(spId)) {
            seen.add(spId);
            workspaces.push({
              id: spId,
              kind: spId.indexOf('workspace:') === 0 ? 'workspace' : 'custom',
              label: friendlySpaceLabel(spId),
              shortLabel: friendlySpaceLabel(spId),
              rootPath: '',
              rawLabel: '',
              count: null,
            });
          }
        }
      }

      if (activeSpace && activeSpace !== 'all' && activeSpace !== 'global' && !seen.has(activeSpace)) {
        workspaces.push({
          id: activeSpace,
          kind: activeSpace.indexOf('workspace:') === 0 ? 'workspace' : 'custom',
          label: friendlySpaceLabel(activeSpace),
          shortLabel: friendlySpaceLabel(activeSpace),
          rootPath: '',
          rawLabel: '',
          count: null,
        });
      }

      const totalCount = (stats && Number.isFinite(Number(stats.memories)))
        ? Number(stats.memories)
        : (list.length > 0 ? sumKnown : null);

      const out = [
        { id: 'all', kind: 'all', label: '全部空间', shortLabel: '全部空间', rootPath: '', count: totalCount },
        globalEntry || { id: 'global', kind: 'global', label: '全局 (global)', shortLabel: '全局', rootPath: '', count: null },
      ];
      for (const ws of workspaces) out.push(ws);
      return out;
    }

    /** 将行内 `code` 拆分为安全的 React 节点序列，零 HTML 注入风险。 */
    function renderInlineCode(line, keyPrefix) {
      const s = String(line == null ? '' : line);
      if (s.indexOf('`') < 0) return s;
      const parts = s.split(/(`[^`]+`)/g);
      const out = [];
      for (let i = 0; i < parts.length; i += 1) {
        const seg = parts[i];
        if (!seg) continue;
        if (seg.length >= 2 && seg.charAt(0) === '`' && seg.charAt(seg.length - 1) === '`') {
          out.push(h('code', {
            key: keyPrefix + ':c' + i,
            style: {
              fontFamily: C.mono, fontSize: 12, padding: '1px 5px',
              background: C.layer1, border: '1px solid ' + C.line2, borderRadius: 4, color: C.fg,
            },
          }, seg.slice(1, -1)));
        } else {
          out.push(seg);
        }
      }
      return out;
    }

    /** 安全渲染 Wiki 知识页结构化摘要 / Markdown 正文（纯 createElement，严禁 innerHTML）。 */
    function renderStructuredMarkdown(raw) {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (!text) return h(Hint, null, '（暂无摘要正文）');
      const lines = text.split(/\r?\n/);
      const nodes = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) {
          nodes.push(h('div', { key: 'sp' + i, style: { height: 6 } }));
          continue;
        }
        const hMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
        if (hMatch) {
          const lvl = hMatch[1].length;
          nodes.push(h('div', {
            key: 'h' + i,
            style: {
              fontSize: lvl <= 2 ? 13 : 12,
              fontWeight: 600,
              color: C.fg,
              marginTop: i === 0 ? 0 : 8,
              marginBottom: 3,
              lineHeight: '1.45',
            },
          }, renderInlineCode(hMatch[2], 'h' + i)));
          continue;
        }
        const bMatch = /^[-*•]\s+(.+)$/.exec(trimmed);
        if (bMatch) {
          nodes.push(h('div', {
            key: 'b' + i,
            style: {
              display: 'flex', alignItems: 'flex-start', gap: 6,
              fontSize: 13, lineHeight: '1.55', color: C.fg, marginTop: 2, wordBreak: 'break-word',
            },
          },
            h('span', { 'aria-hidden': 'true', style: { color: C.fg2, flex: '0 0 auto' } }, '•'),
            h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, renderInlineCode(bMatch[1], 'b' + i))));
          continue;
        }
        nodes.push(h('div', {
          key: 'p' + i,
          style: { fontSize: 13, lineHeight: '1.55', color: C.fg, marginTop: 2, wordBreak: 'break-word' },
        }, renderInlineCode(trimmed, 'p' + i)));
      }
      return h('div', { className: 'mj-wikibody' }, nodes);
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
      '.mj-budgetgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
      '.mj-num{font-size:20px;line-height:1.2;font-weight:600;font-variant-numeric:tabular-nums}',
      '.mj-modrow{display:flex;align-items:center;gap:10px;padding:8px 0}',
      '.mj-modname{flex:0 0 96px;width:96px;min-width:0}',
      '.mj-moddesc{flex:1 1 auto;min-width:0}',
      '.mj-switchwrap{flex:0 0 auto;margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:2px;min-width:0;max-width:46%}',
      '.mj-keyrow{display:flex;align-items:center;gap:8px}',
      '.mj-keyinput{flex:1 1 auto;min-width:0;position:relative;display:flex}',
      '.mj-keyact{display:flex;align-items:center;gap:8px}',
      '.mj-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mj-pillbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.mj-pill{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:0 10px;box-sizing:border-box}',
      '.mj-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mj-memcard{border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 0}',
      '.mj-memcard:last-child{border-bottom:none}',
      // 凭证分组之间的分隔线由 CSS 承担：内联值优先级高于 @container，窄档就收不紧了。
      '.mj-credgroup+.mj-credgroup,.mj-globalblock{margin-top:12px;padding-top:12px;'
        + 'border-top:1px solid var(--dsw-alias-border-l1)}',
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
        + '.mj-pill:focus-visible,.mj-fold:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}',
      '.mj-scroll{scrollbar-width:thin;overscroll-behavior:contain}',
      '.mj-scroll::-webkit-scrollbar{width:8px;height:8px}',
      '.mj-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border-radius:999px}',
      '@container memjudge (max-width:520px){'
        + '.mj-panel{padding:16px 20px 32px}'
        + '.mj-sec{margin-top:12px}'
        + '.mj-card{padding:10px 12px}'
        + '.mj-grid{grid-template-columns:repeat(2,minmax(0,1fr))}'
        + '.mj-budgetgrid{grid-template-columns:minmax(0,1fr)}'
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
        + '.mj-credgroup+.mj-credgroup,.mj-globalblock{margin-top:10px;padding-top:10px}'
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
     * lockedReason 由调用方给（能点名环境变量名时就点名），缺省用通用文案。
     * ariaLabel 与 label 分开：三组都有「接口地址」，可访问名必须带上组名才唯一。
     * 密钥不归它管：密钥有自己的密码框 + 显隐按钮（keyBlock）。
     */
    function TextField({
      label, value, onChange, placeholder, hint, mono, disabled, locked, lockedReason,
      ariaLabel, type, inputMode, maxLength, disabledReason,
    }) {
      const off = !!disabled || !!locked;
      const lockText = lockedReason || '该项由环境变量决定，改面板不生效';
      const reason = locked ? lockText : disabled ? (disabledReason || '正在保存，稍候') : undefined;
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
            'aria-label': ariaLabel || label,
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
            locked ? (hint ? ' ' + lockText : lockText) : '')
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
    // 三组独立凭据：对话 / 向量 / 重排可以来自三家不同供应商，端点、密钥、模型名互不串用。
    // 面板按组渲染子块；存储口径与写入闸门是全局项，不属于任何组，留在本卡末尾。
    //
    // 回读（configReport）是唯一真值来源，这里只放「恢复默认」用的出厂值。
    // 出厂值必须与 src/config.mjs 的 load() 默认分支逐字一致，否则按回去的是另一套配置。

    /** 组名即后端 group 参数；title/desc 只用于面板文案，不参与请求。 */
    const CRED_GROUPS = [
      { id: 'chat', title: '对话模型', desc: '查询扩展、LLM 选段与提取、面板的测试连接都走这一组。' },
      { id: 'embed', title: '向量模型', desc: '向量召回用这一组；可显式选择继承对话端点与密钥，模型名独立。' },
      { id: 'rerank', title: '重排模型', desc: '精排重打分用这一组；可独立配置或显式继承对话端点与密钥。' },
    ];

    /** 组 → 九项白名单里的键名（与 src/config.mjs 的 SETTING_ENV 同一套，别在此处另造命名）。 */
    const GROUP_KEYS = {
      chat: { baseUrl: 'chatBaseUrl', model: 'chatModel' },
      embed: { baseUrl: 'embedBaseUrl', model: 'embedModel' },
      rerank: { baseUrl: 'rerankBaseUrl', model: 'rerankModel' },
    };

    /** 反向表：九项键 → 组，供 settingText 从 groups 的生效值取文本。 */
    const GROUP_OF_SETTING = (() => {
      const out = {};
      for (const [group, keys] of Object.entries(GROUP_KEYS)) {
        out[keys.baseUrl] = group;
        out[keys.model] = group;
      }
      return out;
    })();

    const SETTING_DEFAULTS = {
      chatBaseUrl: '',
      chatModel: 'deepseek-ai/DeepSeek-V4-Flash',
      embedBaseUrl: '',
      embedModel: 'Qwen/Qwen3-Embedding-8B',
      rerankBaseUrl: '',
      rerankModel: 'Qwen/Qwen3-Reranker-8B',
      dims: '64',
      storageLimitBytes: '10240',
      maxChars: '0',
    };

    /**
     * 九项输入的渲染表：group 决定它落在哪个子块，null = 全局项。
     * dims 归向量组（只对向量模型有意义）；顺序即组内顺序。
     */
    const SETTING_ROWS = [
      {
        group: 'chat', key: 'chatBaseUrl', label: '接口地址', mono: true,
        placeholder: 'https://api.siliconflow.cn/v1',
        hint: 'OpenAI 兼容的 /v1 根地址。改完立刻生效，无需重启。',
      },
      {
        group: 'chat', key: 'chatModel', label: '模型名', mono: true,
        hint: '查询扩展、LLM 选段/提取与测试连接都用它。',
      },
      {
        group: 'embed', key: 'embedBaseUrl', label: '接口地址', mono: true,
        placeholder: 'https://api.siliconflow.cn/v1',
        hint: '向量模型的 /v1 根地址，可与对话模型不同家。',
      },
      {
        group: 'embed', key: 'embedModel', label: '模型名', mono: true,
        hint: '换模型会重建向量缓存，旧向量不会串用。',
      },
      {
        group: 'embed', key: 'dims', label: '向量维度', inputMode: 'numeric',
        hint: '须与向量模型输出维度一致。',
      },
      {
        group: 'rerank', key: 'rerankBaseUrl', label: '接口地址', mono: true,
        placeholder: 'https://api.siliconflow.cn/v1',
        hint: '重排模型的 /v1 根地址，可与前两组不同家。',
      },
      {
        group: 'rerank', key: 'rerankModel', label: '模型名', mono: true,
        hint: '重排接口按它发 query 与 documents。',
      },
      {
        group: null, key: 'storageLimitBytes', label: '存储上限', inputMode: 'numeric', kb: true,
        hint: '仅统计口径，超过会标红但不会阻止写入。',
      },
      {
        group: null, key: 'maxChars', label: '写入硬限', inputMode: 'numeric',
        hint: '0 = 不设限。设为正数后超限的写入会被拒绝，不截断。',
      },
    ];

    /**
     * 一组的回读视图。新后端给 config.groups[group]（掩码 + 来源 + 继承 + env 锁）；
     * 老后端没有 groups 时降级：chat 用顶层同义字段，embed / rerank 视为未配置。
     * 有这层降级，面板不会因为后端版本不一致而白屏。
     */
    function groupView(cfg, group) {
      const empty = {
        mode: 'legacy', migrationRequired: true, enabled: true, inheritedEnv: {},
        baseUrl: '', baseUrlSource: '', baseUrlInherited: false, baseUrlEnv: null,
        model: '', modelSource: '', modelEnv: null,
        keyConfigured: false, keyMasked: '', keySource: 'none', keyInherited: false, keyEnvLocked: false,
      };
      if (!cfg) return empty;
      const raw = cfg.groups && typeof cfg.groups === 'object' ? cfg.groups[group] : null;
      if (raw && typeof raw === 'object') return Object.assign({}, empty, raw);
      if (group === 'chat') {
        return Object.assign({}, empty, {
          baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
          model: typeof cfg.chatModel === 'string' ? cfg.chatModel : '',
          keyConfigured: !!cfg.hasKey,
          keyMasked: typeof cfg.keyMasked === 'string' ? cfg.keyMasked : '',
          keySource: typeof cfg.keySource === 'string' ? cfg.keySource : 'none',
        });
      }
      return Object.assign({}, empty, {
        model: typeof cfg[group + 'Model'] === 'string' ? cfg[group + 'Model'] : '',
      });
    }

    /** 一组密钥来源的一句话说明：自己的 / 继承的 / 环境变量里的，三种不能混着说。 */
    function keySourceHint(cfg, group, view) {
      const spec = cfg && cfg.credSpec ? cfg.credSpec[group] : null;
      const keyEnvName = view.keyEnv || (spec && Array.isArray(spec.keyEnv) && spec.keyEnv.length ? spec.keyEnv[0] : '');
      if (view.keyEnvLocked) {
        return '密钥由环境变量 ' + (keyEnvName || 'MEMJUDGE_*_KEY') + ' 决定，面板写入不生效。';
      }
      if (view.keyInherited) return (view.keySource === 'legacy-inherit' ? '旧配置兼容继承，尚未主动选择模式。' : '显式继承对话密钥。')
        + (view.inheritedEnv && view.inheritedEnv.key ? '继承源锁：' + view.inheritedEnv.key + '。' : '')
        + '先保存独立模式，再配置本组密钥；清除会退出继承。';
      if (view.keySource === 'env') {
        return '来自环境变量' + (keyEnvName ? ' ' + keyEnvName : '') + '，换机器需重新配置。';
      }
      if (view.keyConfigured) return '存于本机 secrets.json，只属于这一组。';
      return '未配置：这一组的增强能力保持关闭。';
    }

    /** 端点/模型名的环境变量名（后端给了就点名，让用户知道该去改哪个变量）。 */
    function settingEnvName(view, key, group) {
      if (GROUP_KEYS[group].baseUrl === key) return view.baseUrlEnv || '';
      if (GROUP_KEYS[group].model === key) return view.modelEnv || '';
      return '';
    }

    /** 回读值 → 输入框文本。端点/模型名取 groups 的生效值；存储上限按 KB 取整。 */
    function settingText(key, cfg) {
      if (!cfg) return '';
      const group = GROUP_OF_SETTING[key];
      if (group) {
        const view = groupView(cfg, group);
        const raw = GROUP_KEYS[group].baseUrl === key ? view.baseUrl : view.model;
        return raw == null ? '' : String(raw);
      }
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

    // 每项增强看自己那一组密钥：向量要 embed、精排要 rerank、其余三项走 chat。
    // group 字段与 src/config.mjs 的 moduleFlags() 判定同源，面板据此把「先填密钥」
    // 指向真正缺 key 的那一组，而不是一律指向对话模型。
    const MODULES = [
      { key: 'jieba', name: 'jieba 分词', desc: '搜索引擎模式切词，替代 CJK 二元组', readonly: true },
      { key: 'vector', name: '向量融合', desc: 'Qwen3-Embedding-8B 64 维 int8，BM25+RRF', gated: true, group: 'embed' },
      { key: 'rerank', name: '精排 rerank', desc: 'Qwen3-Reranker-8B（综合题实测零增量）', gated: true, group: 'rerank' },
      { key: 'expand', name: '查询扩展', desc: 'LLM 拆子查询', gated: true, group: 'chat' },
      { key: 'llmSelect', name: 'LLM 选段', desc: '候选段交模型挑选', gated: true, group: 'chat' },
      { key: 'llmExtract', name: 'LLM 提取', desc: '离线重建 facts', gated: true, group: 'chat' },
    ];

    const NO_KEY_TITLE = '这一项要调外部模型，但它所属的那一组还没有密钥：开着只会在每次检索时等超时，所以先关着。';

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
        right.push(h(Link, { key: 'nk', onClick: onNeedKey },
          m.groupName ? '先填' + m.groupName + '密钥' : '先填密钥'));
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

    function useEndpoint(rpc, endpoint, customPayload, depsKey) {
      const [state, setState] = useState({ phase: 'loading', data: null, error: '' });
      const alive = useRef(true);
      const payloadRef = useRef(customPayload || ENDPOINT_PAYLOAD[endpoint]);
      payloadRef.current = customPayload || ENDPOINT_PAYLOAD[endpoint];
      // 重新挂载时必须把标记置回 true，否则 StrictMode 下第一次 cleanup 之后
      // 所有落地回调都被丢弃，面板永远停在「读取中…」。
      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);
      const load = useCallback((overridePayload) => {
        setState((prev) => ({ phase: 'loading', data: prev.data, error: '' }));
        const reqPayload = (overridePayload && typeof overridePayload === 'object' && !overridePayload.nativeEvent)
          ? overridePayload
          : payloadRef.current;
        let p;
        try {
          p = rpc(endpoint, reqPayload);
        } catch (e) {
          p = Promise.reject(e);
        }
        return Promise.resolve(p).then((res) => {
          if (!alive.current) return null;
          if (res && res.ok) {
            setState({ phase: 'ready', data: res.value || null, error: '' });
            return res.value || null;
          }
          setState({ phase: 'error', data: null, error: endpoint === 'status' ? modelError(res) : errMsg(res) });
          return null;
        }, (e) => {
          if (!alive.current) return null;
          setState({ phase: 'error', data: null, error: endpoint === 'status' ? modelError() : (e && e.message ? String(e.message) : String(e)) });
          return null;
        });
      }, [rpc, endpoint, depsKey || '']);
      useEffect(() => { load(); }, [load]);
      return [state, load, setState];
    }

    // -------------------------------------------------------------- 面板

    function MemjudgePanel({ rpc }) {
      ensureCss();

      // ---- v2 作用域、五类范畴、代谢层级、视图与治理状态（全部顶层固定槽位）
      const [activeSpace, setActiveSpace] = useState('all');
      const [activeCategory, setActiveCategory] = useState('all');
      const [activeLayer, setActiveLayer] = useState('all');
      const [searchQuery, setSearchQuery] = useState('');
      const [viewTab, setViewTab] = useState('all');
      const [openMems, setOpenMems] = useState({});
      const [openRevs, setOpenRevs] = useState({});
      const [revCache, setRevCache] = useState({});
      const [openWikis, setOpenWikis] = useState({});
      const [wikiSnapOverride, setWikiSnapOverride] = useState(null);
      const [confirmForgetId, setConfirmForgetId] = useState('');
      const [govBusy, setGovBusy] = useState('');
      const [govFeedback, setGovFeedback] = useState(null);
      const forgetArmTimer = useRef(null);
      const govTimer = useRef(null);

      useEffect(() => () => {
        if (forgetArmTimer.current) clearTimeout(forgetArmTimer.current);
        if (govTimer.current) clearTimeout(govTimer.current);
      }, []);

      const trimmedQuery = searchQuery.trim();
      const statusPayload = activeSpace !== 'all' ? { spaceId: activeSpace } : ENDPOINT_PAYLOAD.status;
      const memPayload = (() => {
        if (activeSpace === 'all' && activeCategory === 'all' && activeLayer === 'all' && !trimmedQuery) {
          return ENDPOINT_PAYLOAD.memories;
        }
        const out = { limit: 120, order: 'desc', v2: true, withRevisions: true };
        if (activeSpace !== 'all') out.spaceId = activeSpace;
        if (activeCategory !== 'all') out.category = activeCategory;
        if (activeLayer !== 'all') out.layer = activeLayer;
        if (trimmedQuery) out.q = trimmedQuery;
        return out;
      })();
      const confPayload = activeSpace !== 'all'
        ? { cap: 40, spaceId: activeSpace }
        : ENDPOINT_PAYLOAD.conflicts;

      const statusDepsKey = activeSpace;
      const memDepsKey = activeSpace + '|' + activeCategory + '|' + activeLayer + '|' + trimmedQuery;
      const confDepsKey = activeSpace;

      const [statusSt, reloadStatus, setStatusSt] = useEndpoint(rpc, 'status', statusPayload, statusDepsKey);
      const [memsSt, reloadMems] = useEndpoint(rpc, 'memories', memPayload, memDepsKey);
      const [confSt, reloadConf] = useEndpoint(rpc, 'conflicts', confPayload, confDepsKey);

      const reloadAll = useCallback(() => {
        setWikiSnapOverride(null);
        reloadStatus(); reloadMems(); reloadConf();
      }, [reloadStatus, reloadMems, reloadConf]);

      const statusData = statusSt.data;
      const memData = memsSt.data;
      const cfg = statusData && statusData.config ? statusData.config : null;
      const stats = statusData && statusData.stats ? statusData.stats : null;
      const rawMemList = memData
        ? (Array.isArray(memData.items)
          ? memData.items
          : (Array.isArray(memData.rows) ? memData.rows : null))
        : null;
      const rows = rawMemList ? rawMemList.filter((r) => {
        if (!r || typeof r !== 'object') return false;
        if (activeSpace !== 'all' && typeof r.spaceId === 'string' && r.spaceId && r.spaceId !== activeSpace) {
          return false;
        }
        if (activeCategory !== 'all') {
          if (resolveItemCategory(r) !== activeCategory) return false;
        }
        if (activeLayer !== 'all') {
          if (resolveItemLayer(r) !== activeLayer) return false;
        }
        if (trimmedQuery) {
          const qLower = trimmedQuery.toLowerCase();
          const hay = [r.text, r.fullText, r.slotKey, r.source, r.id]
            .map((x) => String(x || '').toLowerCase())
            .join('\n');
          if (hay.indexOf(qLower) < 0) return false;
        }
        return true;
      }) : null;
      const conflicts = (confSt.data && Array.isArray(confSt.data.conflicts)) ? confSt.data.conflicts : null;

      // ---- 密钥区状态（§4）——三组各一套，不乐观更新，一切以 status 回读为准
      //
      // 每组独立持有 { input, shown, busy, msg, confirmClear, replacing }：
      // 一组的保存/测试失败绝不能改到另外两组的输入框与反馈——三组常常来自三家供应商，
      // 用一个共享 busy 会让「测 embed 时 chat 的按钮也变灰」这种误导成为常态。
      const KEY_SLOT_INIT = {
        input: '', shown: false, busy: '', msg: null, confirmClear: false, replacing: false,
      };
      const [keyStates, setKeyStates] = useState(() => ({
        chat: Object.assign({}, KEY_SLOT_INIT),
        embed: Object.assign({}, KEY_SLOT_INIT),
        rerank: Object.assign({}, KEY_SLOT_INIT),
      }));
      // 组 → 该组密钥输入框 DOM；「先填密钥」链接要能跳到缺 key 的那一组
      const keyRefs = useRef({});
      const fadeTimers = useRef({});
      const armTimers = useRef({});

      useEffect(() => () => {
        for (const t of Object.values(fadeTimers.current)) clearTimeout(t);
        for (const t of Object.values(armTimers.current)) clearTimeout(t);
        fadeTimers.current = {};
        armTimers.current = {};
      }, []);

      /** 读一组的分片；组名不合法时给一份空白，绝不让 undefined 打进渲染。 */
      const slotOf = useCallback((group) => keyStates[group] || KEY_SLOT_INIT, [keyStates]);

      const patchSlot = useCallback((group, patch) => {
        setKeyStates((prev) => {
          const cur = prev[group] || KEY_SLOT_INIT;
          return Object.assign({}, prev, { [group]: Object.assign({}, cur, patch) });
        });
      }, []);

      const setKeyFeedback = useCallback((group, msg, fade) => {
        patchSlot(group, { msg });
        if (fadeTimers.current[group]) clearTimeout(fadeTimers.current[group]);
        if (fade) {
          fadeTimers.current[group] = setTimeout(() => {
            fadeTimers.current[group] = null;
            patchSlot(group, { msg: null });
          }, 4000);
        }
      }, [patchSlot]);

      /** 二段确认的 5 秒复位；按组各存一个定时器。 */
      const resetConfirm = useCallback((group) => {
        if (armTimers.current[group]) clearTimeout(armTimers.current[group]);
        armTimers.current[group] = null;
        patchSlot(group, { confirmClear: false });
      }, [patchSlot]);

      const pullStatus = useCallback(() => {
        const req = activeSpace !== 'all' ? { spaceId: activeSpace } : {};
        return Promise.resolve(rpc('status', req)).then((res) => {
          if (res && res.ok) { setStatusSt({ phase: 'ready', data: res.value || null, error: '' }); return res.value; }
          setStatusSt({ phase: 'error', data: null, error: modelError(res) });
          return null;
        }, (e) => {
          setStatusSt({ phase: 'error', data: null, error: modelError() });
          return null;
        });
      }, [rpc, setStatusSt, activeSpace]);

      /** 保存一组的密钥：payload 带 group，成功后只重读 status（回读为准），并清掉该组输入。 */
      const saveKeyFor = useCallback((group) => {
        const slot = slotOf(group);
        const v = slot.input.trim();
        if (!v || slot.busy) return;
        patchSlot(group, { busy: 'save' });
        setKeyFeedback(group, null);
        Promise.resolve(rpc('saveKey', { key: v, group })).then((res) => {
          if (!modelSaved(res)) {
            setKeyFeedback(group, { kind: 'err', text: '保存失败：' + modelError(res && (res.value || res)) });
            return null;
          }
          return pullStatus().then((value) => {
            if (!value) { setKeyFeedback(group, { kind: 'err', text: '写入已返回，状态回读失败，请刷新确认。' }); return; }
            patchSlot(group, { input: '', replacing: false, shown: false });
            setKeyFeedback(group, { kind: 'ok', text: '已保存，这一组即刻生效。' }, true);
            return null;
          });
        }, (e) => {
          setKeyFeedback(group, { kind: 'err', text: '保存失败：' + modelError() });
        }).then(() => { patchSlot(group, { busy: '' }); });
      }, [slotOf, patchSlot, rpc, pullStatus, setKeyFeedback]);

      /**
       * 测试一组连通性。后端非 2xx 时外层信封仍是 ok:true，判定必须看内层
       * value.ok —— 那是「测试结果」，fail() 才是「调用方式错了」。
       * 输入框里有未保存的值就带上测它，否则后端用该组已存/继承/环境变量里的 key。
       */
      const testKeyFor = useCallback((group) => {
        const slot = slotOf(group);
        if (slot.busy || groupView(cfg, group).mode === 'disabled') return;
        patchSlot(group, { busy: 'test' });
        setKeyFeedback(group, null);
        const payload = { group };
        const typed = slot.input.trim();
        if (typed) payload.key = typed;
        Promise.resolve(rpc('testKey', payload)).then((res) => {
          if (!(res && res.ok)) {
            setKeyFeedback(group, { kind: 'err', text: '连接失败：' + modelError(res) });
            return;
          }
          const v = res.value || {};
          if (v.ok === true) {
            setKeyFeedback(group, {
              kind: 'ok',
              text: '连接正常 · ' + (Number.isFinite(v.latencyMs) ? v.latencyMs : '—')
                + ' ms',
            });
          } else {
            // Only stable error codes reach the UI; provider bodies stay private.
            setKeyFeedback(group, {
              kind: 'err',
              text: '连接失败：' + modelError(v),
            });
          }
        }, (e) => {
          setKeyFeedback(group, { kind: 'err', text: '连接失败：' + modelError() });
        }).then(() => { patchSlot(group, { busy: '' }); });
      }, [slotOf, patchSlot, rpc, setKeyFeedback, cfg]);

      /** 清除一组密钥，二段确认（5 秒内再点一次）。 */
      const clearKeyFor = useCallback((group) => {
        const slot = slotOf(group);
        if (slot.busy) return;
        if (!slot.confirmClear) {
          patchSlot(group, { confirmClear: true });
          if (armTimers.current[group]) clearTimeout(armTimers.current[group]);
          armTimers.current[group] = setTimeout(() => {
            armTimers.current[group] = null;
            patchSlot(group, { confirmClear: false });
          }, 5000);
          return;
        }
        resetConfirm(group);
        patchSlot(group, { busy: 'clear' });
        setKeyFeedback(group, null);
        Promise.resolve(rpc('clearKey', { group })).then((res) => {
          if (!modelSaved(res)) {
            setKeyFeedback(group, { kind: 'err', text: '清除失败：' + modelError(res && (res.value || res)) });
            return null;
          }
          return pullStatus().then((value) => {
            if (!value) { setKeyFeedback(group, { kind: 'err', text: '写入已返回，状态回读失败，请刷新确认。' }); return; }
            patchSlot(group, { input: '', replacing: false, shown: false });
            setKeyFeedback(group, { kind: 'ok', text: '这一组的密钥已清除。' }, true);
            return null;
          });
        }, (e) => {
          setKeyFeedback(group, { kind: 'err', text: '清除失败：' + modelError() });
        }).then(() => { patchSlot(group, { busy: '' }); });
      }, [slotOf, patchSlot, resetConfirm, rpc, pullStatus, setKeyFeedback]);

      /** 把焦点送到某一组的密钥输入框（「先填密钥」链接与替换态共用）。 */
      const focusGroupKey = useCallback((group) => {
        patchSlot(group, { replacing: true });
        const el = keyRefs.current[group];
        if (!el) return;
        try { if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); } catch (e) { /* 老宿主忽略 */ }
        try { el.focus(); } catch (e2) { /* 忽略 */ }
      }, [patchSlot]);

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
        const next = {};
        for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
          if (value !== '' && !(settingsLocked && settingsLocked[key])) next[key] = value;
        }
        setSettingsDraft(next);
      }, [settingsLocked]);

      const saveSettings = useCallback(() => {
        if (settingsBusy) return;
        // Absent and empty drafts are unchanged; null is an explicit clear action.
        const patch = {};
        for (const row of SETTING_ROWS) {
          if (!settingsDraft || !Object.prototype.hasOwnProperty.call(settingsDraft, row.key)) continue;
          if (settingsLocked && settingsLocked[row.key]) continue;
          if (row.group && settingEnvName(groupView(cfg, row.group), row.key, row.group)) continue;
          const cur = settingsDraft[row.key];
          if (cur !== null && (!String(cur).trim() || String(cur) === settingText(row.key, cfg))) continue;
          patch[row.key] = settingValue(row.key, cur);
        }
        for (const g of CRED_GROUPS) {
          const key = g.id + 'Mode';
          const mode = settingsDraft && settingsDraft[key];
          if (['independent', 'disabled', ...(g.id === 'chat' ? [] : ['inherit'])].includes(mode)
              && mode !== groupView(cfg, g.id).mode) patch[key] = mode;
        }
        if (Object.keys(patch).length === 0) {
          setSettingsMsg({ kind: 'info', text: '没有改动需要保存。' });
          return;
        }
        setSettingsBusy(true);
        setSettingsMsg(null);
        Promise.resolve(rpc('saveSettings', { settings: patch })).then((res) => {
          if (!modelSaved(res)) {
            setSettingsMsg({ kind: 'err', text: '保存失败：' + modelError(res && (res.value || res)) });
            return null;
          }
          const vecReset = !!(res.value && res.value.vecCacheReset === true);
          setSettingsDraft(null);
          // 不乐观更新：保存成功也重拉 status，输入框显示的是配置层真正的生效值
          // （被 env 钉住的项写进 config.json 也不会变，只有回读能说出这件事）。
          return pullStatus().then((value) => {
            if (!value) { setSettingsMsg({ kind: 'err', text: '写入已返回，状态回读失败，请刷新确认。' }); return; }
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
          setSettingsMsg({ kind: 'err', text: '保存失败：' + modelError() });
        }).then(() => { setSettingsBusy(false); });
      }, [settingsBusy, settingsDraft, cfg, rpc, pullStatus]);

      // ---- C 区折叠：宽档由 CSS 忽略 data-collapsed，窄档默认收起（§7）
      const [memCollapsed, setMemCollapsed] = useState(true);
      // 同一组件会同时挂在设置页和右栏，aria-controls 的 id 必须按实例唯一。
      const memBodyId = useRef('mj-mem-body-' + Math.random().toString(36).slice(2, 8));

      // ---- v2 治理动作与交互回调
      const showGovMsg = useCallback((kind, text, fadeMs) => {
        setGovFeedback({ kind, text });
        if (govTimer.current) clearTimeout(govTimer.current);
        govTimer.current = null;
        if (fadeMs) {
          govTimer.current = setTimeout(() => {
            govTimer.current = null;
            setGovFeedback(null);
          }, fadeMs);
        }
      }, [setGovFeedback]);

      const selectSpace = useCallback((nextSpace) => {
        const sp = nextSpace || 'all';
        setActiveSpace(sp);
        setConfirmForgetId('');
        setWikiSnapOverride(null);
      }, [setActiveSpace, setConfirmForgetId, setWikiSnapOverride]);

      const refreshWikiView = useCallback((spOverride) => {
        const sp = typeof spOverride === 'string' ? spOverride : activeSpace;
        const req = { action: 'wiki' };
        if (sp && sp !== 'all') req.spaceId = sp;
        return Promise.resolve(rpc('memories', req)).then((res) => {
          if (res && res.ok && res.value && typeof res.value === 'object') {
            setWikiSnapOverride(res.value);
            return res.value;
          }
          return null;
        }, () => null);
      }, [rpc, activeSpace, setWikiSnapOverride]);

      const switchViewTab = useCallback((nextTab) => {
        setViewTab(nextTab);
        if (nextTab === 'wiki') {
          refreshWikiView(activeSpace);
        }
      }, [setViewTab, refreshWikiView, activeSpace]);

      const triggerCompile = useCallback(() => {
        if (govBusy) return;
        setGovBusy('compile');
        setGovFeedback(null);
        const req = { action: 'compile' };
        if (activeSpace !== 'all') req.spaceId = activeSpace;
        Promise.resolve(rpc('memories', req)).then((res) => {
          if (!(res && res.ok)) {
            showGovMsg('err', '知识页编译失败：' + errMsg(res), 0);
            return null;
          }
          const val = res.value || {};
          setWikiSnapOverride(val);
          const cr = val.compileResult || {};
          const compiled = Number.isFinite(Number(cr.compiled)) ? Number(cr.compiled) : (Array.isArray(val.wiki_pages) ? val.wiki_pages.length : 0);
          showGovMsg('ok', '知识页编译完成 · 共更新 ' + fmt(compiled) + ' 页。', 5000);
          reloadAll();
          return null;
        }, () => {
          showGovMsg('err', '知识页编译请求失败，请重试。', 0);
        }).then(() => { setGovBusy(''); });
      }, [govBusy, rpc, activeSpace, reloadAll, showGovMsg]);

      const triggerMetabolism = useCallback(() => {
        if (govBusy) return;
        setGovBusy('metabolism');
        setGovFeedback(null);
        const req = { action: 'metabolism' };
        if (activeSpace !== 'all') req.spaceId = activeSpace;
        Promise.resolve(rpc('memories', req)).then((res) => {
          if (!(res && res.ok)) {
            showGovMsg('err', '执行代谢失败：' + errMsg(res), 0);
            return null;
          }
          const val = res.value || {};
          setWikiSnapOverride(val);
          const acts = (val.metabolism && val.metabolism.actions) || {};
          const l2n = Number(acts.l1DemotedToL2 ?? acts.l2Demoted ?? 0);
          const l3n = Number(acts.l3Archived ?? 0);
          const wn = Number(acts.wikiPagesUpdated ?? acts.wikiCompiled ?? 0);
          const cn = Number(acts.compacted ?? 0);
          showGovMsg(
            'ok',
            '生命周期代谢完成 · L2 沉淀 ' + fmt(l2n) + ' · Wiki 编译 ' + fmt(wn) + ' · L3 归档 ' + fmt(l3n)
              + (cn > 0 ? ' · 压缩 ' + fmt(cn) : '')
              + (acts.vacuumed ? ' · VACUUM' : '') + '。',
            5000,
          );
          reloadAll();
          return null;
        }, () => {
          showGovMsg('err', '执行代谢请求失败，请重试。', 0);
        }).then(() => { setGovBusy(''); });
      }, [govBusy, rpc, activeSpace, reloadAll, showGovMsg]);

      const triggerReindex = useCallback(() => {
        if (govBusy) return;
        setGovBusy('reindex');
        setGovFeedback(null);
        Promise.resolve(rpc('status', { action: 'reindex' })).then((res) => {
          if (!(res && res.ok)) {
            showGovMsg('err', '重建索引失败：' + errMsg(res), 0);
            return null;
          }
          const val = res.value || {};
          const rx = val.reindex || {};
          showGovMsg('ok', '检索索引已重建' + (Number.isFinite(Number(rx.docs)) ? ' · ' + fmt(rx.docs) + ' 条文档' : '') + '。', 5000);
          reloadAll();
          return null;
        }, () => {
          showGovMsg('err', '重建索引请求失败，请重试。', 0);
        }).then(() => { setGovBusy(''); });
      }, [govBusy, rpc, reloadAll, showGovMsg]);

      const toggleMemOpen = useCallback((id) => {
        if (!id) return;
        setOpenMems((prev) => Object.assign({}, prev, { [id]: !prev[id] }));
      }, [setOpenMems]);

      const toggleWikiOpen = useCallback((key) => {
        if (!key) return;
        setOpenWikis((prev) => Object.assign({}, prev, { [key]: prev[key] === false }));
      }, [setOpenWikis]);

      const toggleRevisions = useCallback((item) => {
        if (!item || !item.id) return;
        const id = String(item.id);
        const nextOpen = !openRevs[id];
        setOpenRevs((prev) => Object.assign({}, prev, { [id]: nextOpen }));
        if (!nextOpen) return;
        if (Array.isArray(item.revisions) && item.revisions.length > 0) return;
        if (revCache[id] && (revCache[id].loading || Array.isArray(revCache[id].items))) return;
        setRevCache((prev) => Object.assign({}, prev, { [id]: { loading: true, items: null, error: '' } }));
        Promise.resolve(rpc('memories', { id, withRevisions: true })).then((res) => {
          if (res && res.ok && res.value) {
            const found = res.value.item || (Array.isArray(res.value.items) ? res.value.items[0] : null);
            const revs = found && Array.isArray(found.revisions) ? found.revisions : [];
            setRevCache((prev) => Object.assign({}, prev, { [id]: { loading: false, items: revs, error: '' } }));
          } else {
            setRevCache((prev) => Object.assign({}, prev, { [id]: { loading: false, items: [], error: '无法读取修订记录' } }));
          }
        }, () => {
          setRevCache((prev) => Object.assign({}, prev, { [id]: { loading: false, items: [], error: '无法读取修订记录' } }));
        });
      }, [openRevs, revCache, rpc]);

      const manualReload = useCallback(() => {
        setWikiSnapOverride(null);
        reloadAll();
      }, [setWikiSnapOverride, reloadAll]);

      const demoteItem = useCallback((item) => {
        if (!item || !item.id || govBusy) return;
        const id = String(item.id);
        setGovBusy('demote:' + id);
        setGovFeedback(null);
        Promise.resolve(rpc('memories', { action: 'demote', id })).then((res) => {
          if (!(res && res.ok)) {
            showGovMsg('err', '降级失败：' + errMsg(res), 0);
            return null;
          }
          setWikiSnapOverride(null);
          showGovMsg('ok', '已将记忆 ' + id + ' 降级为普通经验事件（移出常驻底座）。', 4500);
          reloadAll();
          return null;
        }, () => {
          showGovMsg('err', '降级请求失败，请重试。', 0);
        }).then(() => { setGovBusy(''); });
      }, [govBusy, rpc, reloadAll, showGovMsg, setWikiSnapOverride]);

      const armOrRunForget = useCallback((item) => {
        if (!item || !item.id || govBusy) return;
        const id = String(item.id);
        if (confirmForgetId !== id) {
          setConfirmForgetId(id);
          if (forgetArmTimer.current) clearTimeout(forgetArmTimer.current);
          forgetArmTimer.current = setTimeout(() => {
            forgetArmTimer.current = null;
            setConfirmForgetId('');
          }, 5000);
          return;
        }
        if (forgetArmTimer.current) clearTimeout(forgetArmTimer.current);
        forgetArmTimer.current = null;
        setConfirmForgetId('');
        setGovBusy('forget:' + id);
        setGovFeedback(null);
        const req = { action: 'forget', id };
        if (item.spaceId && item.spaceId !== 'all') req.spaceId = item.spaceId;
        Promise.resolve(rpc('memories', req)).then((res) => {
          if (!(res && res.ok)) {
            showGovMsg('err', '物理遗忘失败：' + errMsg(res), 0);
            return null;
          }
          setWikiSnapOverride(null);
          showGovMsg('ok', '已物理遗忘记忆 ' + id + '。', 4500);
          reloadAll();
          return null;
        }, () => {
          showGovMsg('err', '物理遗忘请求失败，请重试。', 0);
        }).then(() => { setGovBusy(''); });
      }, [govBusy, confirmForgetId, rpc, reloadAll, showGovMsg, setWikiSnapOverride]);

      const cancelForget = useCallback(() => {
        if (forgetArmTimer.current) clearTimeout(forgetArmTimer.current);
        forgetArmTimer.current = null;
        setConfirmForgetId('');
      }, [setConfirmForgetId]);

      const resetFilters = useCallback(() => {
        setActiveCategory('all');
        setActiveLayer('all');
        setSearchQuery('');
      }, [setActiveCategory, setActiveLayer, setSearchQuery]);

      // ---- v2 能力探测与归一化视图（旧版 v1/v7 缺省字段时自动平滑降级）
      const isV2 = Boolean(
        (statusData && (
          Number(statusData.schemaVersion) >= 8
          || Array.isArray(statusData.spaces)
          || (statusData.categories && typeof statusData.categories === 'object')
          || (statusData.layers && typeof statusData.layers === 'object')
          || Array.isArray(statusData.wiki_pages)
          || Array.isArray(statusData.pages)
          || Array.isArray(statusData.states)
          || statusData.tierS
          || statusData.tierD
          || statusData.inject
        ))
        || (memData && Array.isArray(memData.items)),
      );

      const spaceOptions = isV2
        ? buildSpaceOptions(statusData && statusData.spaces, stats, rawMemList, activeSpace)
        : [];
      const spaceLabelMap = (() => {
        const map = { all: '全部空间', global: '全局' };
        for (const sp of spaceOptions) map[sp.id] = sp.shortLabel || sp.label;
        return map;
      })();
      const currentSpaceObj = spaceOptions.find((s) => s.id === activeSpace) || null;

      // ---- 头部状态行（§2 三态）
      const allFailed = statusSt.phase === 'error' && memsSt.phase === 'error' && confSt.phase === 'error';
      const anyLoading = statusSt.phase === 'loading' || memsSt.phase === 'loading' || confSt.phase === 'loading';
      const firstLoad = (statusSt.phase === 'loading' && statusSt.data === null)
        || (memsSt.phase === 'loading' && memsSt.data === null)
        || (confSt.phase === 'loading' && confSt.data === null);
      const statusLine = allFailed
        ? '读取失败：' + (statusSt.error || '宿主 RPC 未响应')
        : firstLoad ? '正在读取记忆库…'
          : anyLoading ? '刷新中…'
            : '已连接宿主 RPC' + (isV2 && statusData && statusData.schemaVersion ? ' · v2 (schema v' + statusData.schemaVersion + ')' : '');

      const header = h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontSize: 20, lineHeight: '1.3', fontWeight: 600, color: C.fg } }, '记忆库'),
          h('div', { style: { fontSize: 13, lineHeight: '1.5', color: C.fg2, marginTop: 2 } }, statusLine)),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          isV2 ? h(Btn, {
            onClick: triggerCompile,
            disabled: !!govBusy || anyLoading,
            title: '将当前空间的活跃聚类编译为持久化 L2 知识页',
          }, govBusy === 'compile' ? '编译中…' : '编译知识页') : null,
          isV2 ? h(Btn, {
            onClick: triggerMetabolism,
            disabled: !!govBusy || anyLoading,
            title: '执行 L1→L2 沉淀、脏知识页编译与 L3 归档代谢',
          }, govBusy === 'metabolism' ? '代谢中…' : '执行代谢') : null,
          h(Btn, {
            onClick: manualReload,
            disabled: anyLoading,
            title: '重新拉取库体、记忆与冲突',
          }, anyLoading ? '刷新中…' : '↻ 刷新')));

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

      // ==================================================== 空间切换与治理反馈条
      const scopeSection = isV2 ? h('div', {
        className: 'mj-sec',
        'data-section': 'scope-switcher',
        style: { marginTop: 14 },
      },
        h(Card, { style: { padding: '10px 14px' } },
          h('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
          },
            h('div', {
              className: 'mj-pillbar',
              role: 'group',
              'aria-label': '记忆空间切换',
            },
              spaceOptions.map((sp) => {
                const selected = activeSpace === sp.id;
                const countTxt = sp.count !== null && Number.isFinite(sp.count) ? ' (' + fmt(sp.count) + ')' : '';
                const prefix = sp.kind === 'workspace' ? '工作区 · ' : '';
                const fullTitle = sp.rootPath
                  ? sp.rootPath + ' [' + sp.id + ']'
                  : (sp.id === 'all' ? '查看所有空间的记忆' : sp.id);
                return h('button', {
                  key: sp.id,
                  type: 'button',
                  className: 'mj-pill',
                  'data-space': sp.id,
                  'aria-pressed': selected ? 'true' : 'false',
                  title: fullTitle,
                  onClick: () => selectSpace(sp.id),
                  style: {
                    borderRadius: 999,
                    fontSize: 12,
                    lineHeight: '1.4',
                    fontFamily: 'inherit',
                    fontWeight: selected ? 600 : 400,
                    cursor: 'pointer',
                    background: selected ? C.fill : C.layer2,
                    color: selected ? C.onFill : C.fg,
                    border: '1px solid ' + (selected ? C.fill : C.line2),
                  },
                }, prefix + sp.label + countTxt);
              })),
            h('div', { className: 'mj-pillbar', role: 'group', 'aria-label': '视图模式' },
              [
                { id: 'all', label: '综合视图' },
                { id: 'memories', label: '仅看记忆' },
                { id: 'wiki', label: '知识页 (Wiki)' },
              ].map((vt) => {
                const active = viewTab === vt.id;
                return h('button', {
                  key: vt.id,
                  type: 'button',
                  className: 'mj-pill',
                  'data-view-tab': vt.id,
                  'aria-pressed': active ? 'true' : 'false',
                  onClick: () => switchViewTab(vt.id),
                  style: {
                    borderRadius: C.radiusSm,
                    fontSize: 12,
                    lineHeight: '1.4',
                    fontFamily: 'inherit',
                    fontWeight: active ? 600 : 400,
                    cursor: 'pointer',
                    background: active ? C.layer2 : 'transparent',
                    color: active ? C.fg : C.fg2,
                    border: '1px solid ' + (active ? C.line3 : C.line1),
                  },
                }, vt.label);
              }))),
          currentSpaceObj && currentSpaceObj.rootPath
            ? h(Hint, { mono: true, style: { marginTop: 8, wordBreak: 'break-all' } },
              '当前工作区：' + currentSpaceObj.rootPath + ' (' + currentSpaceObj.id + ')')
            : null,
          govFeedback
            ? h('div', {
              'aria-live': 'polite',
              'data-gov-feedback': govFeedback.kind,
              style: {
                marginTop: 8, paddingTop: 8, borderTop: '1px solid ' + C.line1,
                fontSize: 12, lineHeight: '1.5',
                color: govFeedback.kind === 'err' ? C.bad : govFeedback.kind === 'ok' ? C.ok : C.fg2,
              },
            }, govFeedback.text)
            : null)) : null;

      // ============================================================ 概览 A
      const overviewError = statusSt.phase === 'error';
      const overviewEmpty = !!stats && Number(stats.memories) === 0;

      const scopedUnfilteredMems = (isV2 && activeSpace !== 'all' && activeCategory === 'all' && activeLayer === 'all' && !searchQuery.trim() && rawMemList)
        ? rawMemList.filter((it) => it && (!it.spaceId || it.spaceId === activeSpace))
        : null;

      const catCounts = (() => {
        if (scopedUnfilteredMems && (!memData || !Number.isFinite(Number(memData.total)) || Number(memData.total) <= rawMemList.length)) {
          const acc = { rule: 0, profile: 0, decision: 0, experience: 0, state: 0 };
          for (const it of scopedUnfilteredMems) {
            const c = resolveItemCategory(it);
            if (c && acc[c] !== undefined) acc[c] += 1;
          }
          return acc;
        }
        const base = statusData && statusData.categories && typeof statusData.categories === 'object'
          ? statusData.categories
          : null;
        if (base) return base;
        if (!isV2 || !rawMemList) return null;
        const acc = { rule: 0, profile: 0, decision: 0, experience: 0, state: 0 };
        for (const it of rawMemList) {
          const c = resolveItemCategory(it);
          if (c && acc[c] !== undefined) acc[c] += 1;
        }
        return acc;
      })();

      const layerCounts = (() => {
        if (scopedUnfilteredMems && (!memData || !Number.isFinite(Number(memData.total)) || Number(memData.total) <= rawMemList.length)) {
          const acc = { L0: 0, L1: 0, L2: 0, L3: 0 };
          for (const it of scopedUnfilteredMems) {
            const l = resolveItemLayer(it);
            if (l && acc[l] !== undefined) acc[l] += 1;
          }
          return acc;
        }
        const base = (statusData && statusData.layers && typeof statusData.layers === 'object')
          ? statusData.layers
          : (stats && stats.lTiers && typeof stats.lTiers === 'object' ? stats.lTiers : null);
        if (base) return base;
        if (!isV2 || !rawMemList) return null;
        const acc = { L0: 0, L1: 0, L2: 0, L3: 0 };
        for (const it of rawMemList) {
          const l = resolveItemLayer(it);
          if (l && acc[l] !== undefined) acc[l] += 1;
        }
        return acc;
      })();

      const dualBudgetBlock = (() => {
        if (!isV2 || !statusData) return null;
        const tS = statusData.tierS && typeof statusData.tierS === 'object' ? statusData.tierS : null;
        const tD = statusData.tierD && typeof statusData.tierD === 'object' ? statusData.tierD : null;
        const inj = statusData.inject && typeof statusData.inject === 'object' ? statusData.inject : null;
        if (!tS && !tD && !inj) return null;

        const sBudget = Number(tS && tS.budget != null ? tS.budget : (inj && inj.tierSBudget != null ? inj.tierSBudget : 1200));
        const sMax = Number(tS && tS.maxChars != null ? tS.maxChars : sBudget);
        const dBudget = Number(tD && tD.budget != null ? tD.budget : (inj && inj.tierDBudget != null ? inj.tierDBudget : 2000));
        const dMax = Number(tD && tD.maxChars != null ? tD.maxChars : dBudget);
        const totalBudget = Number((inj && (inj.totalBudget || inj.injectBudget)) || (sBudget + dBudget) || 3200);

        const sRawUsed = tS && (tS.usedChars ?? tS.used) != null ? Number(tS.usedChars ?? tS.used)
          : (inj && (inj.tierSUsed ?? inj.tierSChars) != null ? Number(inj.tierSUsed ?? inj.tierSChars) : null);
        const dRawUsed = tD && (tD.usedChars ?? tD.used) != null ? Number(tD.usedChars ?? tD.used)
          : (inj && (inj.tierDUsed ?? inj.tierDChars) != null ? Number(inj.tierDUsed ?? inj.tierDChars) : null);

        const sHasUsed = sRawUsed !== null && Number.isFinite(sRawUsed);
        const dHasUsed = dRawUsed !== null && Number.isFinite(dRawUsed);
        const sPct = sHasUsed ? pctOf(sRawUsed, sBudget || sMax) : pctOf(sBudget, totalBudget);
        const dPct = dHasUsed ? pctOf(dRawUsed, dBudget || dMax) : pctOf(dBudget, totalBudget);
        const l0Count = layerCounts && Number.isFinite(Number(layerCounts.L0)) ? Number(layerCounts.L0) : 0;
        const l12Count = layerCounts
          ? (Number(layerCounts.L1 || 0) + Number(layerCounts.L2 || 0))
          : 0;
        const wikiTotal = Number.isFinite(Number(statusData.wikiCount))
          ? Number(statusData.wikiCount)
          : (stats && Number.isFinite(Number(stats.wikiCount)) ? Number(stats.wikiCount) : 0);
        const pendingJobs = Number(statusData.pendingIngestJobs ?? (stats && stats.pendingIngestJobs) ?? 0);

        return h('div', {
          'data-section': 'dual-budget',
          style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid ' + C.line1 },
        },
          h('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 },
          },
            h('span', { style: { fontSize: 12, fontWeight: 600, color: C.fg } }, '双层注入预算（Tier-S / Tier-D）'),
            h(Hint, null,
              (inj ? ('自动注入：' + (inj.enabled ? '开启' : '关闭') + ' · 模式 ' + (inj.mode || 'auto') + ' · ') : '')
              + '总预算 ' + fmt(totalBudget) + ' 字符'
              + (pendingJobs > 0 ? ' · 待消化队列 ' + fmt(pendingJobs) : ''))),
          h('div', { className: 'mj-budgetgrid' },
            h('div', {
              'data-budget-tier': 'tierS',
              style: { background: C.layer2, border: '1px solid ' + C.line2, borderRadius: C.radiusSm, padding: '8px 10px' },
            },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 12 } },
                h('span', { style: { fontWeight: 600, color: C.fg } }, 'Tier-S 静态底座'),
                h('span', { style: { fontFamily: C.mono, color: C.fg2 } },
                  sHasUsed ? (fmt(sRawUsed) + ' / ' + fmt(sBudget) + ' 字') : ('预算 ' + fmt(sBudget) + ' 字'))),
              h('div', { style: { height: 6, background: C.layer1, borderRadius: 999, overflow: 'hidden', marginTop: 6 } },
                h('div', {
                  style: {
                    height: '100%', width: sPct.toFixed(1) + '%',
                    background: sHasUsed ? usageColor(sPct) : C.accent,
                  },
                })),
              h(Hint, { style: { marginTop: 4 } },
                'L0 铁律 / 画像 / 状态常驻（上限 ' + fmt(sMax) + ' 字 · 当前 L0 ' + fmt(l0Count) + ' 条）')),
            h('div', {
              'data-budget-tier': 'tierD',
              style: { background: C.layer2, border: '1px solid ' + C.line2, borderRadius: C.radiusSm, padding: '8px 10px' },
            },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 12 } },
                h('span', { style: { fontWeight: 600, color: C.fg } }, 'Tier-D 动态召回'),
                h('span', { style: { fontFamily: C.mono, color: C.fg2 } },
                  dHasUsed ? (fmt(dRawUsed) + ' / ' + fmt(dBudget) + ' 字') : ('预算 ' + fmt(dBudget) + ' 字'))),
              h('div', { style: { height: 6, background: C.layer1, borderRadius: 999, overflow: 'hidden', marginTop: 6 } },
                h('div', {
                  style: {
                    height: '100%', width: dPct.toFixed(1) + '%',
                    background: dHasUsed ? usageColor(dPct) : C.ok,
                  },
                })),
              h(Hint, { style: { marginTop: 4 } },
                'L1 原子 + L2 Wiki 按需检索（上限 ' + fmt(dMax) + ' 字 · L1/L2 ' + fmt(l12Count) + ' 条 · Wiki ' + fmt(wikiTotal) + ' 页）'))));
      })();

      const taxonomySummaryBlock = (isV2 && (catCounts || layerCounts)) ? h('div', {
        style: { marginTop: 12, paddingTop: 10, borderTop: '1px solid ' + C.line1, display: 'flex', flexDirection: 'column', gap: 8 },
      },
        catCounts ? h('div', { className: 'mj-pillbar' },
          h(Hint, { style: { marginRight: 2 } }, '五类范畴：'),
          CATEGORIES.map((cat) => h(CategoryBadge, {
            key: cat.id,
            categoryId: cat.id,
            count: Number(catCounts[cat.id] || 0),
            interactive: true,
            selected: activeCategory === cat.id,
            onClick: () => setActiveCategory(activeCategory === cat.id ? 'all' : cat.id),
          }))) : null,
        layerCounts ? h('div', { className: 'mj-pillbar' },
          h(Hint, { style: { marginRight: 2 } }, '代谢层级：'),
          LAYERS.map((lay) => h(LayerBadge, {
            key: lay.id,
            layerId: lay.id,
            count: Number(layerCounts[lay.id] || 0),
            interactive: true,
            selected: activeLayer === lay.id,
            onClick: () => setActiveLayer(activeLayer === lay.id ? 'all' : lay.id),
          }))) : null) : null;

      const sectionA = h('div', { className: 'mj-sec' },
        h(SectionTitle, {
          right: isV2 ? h(Btn, {
            onClick: triggerReindex,
            disabled: !!govBusy || anyLoading,
            minHeight: 26,
            style: { minHeight: 26, padding: '0 10px', fontSize: 12 },
            title: '重建倒排检索索引',
          }, govBusy === 'reindex' ? '索引重建中…' : '重建索引') : null,
        }, '概览'),
        overviewError
          ? h(Card, null,
            h(ErrorBlock, { title: '读不到库体数据', detail: statusSt.error, onRetry: reloadStatus }))
          : h(Card, null,
            h('div', { className: 'mj-grid' }, stats ? [
              h(Stat, {
                key: 'm', label: '记忆条目', value: fmt(stats.memories),
                sub: fmt(stats.segments) + ' 段' + (Number.isFinite(Number(stats.wikiCount)) ? ' · Wiki ' + fmt(stats.wikiCount) + ' 页' : ''),
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
            dualBudgetBlock,
            taxonomySummaryBlock,
            rows && rows.length ? h(ImportanceBar, { buckets: importantBuckets(rows) }) : null,
            overviewEmpty
              ? h(Hint, { style: { marginTop: 10 } }, '库里还没有记忆。在对话里用 memjudge_remember 写入第一条。')
              : null));

      // ==================================================== 增强能力与密钥 B
      const gatedModules = MODULES.filter((m) => !m.readonly);
      const hasKey = !!(cfg && cfg.hasKey);
      const envLocked = cfg && cfg.envLocked && typeof cfg.envLocked === 'object' ? cfg.envLocked : null;
      const cfgLoading = statusSt.phase === 'loading' && !cfg;

      /** 三组的回读视图：一次算好，组子块与模块行共用同一份，避免各算各的。 */
      const groupViews = {};
      for (const g of CRED_GROUPS) groupViews[g.id] = groupView(cfg, g.id);
      const missingKeyGroups = CRED_GROUPS.filter((g) => !groupViews[g.id].keyConfigured);
      const anyKey = missingKeyGroups.length < CRED_GROUPS.length;
      const groupTitle = (id) => {
        for (const g of CRED_GROUPS) if (g.id === id) return g.title;
        return id;
      };

      // 任意一组有 key、但五项增强一盏都没亮：用户看不出因果，必须当场告诉他打开。
      // bulkDone 是成功后 4 秒的宽限，让「已打开 N 项」有地方落地。
      const showBulkCard = statusSt.phase === 'ready' && anyKey && !!cfg && !!cfg.flags
        && (GATED_FLAG_KEYS.every((f) => !cfg.flags[f]) || bulkDone !== null);

      const keyCardBody = statusSt.phase === 'error'
        ? h('div', null,
          h(ErrorBlock, { title: '配置读取失败：' + (statusSt.error || '未知原因'), onRetry: reloadStatus }))
        : cfgLoading
          ? h(Hint, null, '读取配置中…')
          : cfg
            ? h('div', null,
              CRED_GROUPS.map((g) => credGroupBlock(g)),
              h('div', { className: 'mj-globalblock' }, globalSettingsBlock()))
            : h(Hint, null, '读取配置中…');

      /** 一组凭证子块：标题 + 端点行 + 密钥行 + 其余行（模型名 / 向量维度）。 */
      function credGroupBlock(g) {
        const view = groupViews[g.id];
        const rows = SETTING_ROWS.filter((r) => r.group === g.id);
        const urlRow = rows.length ? rows[0] : null;
        const restRows = rows.slice(1);
        return h('div', {
          key: g.id,
          className: 'mj-credgroup',
          'data-group': g.id,
        },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 2 } },
            h('div', { style: { fontSize: 13, lineHeight: '1.4', fontWeight: 600, color: C.fg } }, g.title),
            h(Hint, { style: { minWidth: 0 } }, g.desc)),
          h('div', { style: { margin: '8px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('label', null, g.title + '模式 ', h('select', {
              'aria-label': g.title + ' 模式', className: 'mj-text',
              value: (settingsDraft && settingsDraft[g.id + 'Mode']) || (view.mode === 'legacy' ? '' : view.mode),
              disabled: settingsBusy || !!slotOf(g.id).busy,
              style: { color: C.fg, background: C.layer2, border: '1px solid ' + C.line2, borderRadius: C.radiusSm, minHeight: 32, maxWidth: '100%' },
              onChange: (e) => editSetting(g.id + 'Mode', e.target.value),
            },
              view.mode === 'legacy' ? h('option', { value: '', disabled: true }, '请选择迁移模式') : null,
              h('option', { value: 'independent' }, '独立配置'),
              g.id !== 'chat' ? h('option', { value: 'inherit' }, '继承对话端点与密钥') : null,
              h('option', { value: 'disabled' }, '禁用'))),
            h(Hint, null, view.mode === 'disabled' ? '已禁用：不发送能力请求。' : '当前生效：' + view.mode)),
          view.migrationRequired ? h(Hint, { tone: C.warn }, 'legacy：旧配置兼容状态，请选择模式并保存完成迁移。') : null,
          settingsDraft && settingsDraft[g.id + 'Mode'] && settingsDraft[g.id + 'Mode'] !== view.mode
            ? h(Hint, { tone: C.warn }, '模式尚未保存；先点下方保存，再编辑或测试本组。') : null,
          h(Hint, { style: { overflowWrap: 'anywhere' } }, '有效来源：端点 ' + (view.baseUrlSource || 'none') + ' · 模型 ' + (view.modelSource || 'none') + ' · 密钥 ' + view.keySource),
          view.inheritedEnv && (view.inheritedEnv.baseUrl || view.inheritedEnv.key)
            ? h(Hint, { style: { overflowWrap: 'anywhere' } }, '继承源环境锁：端点 ' + (view.inheritedEnv.baseUrl || '无') + '；密钥 ' + (view.inheritedEnv.key || '无')) : null,
          urlRow ? settingRow(urlRow) : null,
          keyBlock(g, view),
          restRows.map((row) => settingRow(row)));
      }

      /** Inherited endpoints require an explicit mode switch or clear action. */
      function settingRow(row) {
        const base = settingText(row.key, cfg);
        const val = settingsDraft && Object.prototype.hasOwnProperty.call(settingsDraft, row.key)
          ? settingsDraft[row.key] : base;
        const gid = row.group || GROUP_OF_SETTING[row.key] || null;
        const view = gid ? groupViews[gid] : null;
        const envName = view ? settingEnvName(view, row.key, gid) : '';
        const locked = !!(settingsLocked && settingsLocked[row.key]) || !!envName;
        const inherited = !!(view && view.mode === 'inherit' && GROUP_KEYS[gid].baseUrl === row.key);
        const modePending = !!(gid && settingsDraft && settingsDraft[gid + 'Mode'] && settingsDraft[gid + 'Mode'] !== view.mode);
        const off = settingsBusy || modePending || !!(view && (view.mode === 'disabled' || slotOf(gid).busy));
        const hint = inherited ? '当前继承对话端点。先保存独立模式再编辑；明确清空会退出继承。' : row.hint;
        return h('div', { key: row.key }, h(TextField, {
          key: row.key,
          label: row.label,
          ariaLabel: gid ? groupTitle(gid) + ' ' + row.label : row.label,
          value: val,
          onChange: (text) => editSetting(row.key, text),
          placeholder: row.placeholder,
          hint: hint,
          mono: row.mono,
          inputMode: row.inputMode,
          locked: locked,
          lockedReason: envName ? '该项由环境变量 ' + envName + ' 决定，改面板不生效' : undefined,
          disabled: off || inherited,
          disabledReason: view && view.mode === 'disabled' ? '该组已禁用，请先选择模式并保存'
            : modePending ? '模式尚未保存' : inherited ? '继承对话端点；切换独立模式后编辑' : undefined,
        }),
          gid && row.key !== 'dims' ? h(Btn, {
            ariaLabel: '清空' + groupTitle(gid) + ' ' + row.label,
            disabled: off || locked,
            onClick: () => {
              editSetting(row.key, null);
              if (inherited) editSetting(gid + 'Mode', 'independent');
            },
            title: '明确清空此项；点击保存后生效',
          }, '清空' + row.label) : null,
          val === null ? h(Hint, { tone: C.warn }, '待清空，保存后生效。') : null);
      }

      /**
       * 一组的密钥行。四种形态必须视觉可分：
       * 已配置（掩码 + 替换/清除） / 未配置（直接输入 + 保存） / 继承（提示可覆盖） / env 锁定（禁用）。
       * 键名、环境变量名都从 cfg.credSpec 取，面板不另抄一份。
       */
      function keyBlock(g, view) {
        const group = g.id;
        const slot = slotOf(group);
        const modePending = !!(settingsDraft && settingsDraft[group + 'Mode'] && settingsDraft[group + 'Mode'] !== view.mode);
        const busy = !!slot.busy || settingsBusy || modePending;
        const disabledGroup = view.mode === 'disabled';
        const inherited = view.mode === 'inherit';
        const locked = !!view.keyEnvLocked;
        const spec = cfg && cfg.credSpec ? cfg.credSpec[group] : null;
        const keyEnvName = view.keyEnv || (spec && Array.isArray(spec.keyEnv) && spec.keyEnv.length ? spec.keyEnv[0] : '');
        const showInput = locked || !view.keyConfigured || !!slot.replacing;
        const canSave = !locked && !inherited && !disabledGroup && slot.input.trim().length > 0 && !busy;
        const confirm = !!slot.confirmClear;

        let field;
        if (showInput) {
          field = h('div', { className: 'mj-keyinput', style: { flex: '1 1 auto', minWidth: 0 } },
            h('input', {
              ref: (el) => { keyRefs.current[group] = el; },
              className: 'mj-input',
              type: slot.shown ? 'text' : 'password',
              value: slot.input,
              disabled: busy || locked || inherited || disabledGroup,
              placeholder: locked
                ? '由环境变量 ' + (keyEnvName || 'MEMJUDGE_*_KEY') + ' 提供，面板不可写'
                : (view.keyInherited ? '填这一组自己的 key（不填就继续继承）' : '粘贴 API key（sk-...）'),
              'aria-label': g.title + ' 密钥',
              title: locked ? '密钥由环境变量 ' + (keyEnvName || 'MEMJUDGE_*_KEY') + ' 决定，面板写入不生效' : undefined,
              autoComplete: 'off',
              spellCheck: false,
              onChange: (e) => patchSlot(group, { input: e.target.value }),
              onKeyDown: (e) => { if (e.key === 'Enter' && canSave) saveKeyFor(group); },
              style: {
                width: '100%', minHeight: 28, padding: '0 34px 0 8px', boxSizing: 'border-box',
                background: C.layer2, border: '1px solid ' + C.line2, borderRadius: C.radiusSm,
                color: C.fg, fontSize: 13, lineHeight: '1.5', fontFamily: C.mono, outline: 'none',
                opacity: (busy || locked) ? 0.55 : 1,
                cursor: locked ? 'not-allowed' : 'text',
              },
            }),
            locked ? null : h('button', {
              type: 'button',
              className: 'mj-icon',
              'aria-label': slot.shown ? '隐藏密钥' : '显示密钥',
              'aria-pressed': slot.shown ? 'true' : 'false',
              onClick: () => patchSlot(group, { shown: !slot.shown }),
              style: {
                position: 'absolute', right: 2, top: 2, bottom: 2, width: 26, height: 'auto',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                border: 'none', borderRadius: C.radiusSm, background: 'transparent',
                color: C.fg2, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
              },
            }, slot.shown ? '隐' : '显'));
        } else {
          field = h('div', {
            className: 'mj-keyinput',
            style: { flex: '1 1 auto', minWidth: 0, alignItems: 'center' },
          },
            h('span', {
              className: 'mj-text',
              'aria-label': g.title + ' 密钥掩码',
              style: { fontFamily: C.mono, fontSize: 13, lineHeight: '1.55', color: C.fg, wordBreak: 'break-all' },
            }, maskOf(view)));
        }

        const acts = [];
        if (locked) {
          acts.push(h(Btn, { key: 't', disabled: busy || disabledGroup, onClick: () => testKeyFor(group) },
            slot.busy === 'test' ? '测试中…' : '测试连接'));
        } else if (showInput) {
          acts.push(h(Btn, { key: 's', primary: true, disabled: !canSave, onClick: () => saveKeyFor(group) },
            slot.busy === 'save' ? '保存中…' : (view.keyConfigured ? '保存新密钥' : '保存密钥')));
          acts.push(h(Btn, { key: 't', disabled: busy || disabledGroup, onClick: () => testKeyFor(group) },
            slot.busy === 'test' ? '测试中…' : '测试连接'));
          if (view.keyConfigured) {
            acts.push(h(Btn, {
              key: 'x',
              disabled: busy,
              onClick: () => patchSlot(group, { replacing: false, input: '' }),
              title: '放弃修改，回到掩码显示',
            }, '取消'));
          }
        } else {
          acts.push(h(Btn, { key: 'r', disabled: busy || inherited || disabledGroup, onClick: () => focusGroupKey(group) },
            '替换'));
          acts.push(h(Btn, { key: 't', disabled: busy || disabledGroup, onClick: () => testKeyFor(group) },
            slot.busy === 'test' ? '测试中…' : '测试连接'));
          acts.push(h(Btn, {
            key: 'c',
            danger: confirm,
            disabled: busy,
            onClick: () => clearKeyFor(group),
            title: confirm ? '5 秒内再点一次即清除' : '清除这一组存在本机 secrets.json 里的密钥',
          }, slot.busy === 'clear' ? '清除中…' : confirm ? '确认清除' : '清除'));
        }

        const msg = slot.msg;
        const msgTone = msg ? (msg.kind === 'ok' ? C.ok : msg.kind === 'err' ? C.bad : C.fg2) : C.fg2;
        return h('div', { style: { padding: '5px 0' } },
          h('div', {
            className: 'mj-textrow',
            style: { display: 'flex', alignItems: 'center', gap: 10 },
          },
            h('div', {
              className: 'mj-confattr',
              'aria-hidden': 'true',
              style: { fontSize: 12, lineHeight: '1.5', color: C.fg2 },
            }, '密钥'),
            field,
            h('div', { className: 'mj-keyact' }, acts)),
          h(Hint, { className: 'mj-texthint', tone: view.keyConfigured ? undefined : C.warn },
            '密钥' + ' · ' + keySourceLabel(view) + ' —— ' + keySourceHint(cfg, group, view)),
          msg
            ? h('div', {
              'aria-live': 'polite',
              style: {
                fontSize: 12, lineHeight: '1.5', color: msgTone,
                marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              },
            }, msg.text)
            : h('div', { 'aria-live': 'polite', style: { minHeight: 0 } }));
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
          const grp = m.group || 'chat';
          // 缺密钥判断必须按该模块自己那一组：向量缺 embed、精排缺 rerank，
          // 用全局 hasKey 会在一组配好、另一组没配时给出错误引导。
          const missKey = !m.readonly && !groupViews[grp].keyConfigured;
          return h(FlagRow, {
            key: m.key,
            m: Object.assign({}, m, { groupName: groupTitle(grp) }),
            checked: !!cfg.flags[m.key],
            needKey: missKey,
            locked: locked,
            busy: !!flagBusy[m.key],
            note: flagNote[m.key] || '',
            onToggle: () => toggleFlag(m.key, !cfg.flags[m.key]),
            onNeedKey: () => focusGroupKey(grp),
          });
        }));
      }

      /**
       * 卡尾：全局两项（存储上限 / 写入硬限）+ 统一保存条。
       * 这两项不属于任何模型组——把存储口径塞进某个组里会让用户以为换供应商就会改容量。
       * 回读（configReport）是唯一真值来源，draft 只覆盖用户动过的键，保存成功后丢弃。
       */
      function globalSettingsBlock() {
        if (statusSt.phase === 'error') {
          return h(ErrorBlock, {
            title: '配置读取失败：' + (statusSt.error || '未知原因'),
            onRetry: reloadStatus,
          });
        }
        if (!cfg) return h(Hint, null, '读取配置中…');
        const rows = SETTING_ROWS.filter((r) => !r.group);
        const tone = settingsMsg
          ? (settingsMsg.kind === 'err' ? C.bad : settingsMsg.kind === 'ok' ? C.ok : C.fg2)
          : C.fg2;
        return h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 2 } },
            h('div', { style: { fontSize: 13, lineHeight: '1.4', fontWeight: 600, color: C.fg } }, '库体与写入'),
            h(Hint, { style: { minWidth: 0 } }, '全局项，不属于上面任何一组模型。')),
          rows.map((row) => settingRow(row)),
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' },
          },
            h(Btn, { primary: true, disabled: settingsBusy, onClick: saveSettings },
              settingsBusy ? '保存中…' : '保存'),
            h(Btn, {
              disabled: settingsBusy,
              onClick: restoreSettingDefaults,
              title: '只把九个输入框填回出厂值，不提交',
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
          cfg.hint ? h(Hint, { style: { marginTop: 8 } }, cfg.hint) : null);
      }

      const sectionB = h('div', { className: 'mj-sec' },
        h(SectionTitle, null, '增强能力与密钥'),
        h(Card, { title: '接口与模型' }, keyCardBody),
        showBulkCard ? h('div', { style: { height: 10 } }) : null,
        showBulkCard ? h(Card, null, bulkCardBody()) : null,
        h('div', { style: { height: 10 } }),
        h(Card, { title: '增强模块' }, moduleListBlock()));

      // ================================================ 项目状态白板（单活 state）
      const activeStates = (() => {
        if (!isV2) return [];
        const fromSnap = wikiSnapOverride && Array.isArray(wikiSnapOverride.states)
          ? wikiSnapOverride.states
          : null;
        const fromStatus = statusData && Array.isArray(statusData.states)
          ? statusData.states
          : null;
        const base = fromSnap || fromStatus || (rawMemList
          ? rawMemList.filter((it) => resolveItemCategory(it) === 'state')
          : []);
        return base.filter((st) => {
          if (!st || typeof st !== 'object') return false;
          if (activeSpace !== 'all' && st.spaceId && st.spaceId !== activeSpace) return false;
          return true;
        });
      })();

      const stateSection = (isV2 && viewTab !== 'wiki') ? h('div', {
        className: 'mj-sec',
        'data-section': 'state-whiteboard',
      },
        h(SectionTitle, {
          right: h(Hint, null, fmt(activeStates.length) + ' 个活跃槽位'),
        }, '项目状态白板'),
        h(Card, null,
          activeStates.length === 0
            ? h(Hint, null, '当前空间暂无活跃单活状态（state）。写入带 slotKey 的状态记忆后会自动在此置顶追踪。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              activeStates.map((st, idx) => {
                const sid = String(st.id || ('state-' + idx));
                const slot = st.slotKey || 'default';
                const revCount = Array.isArray(st.revisions)
                  ? Math.max(Number(st.revisionCount || 0), st.revisions.length)
                  : Number(st.revisionCount || 0);
                const revOpen = !!openRevs[sid];
                const cachedRev = revCache[sid] || null;
                const revs = Array.isArray(st.revisions) && st.revisions.length > 0
                  ? st.revisions
                  : (cachedRev && Array.isArray(cachedRev.items) ? cachedRev.items : null);
                const updatedTs = Number(st.accessed || st.created);
                const spLabel = st.spaceId ? (spaceLabelMap[st.spaceId] || friendlyPathTail(st.spaceId)) : '';
                const isArmedForget = confirmForgetId === sid;
                const rowBusy = govBusy === ('demote:' + sid) || govBusy === ('forget:' + sid);

                return h('div', {
                  key: sid,
                  'data-state-card': sid,
                  'data-slot-key': slot,
                  style: {
                    background: C.layer2,
                    border: '1px solid ' + C.line2,
                    borderRadius: C.radiusSm,
                    padding: '10px 12px',
                  },
                },
                  h('div', {
                    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
                  },
                    h('div', { className: 'mj-pillbar' },
                      h('span', {
                        'data-slot-badge': slot,
                        style: {
                          display: 'inline-flex', alignItems: 'center',
                          padding: '1px 7px', borderRadius: C.radiusSm,
                          fontFamily: C.mono, fontSize: 12, fontWeight: 600,
                          color: C.fg, background: C.layer1, border: '1px solid ' + C.line3,
                        },
                      }, slot),
                      h(CategoryBadge, { categoryId: 'state' }),
                      h(LayerBadge, { layerId: resolveItemLayer(st) || 'L0' }),
                      (activeSpace === 'all' && spLabel)
                        ? h('span', {
                          style: {
                            fontSize: 12, lineHeight: '1.4', color: C.fg2,
                            padding: '1px 6px', borderRadius: C.radiusSm, border: '1px solid ' + C.line1,
                          },
                        }, spLabel)
                        : null),
                    h(Hint, {
                      title: Number.isFinite(updatedTs) ? absTime(updatedTs) : '',
                    }, '更新于 ' + relTime(updatedTs))),
                  h('div', {
                    style: {
                      marginTop: 8, fontSize: 13, lineHeight: '1.55',
                      color: C.fg, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    },
                  }, st.text || '（空状态值）'),
                  h('div', {
                    style: {
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 8, flexWrap: 'wrap', marginTop: 8, paddingTop: 6, borderTop: '1px solid ' + C.line1,
                    },
                  },
                    h('div', { className: 'mj-pillbar' },
                      revCount > 0 || (revs && revs.length > 0)
                        ? h('button', {
                          type: 'button',
                          'data-action': 'toggle-revisions',
                          'aria-expanded': revOpen ? 'true' : 'false',
                          onClick: () => toggleRevisions(st),
                          style: {
                            border: '1px solid ' + C.line2, borderRadius: C.radiusSm,
                            background: revOpen ? C.layer1 : 'transparent', color: C.fg2,
                            fontSize: 12, lineHeight: '1.4', padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit',
                          },
                        }, revOpen ? ('收起修订历史 (' + fmt(revCount || revs.length) + ')') : ('查看修订历史 (' + fmt(revCount || revs.length) + ')'))
                        : h(Hint, null, '初版状态 · 尚无覆写记录')),
                    st.id ? h('div', { className: 'mj-pillbar' },
                      h('button', {
                        type: 'button',
                        'data-action': 'demote',
                        'aria-label': '降级记忆 ' + sid,
                        disabled: !!govBusy,
                        onClick: () => demoteItem(st),
                        title: '将该单活状态降级为普通经验事件（L1）',
                        style: {
                          border: '1px solid ' + C.line2, borderRadius: C.radiusSm,
                          background: 'transparent', color: C.fg2, fontSize: 12, lineHeight: '1.4',
                          padding: '2px 8px', cursor: govBusy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
                          opacity: rowBusy ? 0.6 : 1,
                        },
                      }, govBusy === ('demote:' + sid) ? '降级中…' : '降级为经验'),
                      h('button', {
                        type: 'button',
                        'data-action': isArmedForget ? 'confirm-forget' : 'forget',
                        'aria-label': (isArmedForget ? '确认遗忘记忆 ' : '遗忘记忆 ') + sid,
                        disabled: !!govBusy,
                        onClick: () => armOrRunForget(st),
                        style: {
                          border: '1px solid ' + (isArmedForget ? C.bad : C.line2),
                          borderRadius: C.radiusSm,
                          background: 'transparent',
                          color: isArmedForget ? C.bad : C.fg2,
                          fontWeight: isArmedForget ? 600 : 400,
                          fontSize: 12, lineHeight: '1.4', padding: '2px 8px',
                          cursor: govBusy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
                        },
                      }, govBusy === ('forget:' + sid) ? '遗忘中…' : (isArmedForget ? '确认遗忘' : '遗忘')),
                      isArmedForget ? h('button', {
                        type: 'button',
                        'data-action': 'cancel-forget',
                        onClick: cancelForget,
                        style: {
                          border: '1px solid ' + C.line1, borderRadius: C.radiusSm,
                          background: 'transparent', color: C.fg2, fontSize: 12, lineHeight: '1.4',
                          padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit',
                        },
                      }, '取消') : null) : null),
                  revOpen ? h(RevisionTimeline, {
                    currentText: st.text || '',
                    revisions: revs,
                    loading: !!(cachedRev && cachedRev.loading),
                    error: cachedRev && cachedRev.error ? cachedRev.error : '',
                  }) : null);
              })))) : null;

      // ========================================== L2 持久化知识页（wiki_pages）
      const wikiPages = (() => {
        if (!isV2) return [];
        const src = (wikiSnapOverride && Array.isArray(wikiSnapOverride.wiki_pages))
          ? wikiSnapOverride.wiki_pages
          : (wikiSnapOverride && Array.isArray(wikiSnapOverride.pages))
            ? wikiSnapOverride.pages
            : (statusData && Array.isArray(statusData.wiki_pages))
              ? statusData.wiki_pages
              : (statusData && Array.isArray(statusData.pages))
                ? statusData.pages
                : [];
        return src.filter((pg) => {
          if (!pg || typeof pg !== 'object') return false;
          if (activeSpace !== 'all' && pg.spaceId && pg.spaceId !== activeSpace) return false;
          return true;
        });
      })();

      const dirtyWikiCount = wikiPages.filter((pg) => !!pg.dirty).length;

      const wikiSection = (isV2 && viewTab !== 'memories') ? h('div', {
        className: 'mj-sec',
        'data-section': 'wiki-pages',
      },
        h(SectionTitle, {
          right: h('div', { className: 'mj-pillbar' },
            h(Hint, null,
              fmt(wikiPages.length) + ' 页'
              + (dirtyWikiCount > 0 ? ' · ' + fmt(dirtyWikiCount) + ' 页待重编' : '')),
            h(Btn, {
              'data-action': 'compile-wiki',
              onClick: triggerCompile,
              disabled: !!govBusy || anyLoading,
              minHeight: 26,
              style: { minHeight: 26, padding: '0 10px', fontSize: 12 },
            }, govBusy === 'compile' ? '编译中…' : '编译知识页'),
            h(Btn, {
              'data-action': 'run-metabolism',
              onClick: triggerMetabolism,
              disabled: !!govBusy || anyLoading,
              minHeight: 26,
              style: { minHeight: 26, padding: '0 10px', fontSize: 12 },
            }, govBusy === 'metabolism' ? '代谢中…' : '执行代谢')),
        }, '知识页（Wiki）'),
        h(Card, null,
          wikiPages.length === 0
            ? h(Hint, null, '当前空间尚无持久化知识页。积累多条同主题 L2 记忆后，点击「编译知识页」或「执行代谢」即可生成结构化摘要页。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              wikiPages.map((pg, idx) => {
                const wKey = String(pg.pageId || pg.id || ((pg.spaceId || 'sp') + '::' + (pg.slug || idx)));
                const expanded = openWikis[wKey] !== false;
                const srcCount = Array.isArray(pg.sourceIds) ? pg.sourceIds.length : null;
                const spLabel = pg.spaceId ? (spaceLabelMap[pg.spaceId] || friendlyPathTail(pg.spaceId)) : '';
                const bodyMd = pg.markdown || pg.summary || '';
                return h('div', {
                  key: wKey,
                  'data-wiki-card': wKey,
                  'data-wiki-slug': pg.slug || '',
                  style: {
                    background: C.layer2,
                    border: '1px solid ' + C.line2,
                    borderRadius: C.radiusSm,
                    padding: '10px 12px',
                  },
                },
                  h('button', {
                    type: 'button',
                    'aria-expanded': expanded ? 'true' : 'false',
                    onClick: () => toggleWikiOpen(wKey),
                    style: {
                      display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between',
                      gap: 8, flexWrap: 'wrap', padding: 0, border: 'none', background: 'transparent',
                      color: C.fg, fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer',
                    },
                  },
                    h('span', { className: 'mj-pillbar', style: { minWidth: 0 } },
                      h(LayerBadge, { layerId: 'L2' }),
                      h('span', { style: { fontSize: 13, fontWeight: 600, color: C.fg, wordBreak: 'break-word' } },
                        pg.title || pg.slug || '未命名知识页'),
                      pg.dirty
                        ? h('span', {
                          'data-wiki-dirty': 'true',
                          style: {
                            fontSize: 12, lineHeight: '1.3', color: C.warn,
                            padding: '1px 6px', borderRadius: C.radiusSm, border: '1px solid ' + C.warn,
                          },
                        }, '待重编')
                        : null,
                      (activeSpace === 'all' && spLabel)
                        ? h('span', {
                          style: {
                            fontSize: 12, lineHeight: '1.3', color: C.fg2,
                            padding: '1px 6px', borderRadius: C.radiusSm, border: '1px solid ' + C.line1,
                          },
                        }, spLabel)
                        : null),
                    h('span', { className: 'mj-pillbar', style: { fontSize: 12, color: C.fg2 } },
                      pg.version ? h('span', { style: { fontFamily: C.mono } }, 'v' + pg.version) : null,
                      srcCount !== null ? h('span', null, fmt(srcCount) + ' 条源记忆') : null,
                      pg.updatedAt ? h('span', { title: absTime(pg.updatedAt) }, '更新于 ' + relTime(pg.updatedAt)) : null,
                      h('span', { style: { color: C.fg3 } }, expanded ? '▾' : '▸'))),
                  expanded
                    ? h('div', {
                      'data-wiki-body': pg.slug || wKey,
                      style: { marginTop: 8, paddingTop: 8, borderTop: '1px solid ' + C.line1 },
                    }, renderStructuredMarkdown(bodyMd))
                    : null);
              })))) : null;

      // ========================================================== 记忆条目 C
      const visibleRows = (() => {
        if (!rows) return null;
        if (!isV2) return rows;
        const qNorm = searchQuery.trim().toLowerCase();
        return rows.filter((r) => {
          if (!r || typeof r !== 'object') return false;
          if (activeSpace !== 'all' && r.spaceId && r.spaceId !== activeSpace) return false;
          if (activeCategory !== 'all' && resolveItemCategory(r) !== activeCategory) return false;
          if (activeLayer !== 'all' && resolveItemLayer(r) !== activeLayer) return false;
          if (qNorm) {
            const hay = [r.text, r.slotKey, r.source, r.id].filter(Boolean).join('\n').toLowerCase();
            if (hay.indexOf(qNorm) < 0) return false;
          }
          return true;
        });
      })();

      const hasActiveFilter = isV2 && (activeCategory !== 'all' || activeLayer !== 'all' || searchQuery.trim() !== '');
      const memCount = visibleRows
        ? (hasActiveFilter
          ? ('筛选命中 ' + fmt(visibleRows.length) + ' 条')
          : countLabel(Object.assign({}, memData || {}, { rows: visibleRows }), stats))
        : '';
      const memRight = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        visibleRows ? h(Hint, null, memCount) : null,
        visibleRows && visibleRows.length
          ? h(Btn, {
            className: 'mj-fold',
            onClick: () => setMemCollapsed((v) => !v),
            'aria-expanded': memCollapsed ? 'false' : 'true',
            'aria-controls': memBodyId.current,
            minHeight: 28,
            style: { minHeight: 24, padding: '0 8px' },
          }, memCollapsed ? '展开 ' + visibleRows.length + ' 条' : '收起')
          : null);

      const filterToolbar = isV2 ? h(Card, {
        'data-section': 'memory-filters',
        style: { padding: '10px 12px', marginBottom: 10 },
      },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { className: 'mj-pillbar', role: 'group', 'aria-label': '按五类范畴筛选' },
            h('button', {
              type: 'button',
              className: 'mj-pill',
              'data-filter-category': 'all',
              'aria-pressed': activeCategory === 'all' ? 'true' : 'false',
              onClick: () => setActiveCategory('all'),
              style: {
                borderRadius: 999, fontSize: 12, lineHeight: '1.4', fontFamily: 'inherit',
                fontWeight: activeCategory === 'all' ? 600 : 400, cursor: 'pointer',
                background: activeCategory === 'all' ? C.fill : C.layer2,
                color: activeCategory === 'all' ? C.onFill : C.fg2,
                border: '1px solid ' + (activeCategory === 'all' ? C.fill : C.line2),
              },
            }, '全部范畴'),
            CATEGORIES.map((cat) => h(CategoryBadge, {
              key: cat.id,
              categoryId: cat.id,
              count: catCounts && catCounts[cat.id] != null ? Number(catCounts[cat.id]) : null,
              interactive: true,
              selected: activeCategory === cat.id,
              filterAttr: cat.id,
              onClick: () => setActiveCategory(activeCategory === cat.id ? 'all' : cat.id),
            }))),
          h('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
          },
            h('div', { className: 'mj-pillbar', role: 'group', 'aria-label': '按代谢层级筛选' },
              h('button', {
                type: 'button',
                className: 'mj-pill',
                'data-filter-layer': 'all',
                'aria-pressed': activeLayer === 'all' ? 'true' : 'false',
                onClick: () => setActiveLayer('all'),
                style: {
                  borderRadius: C.radiusSm, fontSize: 12, lineHeight: '1.4', fontFamily: 'inherit',
                  fontWeight: activeLayer === 'all' ? 600 : 400, cursor: 'pointer',
                  background: activeLayer === 'all' ? C.fill : C.layer2,
                  color: activeLayer === 'all' ? C.onFill : C.fg2,
                  border: '1px solid ' + (activeLayer === 'all' ? C.fill : C.line2),
                },
              }, '全部层级'),
              LAYERS.map((lay) => h(LayerBadge, {
                key: lay.id,
                layerId: lay.id,
                count: layerCounts && layerCounts[lay.id] != null ? Number(layerCounts[lay.id]) : null,
                interactive: true,
                selected: activeLayer === lay.id,
                filterAttr: lay.id,
                onClick: () => setActiveLayer(activeLayer === lay.id ? 'all' : lay.id),
              }))),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 180px', maxWidth: 320 } },
              h('input', {
                type: 'search',
                value: searchQuery,
                placeholder: '搜索记忆正文、slotKey 或来源…',
                'aria-label': '搜索记忆正文或槽位',
                onChange: (ev) => setSearchQuery(ev.target.value),
                style: {
                  width: '100%', minWidth: 0, minHeight: 28, boxSizing: 'border-box',
                  padding: '4px 8px', fontSize: 12, lineHeight: '1.4', color: C.fg,
                  background: C.layer2, border: '1px solid ' + C.line2, borderRadius: C.radiusSm,
                  fontFamily: 'inherit',
                },
              }),
              hasActiveFilter
                ? h(Btn, {
                  onClick: resetFilters,
                  minHeight: 28,
                  style: { minHeight: 28, padding: '0 8px', fontSize: 12 },
                }, '重置筛选')
                : null)))) : null;

      let memBody;
      if (memsSt.phase === 'error') {
        memBody = h(ErrorBlock, { title: '记忆列表读取失败：' + (memsSt.error || '未知原因'), onRetry: reloadMems });
      } else if (!visibleRows) {
        memBody = h('div', null, [0, 1, 2].map((i) => h('div', {
          key: 'sk' + i,
          style: {
            height: 54, marginBottom: 8, background: C.layer2,
            border: '1px solid ' + C.line2, borderRadius: C.radiusSm, opacity: 0.55,
          },
        })));
      } else if (visibleRows.length === 0) {
        memBody = h(Hint, { style: { padding: '10px 0' } },
          hasActiveFilter || activeSpace !== 'all'
            ? '当前筛选条件下没有匹配的记忆条目。'
            : '库里还没有记忆。在对话里用 memjudge_remember 写入第一条。');
      } else {
        memBody = h('div', { className: 'mj-scroll', style: { maxHeight: 420, overflowY: 'auto' } },
          groupRows(visibleRows).map((g) => h('div', { key: 'g:' + (g.chapter || '__none') },
            h('div', {
              style: {
                position: 'sticky', top: 0, zIndex: 1, background: C.layer1,
                padding: '6px 0 4px', fontSize: 12, lineHeight: '1.5', color: C.fg2,
              },
            }, (g.chapter && g.chapter !== '0' ? '第 ' + g.chapter + ' 章' : '未标章') + ' · ' + g.rows.length + ' 条'),
            h('div', null, g.rows.map((r) => {
              const rid = String(r.id || '');
              const cachedRev = rid ? (revCache[rid] || null) : null;
              return h(MemoryRow, {
                key: rid || Math.random().toString(36).slice(2),
                r: r,
                isV2: isV2,
                open: !!openMems[rid],
                onToggleOpen: () => toggleMemOpen(rid),
                spaceLabel: (activeSpace === 'all' && r.spaceId)
                  ? (spaceLabelMap[r.spaceId] || friendlyPathTail(r.spaceId))
                  : '',
                revOpen: !!openRevs[rid],
                cachedRev: cachedRev,
                onToggleRevisions: () => toggleRevisions(r),
                onDemote: () => demoteItem(r),
                isArmedForget: confirmForgetId === rid,
                onForget: () => armOrRunForget(r),
                onCancelForget: cancelForget,
                govBusy: govBusy,
              });
            })))));
      }

      const sectionC = viewTab !== 'wiki' ? h('div', { className: 'mj-sec', 'data-section': 'memories-list' },
        h(SectionTitle, { right: memRight }, '记忆条目'),
        filterToolbar,
        h('div', {
          id: memBodyId.current,
          className: 'mj-membody',
          'data-collapsed': memCollapsed ? '1' : '0',
        }, memBody)) : null;

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
        confBody = h('div', null, conflicts.map((c, idx) => h('div', {
          key: (c.key || c.attr || 'conf') + ':' + idx,
          className: 'mj-conf',
        },
          h('div', {
            className: 'mj-confattr',
            style: { fontFamily: C.mono, fontSize: 13, lineHeight: '1.55', color: C.fg, wordBreak: 'break-all' },
          }, (c.entity ? c.entity + ' · ' : '') + (c.attr || '—')),
          h('div', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 13, lineHeight: '1.55', color: C.fg2, wordBreak: 'break-word' } },
            c.conflictType
              ? h('span', {
                style: {
                  fontSize: 12, color: C.warn, marginRight: 6,
                  padding: '0 5px', borderRadius: C.radiusSm, border: '1px solid ' + C.warn,
                },
              }, typeof c.conflictType === 'string' ? c.conflictType : (c.conflictType?.type || 'disputed'))
              : null,
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
          h('div', null, isV2
            ? '支持按工作区、五类范畴与代谢层级治理；物理遗忘不可恢复，误判铁律/画像建议优先降级为经验。'
            : '删除记忆请用对话里的 memjudge_forget；面板只读。'),
          cfg ? h('div', null, '配置文件 ' + cfg.configPath) : null,
          cfg ? h('div', null, '密钥文件 ' + cfg.secretsPath) : null));

      return h('div', { className: 'mj-panel', style: rootStyle },
        header, scopeSection, sectionA, stateSection, wikiSection, sectionC, sectionD, sectionB, sectionE);

      // ------------------------------------------------------------ 内部渲染件

      function emptyStats() {
        const labels = [
          ['记忆条目', ''], ['三元组', ''], ['正文字数', ''], ['占用', ''],
          ['已磨损段', ''], ['单条上限', ''],
        ];
        return labels.map((l, i) => h(Stat, { key: 'e' + i, label: l[0], value: '—', sub: '' }));
      }
    }

    /** 五类范畴彩色徽标（纯无状态组件，严禁内部使用 React Hooks）。 */
    function CategoryBadge({ categoryId, count, interactive, selected, onClick, filterAttr }) {
      const meta = CATEGORY_MAP[categoryId] || { id: categoryId || 'experience', label: categoryId || '经验', color: C.fg2, borderColor: C.line3, desc: '' };
      const dotColor = meta.color || C.fg2;
      const borderCol = meta.borderColor || dotColor;
      const countSuffix = count !== undefined && count !== null && Number.isFinite(Number(count))
        ? ' ' + fmt(count)
        : '';
      const commonStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        borderRadius: 999,
        padding: interactive ? '2px 9px' : '1px 7px',
        fontSize: 12,
        lineHeight: '1.4',
        fontFamily: 'inherit',
        fontWeight: selected ? 600 : 500,
        background: selected ? C.layer1 : C.layer2,
        color: selected ? dotColor : C.fg,
        border: '1px solid ' + (selected ? borderCol : C.line2),
        cursor: interactive ? 'pointer' : 'default',
        boxSizing: 'border-box',
      };
      const dot = h('span', {
        'aria-hidden': 'true',
        style: { width: 6, height: 6, borderRadius: '50%', background: dotColor, flex: '0 0 6px' },
      });
      const labelNode = h('span', null, meta.label + countSuffix);
      if (interactive) {
        return h('button', {
          type: 'button',
          className: 'mj-pill',
          'data-category-badge': meta.id,
          'data-filter-category': filterAttr || undefined,
          'aria-pressed': selected ? 'true' : 'false',
          title: meta.label + ' (' + meta.id + ')' + (meta.desc ? ' — ' + meta.desc : ''),
          onClick: onClick,
          style: commonStyle,
        }, dot, labelNode);
      }
      return h('span', {
        'data-category-badge': meta.id,
        title: meta.label + ' (' + meta.id + ')' + (meta.desc ? ' — ' + meta.desc : ''),
        style: commonStyle,
      }, dot, labelNode);
    }

    /** L0-L3 代谢层级角标（纯无状态组件，严禁内部使用 React Hooks）。 */
    function LayerBadge({ layerId, count, interactive, selected, onClick, filterAttr }) {
      const meta = LAYER_MAP[layerId] || { id: layerId || 'L1', label: layerId || 'L1', color: C.fg2, borderColor: C.line3, desc: '' };
      const tone = meta.color || C.fg2;
      const borderCol = meta.borderColor || tone;
      const countSuffix = count !== undefined && count !== null && Number.isFinite(Number(count))
        ? ' (' + fmt(count) + ')'
        : '';
      const style = {
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: C.radiusSm,
        padding: interactive ? '2px 8px' : '1px 6px',
        fontSize: 12,
        lineHeight: '1.35',
        fontFamily: C.mono,
        fontWeight: 600,
        background: selected ? C.layer1 : 'transparent',
        color: tone,
        border: '1px solid ' + (selected ? borderCol : C.line2),
        cursor: interactive ? 'pointer' : 'default',
        boxSizing: 'border-box',
      };
      if (interactive) {
        return h('button', {
          type: 'button',
          className: 'mj-pill',
          'data-layer-badge': meta.id,
          'data-filter-layer': filterAttr || undefined,
          'aria-pressed': selected ? 'true' : 'false',
          title: meta.id + (meta.desc ? ' · ' + meta.desc : ''),
          onClick: onClick,
          style: style,
        }, meta.label + countSuffix);
      }
      return h('span', {
        'data-layer-badge': meta.id,
        title: meta.id + (meta.desc ? ' · ' + meta.desc : ''),
        style: style,
      }, meta.label + countSuffix);
    }

    /** 修订历史时间线：清晰展示何时从什么旧状态覆写为后续/当前状态（纯无状态组件）。 */
    function RevisionTimeline({ currentText, revisions, loading, error }) {
      if (loading) {
        return h('div', {
          'data-revisions-panel': 'loading',
          style: { marginTop: 8, padding: '8px 10px', background: C.layer1, borderRadius: C.radiusSm, border: '1px solid ' + C.line1 },
        }, h(Hint, null, '正在读取修订演化记录…'));
      }
      if (error) {
        return h('div', {
          'data-revisions-panel': 'error',
          style: { marginTop: 8, padding: '8px 10px', background: C.layer1, borderRadius: C.radiusSm, border: '1px solid ' + C.line1 },
        }, h('span', { style: { fontSize: 12, color: C.bad } }, error));
      }
      const list = Array.isArray(revisions) ? revisions : [];
      if (list.length === 0) {
        return h('div', {
          'data-revisions-panel': 'empty',
          style: { marginTop: 8, padding: '8px 10px', background: C.layer1, borderRadius: C.radiusSm, border: '1px solid ' + C.line1 },
        }, h(Hint, null, '暂无历史修订记录。'));
      }
      const reasonLabels = {
        'state-update': '单活状态覆写',
        state_overwrite: '单活状态覆写',
        supersede: '显式取代旧结论',
        compact: '生命周期压缩',
      };
      return h('div', {
        'data-revisions-panel': 'ready',
        style: {
          marginTop: 8, padding: '8px 10px', background: C.layer1,
          borderRadius: C.radiusSm, border: '1px solid ' + C.line1,
          display: 'flex', flexDirection: 'column', gap: 8,
        },
      },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: C.fg2 } },
          '修订演化轨迹（共 ' + fmt(list.length) + ' 次历史变更）'),
        list.map((rev, idx) => {
          const nextVal = idx === 0 ? currentText : (list[idx - 1] && list[idx - 1].prevText ? list[idx - 1].prevText : currentText);
          const reasonRaw = rev && rev.reason ? String(rev.reason) : 'state_overwrite';
          const reasonTxt = reasonLabels[reasonRaw] ? (reasonLabels[reasonRaw] + ' (' + reasonRaw + ')') : reasonRaw;
          const ts = Number(rev && rev.changedAt);
          return h('div', {
            key: String((rev && rev.revId) || idx),
            'data-revision-item': String((rev && rev.revId) || idx),
            style: {
              paddingLeft: 8,
              borderLeft: '2px solid ' + (idx === 0 ? C.accent : C.line3),
              fontSize: 12,
              lineHeight: '1.5',
            },
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', color: C.fg2 } },
              h('span', { style: { fontWeight: 600 } }, reasonTxt),
              h('span', { title: Number.isFinite(ts) ? absTime(ts) : '' }, relTime(ts))),
            h('div', { style: { marginTop: 3, color: C.fg2, wordBreak: 'break-word' } },
              h('span', { style: { color: C.fg3 } }, '旧值：'),
              h('span', { style: { textDecoration: 'line-through' } }, (rev && rev.prevText) || '—')),
            nextVal ? h('div', { style: { marginTop: 2, color: C.fg, wordBreak: 'break-word' } },
              h('span', { style: { color: C.ok } }, idx === 0 ? '覆写为当前：' : '覆写为：'),
              h('span', null, nextVal)) : null);
        }));
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
     * 单条记忆卡片（纯无状态组件，展开态与治理动作由顶层传入，保证 Hook 游标绝对恒定）。
     * v1/v7：保留原紧凑单行按钮；v2：叠加五类范畴徽标、L0-L3 角标、修订链展开、降级与确认遗忘。
     */
    function MemoryRow({
      r, isV2, open, onToggleOpen, spaceLabel,
      revOpen, cachedRev, onToggleRevisions,
      onDemote, isArmedForget, onForget, onCancelForget, govBusy,
    }) {
      const tier = impTier(r.importance);
      const created = Number(r.created);
      const accessed = Number(r.accessed);
      const showAccessed = Number.isFinite(accessed) && Number.isFinite(created) && accessed > created;
      const text = typeof r.text === 'string' ? r.text : '';
      const src = sourceText(r.source);
      const impText = Number.isFinite(Number(r.importance)) && Number(r.importance) >= 0.3
        ? '重要 ' + Number(r.importance).toFixed(2) : '';
      const rid = String(r.id || '');

      const bodyBtn = h('button', {
        type: 'button',
        className: 'mj-memrow',
        onClick: onToggleOpen,
        'aria-expanded': open ? 'true' : 'false',
        title: rid + (Number.isFinite(created) ? '\n' + absTime(created) : ''),
        style: {
          display: 'flex', width: '100%', textAlign: 'left', gap: 8, alignItems: 'stretch',
          padding: isV2 ? '4px 0 2px' : '8px 0', border: 'none', background: 'transparent',
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

      if (!isV2) return bodyBtn;

      const catId = resolveItemCategory(r) || 'experience';
      const layerId = resolveItemLayer(r) || 'L1';
      const revCount = Array.isArray(r.revisions)
        ? Math.max(Number(r.revisionCount || 0), r.revisions.length)
        : Number(r.revisionCount || 0);
      const revs = Array.isArray(r.revisions) && r.revisions.length > 0
        ? r.revisions
        : (cachedRev && Array.isArray(cachedRev.items) ? cachedRev.items : null);
      const allowDemote = canDemoteMemory(r);

      return h('div', {
        className: 'mj-memcard',
        'data-memory-card': rid,
        'data-memory-category': catId,
        'data-memory-layer': layerId,
      },
        h('div', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 4 },
        },
          h('div', { className: 'mj-pillbar' },
            h(CategoryBadge, { categoryId: catId }),
            h(LayerBadge, { layerId: layerId }),
            r.slotKey
              ? h('span', {
                'data-slot-badge': r.slotKey,
                style: {
                  fontFamily: C.mono, fontSize: 12, lineHeight: '1.35', color: C.fg2,
                  padding: '1px 6px', borderRadius: C.radiusSm, background: C.layer2, border: '1px solid ' + C.line2,
                },
              }, 'slot:' + r.slotKey)
              : null,
            spaceLabel
              ? h('span', {
                style: {
                  fontSize: 12, lineHeight: '1.35', color: C.fg2,
                  padding: '1px 6px', borderRadius: C.radiusSm, border: '1px solid ' + C.line1,
                },
              }, spaceLabel)
              : null),
          rid ? h('div', { className: 'mj-pillbar' },
            (revCount > 0 || (revs && revs.length > 0))
              ? h('button', {
                type: 'button',
                'data-action': 'toggle-revisions',
                'aria-label': '查看记忆 ' + rid + ' 修订历史',
                'aria-expanded': revOpen ? 'true' : 'false',
                onClick: onToggleRevisions,
                style: {
                  border: '1px solid ' + C.line2, borderRadius: C.radiusSm,
                  background: revOpen ? C.layer2 : 'transparent', color: C.fg2,
                  fontSize: 12, lineHeight: '1.4', padding: '1px 7px', cursor: 'pointer', fontFamily: 'inherit',
                },
              }, revOpen ? ('收起修订 (' + fmt(revCount || revs.length) + ')') : ('修订 (' + fmt(revCount || revs.length) + ')'))
              : null,
            allowDemote
              ? h('button', {
                type: 'button',
                'data-action': 'demote',
                'aria-label': '降级记忆 ' + rid,
                disabled: !!govBusy,
                onClick: onDemote,
                title: '将误判的铁律/画像/常驻记忆降级为普通经验事件（L1）',
                style: {
                  border: '1px solid ' + C.line2, borderRadius: C.radiusSm,
                  background: 'transparent', color: C.fg2, fontSize: 12, lineHeight: '1.4',
                  padding: '1px 7px', cursor: govBusy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
                },
              }, govBusy === ('demote:' + rid) ? '降级中…' : '降级为经验')
              : null,
            h('button', {
              type: 'button',
              'data-action': isArmedForget ? 'confirm-forget' : 'forget',
              'aria-label': (isArmedForget ? '确认遗忘记忆 ' : '遗忘记忆 ') + rid,
              disabled: !!govBusy,
              onClick: onForget,
              title: isArmedForget ? '再次点击立即物理删除（不可恢复）' : '物理遗忘该条记忆（需二次确认）',
              style: {
                border: '1px solid ' + (isArmedForget ? C.bad : C.line2),
                borderRadius: C.radiusSm,
                background: 'transparent',
                color: isArmedForget ? C.bad : C.fg2,
                fontWeight: isArmedForget ? 600 : 400,
                fontSize: 12, lineHeight: '1.4', padding: '1px 7px',
                cursor: govBusy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
              },
            }, govBusy === ('forget:' + rid) ? '遗忘中…' : (isArmedForget ? '确认遗忘' : '遗忘')),
            isArmedForget
              ? h('button', {
                type: 'button',
                'data-action': 'cancel-forget',
                onClick: onCancelForget,
                style: {
                  border: '1px solid ' + C.line1, borderRadius: C.radiusSm,
                  background: 'transparent', color: C.fg2, fontSize: 12, lineHeight: '1.4',
                  padding: '1px 7px', cursor: 'pointer', fontFamily: 'inherit',
                },
              }, '取消')
              : null) : null),
        bodyBtn,
        revOpen ? h(RevisionTimeline, {
          currentText: text,
          revisions: revs,
          loading: !!(cachedRev && cachedRev.loading),
          error: cachedRev && cachedRev.error ? cachedRev.error : '',
        }) : null);
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
      // 同源 Fetch 路由：cookie 自动携带，不需要再给 connection 打 loopback 标记。
      const rpcCall = async (endpoint, payload) => {
        const url = RPC_PATH_PREFIX + endpoint;
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload ?? {}),
          });
          if (!response.ok) throw new Error(`transport failure for ${url}: HTTP ${response.status}`);
          return await response.json();
        } catch (e) {
          console.log('[memjudge] rpc 调用失败', url, endpoint);
          return { ok: false, error: { code: 'call', message: String(e && e.message ? e.message : e) } };
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
