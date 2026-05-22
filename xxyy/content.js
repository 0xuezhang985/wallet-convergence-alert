(function () {
  'use strict';
  if (window.__xcpLoaded) return;
  window.__xcpLoaded = true;

  // ===== 配置 =====
  const DEFAULT_CONFIG = {
    minWallets: 2,             // KOL 主面板阈值
    timeWindowMin: 5,
    minWalletsMy: 2,           // 我的面板阈值（独立）
    timeWindowMinMy: 5,
    soundEnabled: true,        // 兼容旧版（已废弃）
    soundEnabledMain: true,
    soundEnabledMy: true,
    collapsed: false,
    collapsedMy: false,
    cloneTab: '我的',
    tieredAlerts: true,
    floatingMain: false,       // 主面板浮窗模式
    floatingMy: false,         // 我的面板浮窗模式
    scopeMain: 'all',          // 'all' 全页面 | 'panel' 仅本面板
    scopeMy: 'all',
    posMain: null,             // { right, top } 浮窗位置记忆
    posMy: null
  };

  let config = { ...DEFAULT_CONFIG };
  let alertsKol = [];   // 仅 KOL 来源的聚合提醒
  let alertsMy = [];    // 仅 我的 来源的聚合提醒
  let buyRecords = [];  // 所有来源的买入流水（去重后）
  let closedRecords = []; // 清仓事件流水
  let seenKeys = new Set();
  let seenClosedKeys = new Set();
  let panelEl = null;
  let cloneCardEl = null;
  let mountCheckInterval = null;
  let cleanupInterval = null;
  let domScanInterval = null;

  // 钱包名 → 分组名映射
  const walletGroups = new Map();

  // 钱包显示名 → 地址（socket.io 推送时学习，DOM 扫描没地址时用来反查）
  const walletNameToAddr = new Map();
  // 把 record 规范成 canonical wallet id（优先 addr，没有就 name）
  function canonicalWallet(r) {
    if (r.walletAddr) return r.walletAddr;
    const fromMap = walletNameToAddr.get(r.wallet);
    if (fromMap) return fromMap;
    return r.wallet || '';
  }

  // 缩写合约：开头 4 + 结尾 4
  function shortMint(m) {
    if (!m) return '';
    if (m.length <= 10) return m;
    return m.slice(0, 4) + '…' + m.slice(-4);
  }

  // ===== 检测代币发射平台 =====
  function detectPlatform(mint, chain, dex, dexId) {
    const m = (mint || '').toLowerCase();
    const c = (chain || '').toLowerCase();
    const d = (dex || '').toLowerCase();
    const i = (dexId || '').toLowerCase();
    // Solana 末尾约定
    if (c === 'sol') {
      if (m.endsWith('pump')) return { tag: 'pump', label: 'pump.fun', cls: 'xcp-plat-pump' };
      if (m.endsWith('bonk')) return { tag: 'bonk', label: 'bonk.fun', cls: 'xcp-plat-bonk' };
      if (m.endsWith('boop')) return { tag: 'boop', label: 'boop.fun', cls: 'xcp-plat-boop' };
    }
    // BSC：靠 dex 名
    if (c === 'bsc' || c === 'bnb') {
      if (d.includes('four') || d.includes('4.meme') || i.includes('four')) return { tag: 'four', label: 'four.meme', cls: 'xcp-plat-four' };
    }
    // 通用：dex 名包含 pump/bonk 也算
    if (i.includes('pfamm') || d.includes('pump amm') || d === 'pumpfun') return { tag: 'pump', label: 'pump.fun', cls: 'xcp-plat-pump' };
    return null;
  }

  // 特别关注的钱包名集合
  let starred = new Set();
  try {
    const savedStars = localStorage.getItem('xcp_starred');
    if (savedStars) starred = new Set(JSON.parse(savedStars));
  } catch (e) {}

  function saveStarred() {
    try { localStorage.setItem('xcp_starred', JSON.stringify(Array.from(starred))); } catch (e) {}
  }

  function toggleStar(walletName) {
    if (!walletName) return;
    if (starred.has(walletName)) starred.delete(walletName);
    else starred.add(walletName);
    saveStarred();
    // 立刻刷新所有相关 UI
    lastRenderState = '';
    renderAlerts();
    renderCloneCard();
    updateStarBadge();
    injectOrigStars();
  }

  function isAlertStarred(a) {
    return a.wallets && a.wallets.some(w => starred.has(w.name));
  }

  function updateStarBadge() {
    if (!panelEl) return;
    const b = panelEl.querySelector('.xcp-star-count');
    if (b) {
      b.textContent = starred.size;
      b.style.display = starred.size > 0 ? 'inline' : 'none';
    }
  }

  // 数据池：socket.io 推送 + DOM 扫描共用
  const cloneData = { kol: [], my: [] };

  // 代币元数据：name → { mint, chain, symbol, name, logo }
  const tokenMeta = new Map();

  try {
    const saved = localStorage.getItem('xcp_config');
    if (saved) Object.assign(config, JSON.parse(saved));
    // 旧版兼容
    if (saved) {
      const obj = JSON.parse(saved);
      if (obj.soundEnabled !== undefined && obj.soundEnabledMain === undefined) {
        config.soundEnabledMain = obj.soundEnabled;
        config.soundEnabledMy = obj.soundEnabled;
      }
      // 旧版的 minWallets/timeWindowMin 统一同步到 my 字段
      if (obj.minWalletsMy === undefined && obj.minWallets !== undefined) {
        config.minWalletsMy = obj.minWallets;
      }
      if (obj.timeWindowMinMy === undefined && obj.timeWindowMin !== undefined) {
        config.timeWindowMinMy = obj.timeWindowMin;
      }
    }
  } catch (e) {}

  function saveConfig() {
    try { localStorage.setItem('xcp_config', JSON.stringify(config)); } catch (e) {}
  }

  // ===== 布局检测 =====
  // 'new' = 2026 新版 dock；'legacy' = 旧版双列 .col.plate
  function detectLayout() {
    if (document.querySelector('.discover-v2-dock-card')) return 'new';
    if (document.querySelectorAll('.col.plate .card .monitor').length > 0) return 'legacy';
    return null;
  }

  // ===== DOM 定位 =====
  function findMonitorCardItem() {
    const items = document.querySelectorAll('.dock-column-card-item');
    for (const it of items) {
      const t = it.querySelector('.title-text');
      if (t && t.textContent.trim() === '钱包监控') return it;
    }
    return null;
  }

  function findMonitorCard() {
    if (detectLayout() === 'legacy') {
      // 旧版：返回第一个 包含 .monitor 的 .card
      const cards = document.querySelectorAll('.col.plate .card');
      for (const c of cards) {
        if (c.querySelector('.monitor')) return c;
      }
      return null;
    }
    const cards = document.querySelectorAll('.discover-v2-dock-card');
    for (const c of cards) {
      const t = c.querySelector('.title-text');
      if (t && t.textContent.trim() === '钱包监控') return c;
    }
    return null;
  }

  // 旧版：取所有当前显示钱包监控的 .card
  function findAllMonitorCards() {
    const layout = detectLayout();
    if (layout === 'legacy') {
      const cards = document.querySelectorAll('.col.plate .card');
      const result = [];
      cards.forEach(c => {
        if (c.querySelector('.monitor')) result.push(c);
      });
      return result;
    }
    const c = findMonitorCard();
    return c ? [c] : [];
  }

  // 取某张卡当前激活的子 tab：'KOL' / '我的' / null
  function getCardActiveTab(card) {
    if (!card) return null;
    const tabs = card.querySelectorAll('.monitor .hd .tabs li');
    for (const li of tabs) {
      if (li.classList.contains('cur')) {
        const t = li.textContent.trim();
        if (t.includes('KOL')) return 'KOL';
        if (t.includes('我的')) return '我的';
      }
    }
    return null;
  }

  function getActiveOrigTab() {
    return getCardActiveTab(findMonitorCard());
  }

  // ===== 从所有可见钱包监控卡片扫描交易 =====
  function scanOrigDomTrades() {
    const cards = findAllMonitorCards();
    if (cards.length === 0) return;

    let totalCollected = [];

    cards.forEach(card => {
      // 每次扫描顺手刷一下该卡的钱包白名单（用于 scope='panel' 过滤）
      refreshCardAllowlist(card);
      const wrapper = card.querySelector('.vue-recycle-scroller__item-wrapper');
      if (!wrapper) return;
      const activeTab = getCardActiveTab(card);
      if (!activeTab) return;

      wrapper.querySelectorAll('.monitor-item').forEach(item => {
        const trade = parseDomTradeItem(item);
        if (trade) {
          trade.source = activeTab;
          totalCollected.push(trade);
        }
      });
    });

    if (totalCollected.length === 0) return;

    // 按 source 分组合并到 cloneData
    const byKol = totalCollected.filter(t => t.source === 'KOL');
    const byMy = totalCollected.filter(t => t.source === '我的');
    if (byKol.length > 0) cloneData.kol = mergeTrades(cloneData.kol, byKol);
    if (byMy.length > 0) cloneData.my = mergeTrades(cloneData.my, byMy);

    // 喂入聚合检测（DOM trades 通常无地址，canonicalWallet 会回查 name→addr 映射）
    let added = 0;
    for (const t of totalCollected) {
      if (!t.isBuy) continue;
      t.dedupId = canonicalWallet(t);
      const key = `${t.dedupId}|${t.mint || t.token}|${t.timeMs || t.time}`;
      if (addBuyRecord(t, key)) added++;
    }
    if (added > 0) {
      cleanOldRecords();
      checkConvergence();
    }
    renderCloneCard();
  }

  function parseDomTradeItem(item) {
    if (!item.querySelector) return null;
    const monitorItem = item.querySelector('.monitor-item') || item;
    const actionEl = monitorItem.querySelector('dl.row dt');
    if (!actionEl) return null;
    const actionText = actionEl.textContent.trim();
    const isBuy = actionText.includes('买入');
    const isSell = actionText.includes('卖出');
    if (!isBuy && !isSell) return null;

    const walletEl = monitorItem.querySelector('.btn-wallet em');
    const tokenBtnEl = monitorItem.querySelector('.btn-token');
    const tokenEl = tokenBtnEl ? tokenBtnEl.querySelector('em') : null;
    const timeEl = monitorItem.querySelector('.time span');
    const amountEl = monitorItem.querySelector('dl.row dd > em');
    if (!walletEl || !tokenEl || !timeEl) return null;

    const tokenName = tokenEl.textContent.trim();
    let mcap = '';
    monitorItem.querySelectorAll('.flex-wrap dl').forEach(dl => {
      const dt = dl.querySelector('dt');
      if (dt && dt.textContent.includes('市值')) {
        const dd = dl.querySelector('dd');
        if (dd) mcap = dd.textContent.trim();
      }
    });

    const timeStr = timeEl.textContent.trim();
    const tDate = parseTime(timeStr);
    const timeMs = tDate ? tDate.getTime() : Date.now();

    // 从金额单位反推 chain
    const amountText = amountEl ? amountEl.textContent.trim() : '';
    let detectedChain = '';
    if (/\bSOL\b/i.test(amountText)) detectedChain = 'sol';
    else if (/\bBNB\b/i.test(amountText)) detectedChain = 'bsc';
    else if (/\bETH\b/i.test(amountText)) detectedChain = 'eth';
    else if (/\bBASE\b/i.test(amountText)) detectedChain = 'base';

    // 反查 tokenMeta：symbol+chain 必须**唯一匹配**才用
    // 如果同 symbol+chain 已知 2 个及以上 mint（如两个 FREEMAN-pump），无法区分 → 不填 mint
    // 严格模式会跳过这条记录，宁可漏报也不误聚
    let meta = {};
    if (detectedChain) {
      const candidates = [];
      for (const m of tokenMeta.values()) {
        const nameMatch = m.symbol === tokenName || m.name === tokenName;
        if (nameMatch && m.chain === detectedChain) {
          candidates.push(m);
          if (candidates.length > 1) break;   // 不需要枚举完，2+ 就放弃
        }
      }
      if (candidates.length === 1) meta = candidates[0];
    }
    return {
      wallet: walletEl.textContent.trim(),
      token: tokenName,
      tokenSymbol: meta.symbol || tokenName,
      mint: meta.mint || '',
      chain: meta.chain || detectedChain || '',
      logo: meta.logo || '',
      time: timeStr,
      timeMs,
      amount: amountText,
      mcap,
      action: actionText,
      isBuy,
      avatar: '',
      signature: ''
    };
  }

  // ===== 处理 socket.io 推送的钱包交易 =====
  window.addEventListener('message', (ev) => {
    if (!ev.data || !ev.data.__xcp) return;
    if (ev.data.channel === 'wallet-trade') {
      handleWalletTrade(ev.data.payload);
    } else if (ev.data.channel === 'rest-resp') {
      tryExtractWalletGroups(ev.data.payload);
    }
  });

  // ===== 从任意 REST 响应中提取 wallet→group 映射 =====
  function tryExtractWalletGroups(payload) {
    if (!payload || !payload.text) return;
    let json;
    try { json = JSON.parse(payload.text); } catch (e) { return; }
    if (!json) return;

    let added = 0;
    const seen = new WeakSet();
    function walk(o) {
      if (!o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) {
        for (const item of o) walk(item);
        return;
      }
      // 各种可能的字段名
      const walletName = o.walletName || o.name || o.kolName || o.label;
      const groupName = o.groupName || o.group_name || o.group;
      const groupNames = o.groupNames || o.groupList || o.groups;
      if (walletName && (groupName || (Array.isArray(groupNames) && groupNames.length > 0))) {
        const g = groupName || groupNames[0];
        if (typeof g === 'string' && g.trim()) {
          if (walletGroups.get(walletName) !== g) {
            walletGroups.set(walletName, g);
            added++;
          }
        } else if (g && typeof g === 'object' && g.name) {
          if (walletGroups.get(walletName) !== g.name) {
            walletGroups.set(walletName, g.name);
            added++;
          }
        }
      }
      // 递归
      for (const k of Object.keys(o)) walk(o[k]);
    }
    walk(json);
    if (added > 0) {
      lastRenderState = '';
      renderAlerts();
      renderCloneCard();
    }
  }

  // ===== 启动时拉取两边的历史，无需用户点击 tab =====
  async function fetchInitialHistory() {
    const targets = [
      { ch: 1, source: 'my' },
      { ch: 2, source: 'kol' }
    ];
    bulkMode = true;
    pendingConvergenceCheck = false;
    try {
      for (const t of targets) {
        try {
          const url = `${location.origin}/api/trade/wallet/focusWallet/history?channel=${t.ch}&allChain=1`;
          const resp = await fetch(url, { credentials: 'include' });
          if (!resp.ok) continue;
          const json = await resp.json();
          if (!json || !Array.isArray(json.data)) continue;
          for (const item of json.data) {
            handleWalletTrade({ source: t.source, data: item });
          }
        } catch (e) {
          // 网络/Cloudflare 偶发抖动，静默重试由 startHistoryRefresh 兜底
          if (window.__xcpDebug) console.debug('[XCP] init fetch failed', t.ch, e.message);
        }
      }
    } finally {
      bulkMode = false;
      // 一次性结算
      if (pendingConvergenceCheck) {
        cleanOldRecords();
        checkConvergence();
        pendingConvergenceCheck = false;
      }
      lastRenderState = '';
      renderCloneCard();
      renderAlerts();
      setStatus('🟢', `初始化完成 KOL: ${cloneData.kol.length} · 我的: ${cloneData.my.length}`);
    }
  }

  // 周期性主动 refresh（保险，万一 socket.io 短时断开漏推送）
  let refreshHistoryTimer = null;
  function startHistoryRefresh() {
    if (refreshHistoryTimer) clearInterval(refreshHistoryTimer);
    refreshHistoryTimer = setInterval(fetchInitialHistory, 60000);
  }

  // ===== 主动尝试已知钱包列表端点，提取分组映射 =====
  async function fetchWalletGroups() {
    const candidates = [
      '/api/wallet/focusWallet/list',
      '/api/wallet/focus/list',
      '/api/wallet/list',
      '/api/wallet/group/list',
      '/api/data/wallet/list',
      '/api/trackers/list'
    ];
    for (const path of candidates) {
      try {
        const url = `${location.origin}${path}`;
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) continue;
        const text = await resp.text();
        if (!text) continue;
        // 走同一个解析逻辑
        tryExtractWalletGroups({ url, text });
      } catch (e) {}
    }
  }

  let bulkMode = false;
  let pendingConvergenceCheck = false;
  function handleWalletTrade(payload) {
    const { source, data } = payload;
    if (!data || typeof data !== 'object') return;

    const td = data.tradeData || data;
    if (!td) return;

    // 找 token meta（外层对象常见字段名：tokenInfo / token / tokenMeta）
    const tokenInfo = data.tokenInfo || data.token || data.tokenMeta || {};

    const symbol = tokenInfo.symbol || td.symbol || '';
    const name = tokenInfo.name || td.name || '';
    const mint = td.mint || tokenInfo.address || tokenInfo.mint || '';
    const chain = (td.chain || tokenInfo.chain || 'sol').toLowerCase();
    const logo = tokenInfo.imageUrl || tokenInfo.image || tokenInfo.logo || '';

    const tokenKey = symbol || name || mint;
    if (!tokenKey) return;

    // 累积代币元数据：用 mint 索引，避免同名代币互相覆盖
    const metaKey = mint || ('NAME:' + tokenKey);
    if (!tokenMeta.has(metaKey)) {
      tokenMeta.set(metaKey, { mint, chain, symbol, name, logo });
    } else {
      // 补全缺失字段
      const existing = tokenMeta.get(metaKey);
      if (!existing.logo && logo) existing.logo = logo;
      if (!existing.symbol && symbol) existing.symbol = symbol;
      if (!existing.chain && chain) existing.chain = chain;
    }

    const isBuy = td.isBuy === 1 || td.isBuy === true || td.isBuy === '1';
    const tsMs = td.timestamp || td.ts || Date.now();
    const ts = new Date(tsMs);

    // 原列表的格式：amount = nativeUiAmount + native符号
    const nativeAmt = td.nativeUiAmount || td.quoteUiAmount || 0;
    const nativeSymbol = chain === 'sol' ? 'SOL' : chain === 'bsc' ? 'BNB' : chain === 'eth' ? 'ETH' : 'NATIVE';
    const amount = `${formatNum(nativeAmt, 4)} ${nativeSymbol}`;

    const mkt = parseFloat(td.mkt || td.marketCap || (tokenInfo.pairInfo && tokenInfo.pairInfo.marketCap) || 0);
    const mcapStr = formatMcap(mkt);

    // 区分建仓/加仓/清仓/减仓
    let actionLabel;
    if (isBuy) {
      actionLabel = (td.preTokenUiAmount === 0 || td.preTokenUiAmount === '0') ? '🟢 买入 (建仓)' : '🟢 买入 (加仓)';
    } else {
      actionLabel = (td.postTokenUiAmount === 0 || td.postTokenUiAmount === '0') ? '🔴 卖出 (清仓)' : '🔴 卖出 (减仓)';
    }

    const trade = {
      wallet: td.walletName || td.user || 'unknown',
      walletAddr: td.user || '',
      avatar: td.avatar || '',
      token: tokenKey,
      tokenSymbol: symbol,
      mint, chain, logo,
      time: formatDateTime(ts),
      timeMs: tsMs,
      amount,
      mcap: mcapStr,
      action: actionLabel,
      isBuy,
      source: source === 'my' ? '我的' : 'KOL',
      signature: td.signature || '',
      dex: td.dex || td.dexName || '',
      dexId: td.dexId || '',
      platform: detectPlatform(mint, chain, td.dex || td.dexName || '', td.dexId || '')
    };

    // 学习钱包名 → 地址（用来反查 DOM 扫描里没地址的 trade）
    if (trade.walletAddr && trade.wallet && trade.wallet !== trade.walletAddr) {
      walletNameToAddr.set(trade.wallet, trade.walletAddr);
    }

    // 推入对应来源
    cloneData[source] = mergeTrades(cloneData[source], [trade]);

    // 是否清仓（卖出且 post=0）
    const isClose = !isBuy && (td.postTokenUiAmount === 0 || td.postTokenUiAmount === '0');

    // 规范化到 canonical wallet id（addr 优先 → name 反查 → name）
    const dedupId = canonicalWallet(trade);
    trade.dedupId = dedupId;
    const buyKey = `${dedupId}|${trade.mint || trade.token}|${trade.timeMs}`;
    const closeKey = `C|${dedupId}|${trade.mint || trade.token}|${trade.timeMs}`;

    // bulk 模式跳过即时渲染/检测，仅累积数据
    if (bulkMode) {
      if (isBuy) addBuyRecord(trade, buyKey);
      if (isClose) addCloseRecord(trade, closeKey);
      pendingConvergenceCheck = true;
      return;
    }

    // 实时模式：渲染 + 检测
    renderCloneCard();
    setStatus('🟢', `KOL: ${cloneData.kol.length} · 我的: ${cloneData.my.length}`);

    let needCheck = false;
    if (isBuy) needCheck = addBuyRecord(trade, buyKey) || needCheck;
    if (isClose) needCheck = addCloseRecord(trade, closeKey) || needCheck;
    if (needCheck) {
      cleanOldRecords();
      checkConvergence();
    }
  }

  // 添加买入记录，重复时合并 sources（用 Set 装多个来源）
  function addBuyRecord(trade, key) {
    if (seenKeys.has(key)) {
      const existing = buyRecords.find(r =>
        canonicalWallet(r) === trade.dedupId &&
        r.mint === trade.mint && r.timeMs === trade.timeMs
      );
      if (existing) {
        if (!existing.sources) existing.sources = new Set([existing.source]);
        existing.sources.add(trade.source);
      }
      return false;
    }
    seenKeys.add(key);
    trade.sources = new Set([trade.source]);
    buyRecords.push(trade);
    return true;
  }

  function addCloseRecord(trade, key) {
    if (seenClosedKeys.has(key)) return false;
    seenClosedKeys.add(key);
    closedRecords.push(trade);
    return true;
  }

  function mergeTrades(existing, incoming) {
    const map = new Map();
    for (const t of existing) {
      map.set(`${t.wallet}|${t.signature || (t.token + t.timeMs)}`, t);
    }
    for (const t of incoming) {
      map.set(`${t.wallet}|${t.signature || (t.token + t.timeMs)}`, t);
    }
    return Array.from(map.values())
      .sort((a, b) => b.timeMs - a.timeMs)
      .slice(0, 50);
  }

  // ===== 工具函数 =====
  function formatNum(n, decimals) {
    const num = parseFloat(n);
    if (isNaN(num) || num === 0) return '0';
    if (num >= 1) return num.toFixed(decimals).replace(/\.?0+$/, '');
    return num.toPrecision(4);
  }

  function formatMcap(mc) {
    const n = parseFloat(mc);
    if (isNaN(n) || n === 0) return '';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
    return '$' + n.toFixed(2);
  }

  function formatDateTime(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatTime(d) {
    if (!d) return '';
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(pad2).join(':');
  }

  function parseTime(timeStr) {
    const m = timeStr.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  function timeAgo(ms) {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return sec + 's 前';
    if (sec < 3600) return Math.floor(sec / 60) + 'm 前';
    return Math.floor(sec / 3600) + 'h 前';
  }

  // ===== 聚合检测 =====
  function cleanOldRecords() {
    const now = Date.now();
    // 取两个面板里更长的窗口，确保任一面板的检测都不丢数据
    const maxWindowMin = Math.max(config.timeWindowMin, config.timeWindowMinMy);
    const cutoff = maxWindowMin * 60 * 1000;
    buyRecords = buyRecords.filter(r => r.timeMs && (now - r.timeMs) < cutoff);
    closedRecords = closedRecords.filter(r => r.timeMs && (now - r.timeMs) < cutoff * 2);
    if (seenKeys.size > 5000) {
      seenKeys = new Set(Array.from(seenKeys).slice(-2500));
    }
    if (seenClosedKeys.size > 5000) {
      seenClosedKeys = new Set(Array.from(seenClosedKeys).slice(-2500));
    }
    cleanDissolvedAlerts();
  }

  // 全员清仓的提醒保留 5 分钟后自动移除
  const DISSOLVED_KEEP_MS = 5 * 60 * 1000;
  function cleanDissolvedAlerts() {
    const now = Date.now();
    const before = alertsKol.length + alertsMy.length;
    alertsKol = alertsKol.filter(a => !a.dissolvedAt || (now - a.dissolvedAt) < DISSOLVED_KEEP_MS);
    alertsMy  = alertsMy.filter(a => !a.dissolvedAt || (now - a.dissolvedAt) < DISSOLVED_KEEP_MS);
    if (before !== alertsKol.length + alertsMy.length) renderAlerts();
  }

  function checkConvergence() {
    const now = Date.now();

    let totalTriggered = false;
    let highestTierFired = 0;       // 兼容
    let highestTierMain = 0;
    let highestTierMy = 0;

    // 每个面板用自己的阈值 (minWallets / windowMin) + 范围（all / panel）
    // 范围=panel 时叠加白名单过滤（仅该面板所在卡片的钱包）
    const mainPanelScope = config.scopeMain || 'all';
    const myPanelScope = config.scopeMy || 'all';
    const variants = [
      {
        listName: 'kol',
        filter: r => mainPanelScope === 'panel' && panelEl
          ? isWalletInPanelScope(r, panelEl)
          : true,
        minWallets: config.minWallets,
        windowMs: config.timeWindowMin * 60 * 1000
      },
      {
        listName: 'my',
        filter: r => {
          const sourceMatch = (r.sources && r.sources.has('我的')) || r.source === '我的';
          if (!sourceMatch) return false;
          if (myPanelScope === 'panel' && cloneAlertPanelEl) {
            return isWalletInPanelScope(r, cloneAlertPanelEl);
          }
          return true;
        },
        minWallets: config.minWalletsMy,
        windowMs: config.timeWindowMinMy * 60 * 1000
      }
    ];

    for (const v of variants) {
      let list = v.listName === 'kol' ? alertsKol : alertsMy;
      const groups = {};   // 合约地址 → 聚合数据

      for (const r of buyRecords) {
        if (!r.timeMs || (now - r.timeMs) > v.windowMs) continue;
        if (!v.filter(r)) continue;
        // **严格模式**：没有 mint 的记录不参与聚合（避免同名不同 CA 误聚）
        if (!r.mint) continue;
        const key = r.mint;
        if (!groups[key]) {
          groups[key] = {
            wallets: {},
            token: r.token,    // 显示名
            mcap: r.mcap,
            mint: r.mint,
            chain: r.chain,
            platform: r.platform || null
          };
        }
        const g = groups[key];
        // 钱包按 canonical id 分组（动态查 name→addr 映射，不依赖 r.dedupId 旧值）
        const walletKey = canonicalWallet(r);
        if (!g.wallets[walletKey]) {
          // 优先选「我的」做 source 显示（如果该钱包在两个频道都被推送过）
          const isInMy = (r.sources && r.sources.has('我的')) || r.source === '我的';
          g.wallets[walletKey] = {
            displayName: r.wallet,
            amount: r.amount, time: r.time, timeMs: r.timeMs,
            source: isInMy ? '我的' : 'KOL'
          };
        } else {
          // 已存在：如果新记录来源是「我的」，把 source 升级
          const isInMy = (r.sources && r.sources.has('我的')) || r.source === '我的';
          if (isInMy) g.wallets[walletKey].source = '我的';
        }
        if (r.mcap) g.mcap = r.mcap;
        if (!g.chain && r.chain) g.chain = r.chain;
        if (!g.platform && r.platform) g.platform = r.platform;
        if (r.token) g.token = r.token;
      }

      for (const [groupKey, group] of Object.entries(groups)) {
        const walletNames = Object.keys(group.wallets);
        if (walletNames.length < v.minWallets) continue;

        // 给每个钱包打上 closed 标记：买入之后又清仓了
        // walletNames 现在是 dedupId（地址）数组
        const walletDetails = walletNames.map(addr => {
          const wd = group.wallets[addr];
          const closeMatch = closedRecords.find(c =>
            (canonicalWallet(c) === addr) &&
            ((group.mint && c.mint === group.mint) ||
             (!group.mint && !c.mint && c.token === group.token)) &&
            c.timeMs > wd.timeMs
          );
          return {
            name: wd.displayName,    // 用于显示
            addr,                    // 用于跨记录匹配
            amount: wd.amount,
            time: wd.time,
            timeMs: wd.timeMs,
            source: wd.source,
            closed: !!closeMatch,
            closedAt: closeMatch ? closeMatch.timeMs : null
          };
        });
        const closedCount = walletDetails.filter(w => w.closed).length;
        const effectiveCount = walletNames.length - closedCount;

        const times = walletDetails.map(w => w.timeMs).filter(Boolean);
        const earliest = new Date(Math.min(...times));
        const latest = new Date(Math.max(...times));
        const timeRange = formatTime(earliest) + ' ~ ' + formatTime(latest);

        // 严格按 mint 匹配（group.mint 一定存在，因为前面 filter 过了）
        const existing = list.find(a => a.mint && a.mint === group.mint);
        // tier 用 effective（清仓的不计入热度），用本面板自己的阈值
        const newTier = calcTier(effectiveCount, v.minWallets);

        if (existing) {
          const sameCount = existing.walletCount === walletNames.length;
          const sameClose = (existing.closedCount || 0) === closedCount;
          if (sameCount && sameClose) continue;
          const prevTier = existing.tier || calcTier(existing.effectiveCount || existing.walletCount, v.minWallets);
          existing.walletCount = walletNames.length;
          existing.effectiveCount = effectiveCount;
          existing.closedCount = closedCount;
          // 全员清仓 → 标记 dissolvedAt（之后 5 分钟由 cleanDissolvedAlerts 移除）；又有人买回来 → 清掉
          if (effectiveCount === 0) {
            if (!existing.dissolvedAt) existing.dissolvedAt = Date.now();
          } else {
            existing.dissolvedAt = null;
          }
          existing.wallets = walletDetails;
          existing.mcap = group.mcap || existing.mcap;
          existing.timeRange = timeRange;
          existing.token = group.token;
          existing.mint = group.mint || existing.mint;
          existing.chain = group.chain || existing.chain;
          existing.tier = newTier;
          existing.platform = group.platform || existing.platform;
          existing.isNew = true;
          existing.updatedAt = Date.now();
          // 仅升档发声（清仓导致的降档不响）
          if (newTier > prevTier && newTier > highestTierFired) {
            highestTierFired = newTier;
          }
          if (newTier > prevTier) {
            if (v.listName === 'kol' && newTier > highestTierMain) highestTierMain = newTier;
            else if (v.listName === 'my' && newTier > highestTierMy) highestTierMy = newTier;
          }
          setTimeout(() => { existing.isNew = false; renderAlerts(); }, 1500);
        } else {
          const alert = {
            token: group.token,
            source: v.listName,
            mint: group.mint,
            chain: group.chain,
            platform: group.platform,
            walletCount: walletNames.length,
            effectiveCount,
            closedCount,
            wallets: walletDetails,
            mcap: group.mcap,
            timeRange,
            tier: newTier,
            triggeredAt: Date.now(),
            isNew: true
          };
          list.unshift(alert);
          if (list.length > 20) {
            if (v.listName === 'kol') alertsKol = list.slice(0, 20);
            else alertsMy = list.slice(0, 20);
          }
          totalTriggered = true;
          if (newTier > highestTierFired) highestTierFired = newTier;
          if (v.listName === 'kol' && newTier > highestTierMain) highestTierMain = newTier;
          else if (v.listName === 'my' && newTier > highestTierMy) highestTierMy = newTier;
          setTimeout(() => { alert.isNew = false; renderAlerts(); }, 1500);
        }
      }
    }

    renderAlerts();
    // 按各自面板的声音开关分别响
    if (highestTierMain > 0 && config.soundEnabledMain) {
      playSound(highestTierMain);
    }
    if (highestTierMy > 0 && config.soundEnabledMy) {
      playSound(highestTierMy);
    }
    if (totalTriggered) flashBadge();
  }

  let _audioCtx = null;
  let _audioReady = false;
  function ensureAudioCtx() {
    if (_audioReady) return _audioCtx;
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      _audioReady = true;
      return _audioCtx;
    } catch (e) { return null; }
  }
  // 等用户首次点击页面后再创建 AudioContext，规避 autoplay 警告
  document.addEventListener('click', () => {
    if (!_audioReady) ensureAudioCtx();
  }, { once: true, capture: true });

  // 档位分级：tier = min(4, walletCount - minWallets + 1)
  // 开关关闭时永远返回 1（无视觉/声音升级）
  function calcTier(walletCount, minWalletsArg) {
    if (!config.tieredAlerts) return 1;
    const mw = minWalletsArg != null ? minWalletsArg : config.minWallets;
    return Math.min(4, Math.max(1, walletCount - mw + 1));
  }

  function playSound(tier) {
    const ctx = ensureAudioCtx();
    if (!ctx || ctx.state === 'suspended') return;
    tier = tier || 1;
    try {
      if (tier === 1) {
        // 普通：2 声 880Hz
        playBeepSeq(ctx, [{ f: 880, t: 0, d: 0.1 }, { f: 880, t: 0.15, d: 0.1 }], 0.25);
      } else if (tier === 2) {
        // 升温：3 声 1000Hz，间隔 0.10s
        playBeepSeq(ctx, [
          { f: 1000, t: 0, d: 0.08 },
          { f: 1000, t: 0.10, d: 0.08 },
          { f: 1000, t: 0.20, d: 0.08 }
        ], 0.27);
      } else if (tier === 3) {
        // 火热：5 声 1100Hz + 微和弦（叠 1320Hz）
        const seq = [];
        for (let i = 0; i < 5; i++) {
          seq.push({ f: 1100, t: i * 0.07, d: 0.06 });
          seq.push({ f: 1320, t: i * 0.07, d: 0.06 });   // 叠和弦
        }
        playBeepSeq(ctx, seq, 0.20);
      } else {
        // 暴动：扫频 880→1760Hz，0.4s
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.4);
        gain.gain.setValueAtTime(0.30, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
        // 叠一个反向扫频造紧张感
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2); gain2.connect(ctx.destination);
        osc2.type = 'square';
        osc2.frequency.setValueAtTime(440, ctx.currentTime);
        osc2.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.4);
        gain2.gain.setValueAtTime(0.10, ctx.currentTime);
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc2.start(ctx.currentTime);
        osc2.stop(ctx.currentTime + 0.4);
      }
    } catch (e) {}
  }

  function playBeepSeq(ctx, seq, baseGain) {
    for (const s of seq) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = s.f;
      gain.gain.value = baseGain;
      osc.start(ctx.currentTime + s.t);
      osc.stop(ctx.currentTime + s.t + s.d);
    }
  }

  function flashBadge() {
    const badge = panelEl?.querySelector('.xcp-badge');
    if (!badge) return;
    badge.classList.add('is-active');
    setTimeout(() => badge.classList.remove('is-active'), 3000);
  }

  // ===== 提醒面板（参数化，KOL/我的 共用同一套结构） =====
  function createAlertPanel(opts) {
    // opts: { source: 'KOL'|'我的', themeClass, titleEmoji, titleText, showStarList, showSound, id }
    const o = opts || {};
    const collapsedKey = o.source === '我的' ? 'collapsedMy' : 'collapsed';
    const isCollapsed = !!config[collapsedKey];
    const el = document.createElement('div');
    el.className = 'xcp-inline ' + (o.themeClass || '') + (isCollapsed ? ' collapsed' : '');
    if (o.id) el.id = o.id;
    el.dataset.source = o.source || 'KOL';

    const isMyPanel = o.source === '我的';
    const scopeKey = isMyPanel ? 'scopeMy' : 'scopeMain';
    const floatKey = isMyPanel ? 'floatingMy' : 'floatingMain';
    const curScope = config[scopeKey] || 'all';
    const curFloat = !!config[floatKey];

    const headerExtras = [];
    if (o.showStarList !== false) headerExtras.push('<button class="xcp-icon-btn xcp-star-btn" title="特别关注列表">★ <span class="xcp-star-count">0</span></button>');
    headerExtras.push('<button class="xcp-icon-btn xcp-scope-btn" title="' + (curScope === 'panel' ? '聚合范围：仅本面板（点击切到全页面）' : '聚合范围：全页面（点击切到仅本面板）') + '">' + (curScope === 'panel' ? '📍' : '🌐') + '</button>');
    headerExtras.push('<button class="xcp-icon-btn xcp-float-btn" title="' + (curFloat ? '浮窗模式：开（点击关）' : '浮窗模式：关（点击开）') + '">' + (curFloat ? '🪟' : '📌') + '</button>');
    headerExtras.push('<button class="xcp-icon-btn xcp-tier-btn" title="分级提醒开关">' + (config.tieredAlerts ? '🔥' : '🌫️') + '</button>');
    if (o.showSound !== false) headerExtras.push('<button class="xcp-icon-btn xcp-sound-btn" title="声音开关">🔔</button>');

    el.innerHTML = `
      <div class="xcp-header">
        <div class="xcp-header-left">
          <span class="xcp-toggle-arrow">▼</span>
          <span>${escHtml(o.titleEmoji || '🔥')} ${escHtml(o.titleText || '聚合买入提醒')}</span>
          <span class="xcp-badge">0</span>
        </div>
        <div class="xcp-header-right">
          ${headerExtras.join('')}
        </div>
      </div>
      <div class="xcp-star-list" style="display:none;"></div>
      <div class="xcp-settings">
        <label>≥ <input type="number" class="xcp-min-wallets" min="2" max="20" value="${config.minWallets}"> 钱包</label>
        <label>内 <input type="number" class="xcp-time-window" min="1" max="60" value="${config.timeWindowMin}"> 分钟</label>
        <span class="xcp-status" title="数据捕获状态">⚪</span>
      </div>
      <div class="xcp-alerts"><div class="xcp-empty">监听中…等待信号</div></div>
      <button class="xcp-clear-btn">清空提醒</button>
    `;
    return el;
  }

  // ===== 面板 ↔ 监控卡片的映射 + 该卡片可见钱包白名单（用于 scope='panel' 过滤）=====
  // 每张卡持续累积出现过的钱包（dedupId 优先，没有就 displayName），让用户滚动后白名单越来越完整
  const cardWalletAllowlists = new WeakMap();
  function getPanelHomeCard(panelEl) {
    // 优先看记忆的原始嵌入位置；否则看当前 DOM
    const home = panelHomes.get(panelEl);
    const ref = (home && home.parent) || panelEl.parentElement;
    if (!ref) return null;
    return ref.closest('.discover-v2-dock-card') || ref.closest('.col.plate .card') || null;
  }
  function refreshCardAllowlist(card) {
    if (!card) return;
    let set = cardWalletAllowlists.get(card);
    if (!set) { set = new Set(); cardWalletAllowlists.set(card, set); }
    card.querySelectorAll('.monitor-item').forEach(item => {
      const walletEl = item.querySelector('.btn-wallet em');
      if (!walletEl) return;
      const name = walletEl.textContent.trim();
      if (!name) return;
      set.add(name);
      // 同时把 nameToAddr 映射里的地址也加入（如果有）
      const addr = walletNameToAddr.get(name);
      if (addr) set.add(addr);
    });
  }
  function isWalletInPanelScope(record, panelEl) {
    const card = getPanelHomeCard(panelEl);
    if (!card) return true;  // 找不到归属卡，不过滤
    const set = cardWalletAllowlists.get(card);
    if (!set || set.size === 0) return true;  // 白名单空，先放过（避免一开始 0 行直接屏蔽所有）
    const wallet = record.wallet;
    const addr = record.walletAddr || (record.dedupId && record.dedupId !== record.wallet ? record.dedupId : null);
    return set.has(wallet) || (addr && set.has(addr));
  }

  // ===== 浮窗模式：把面板从原位置 detach，作为 fixed 浮窗附到 body，可拖动 =====
  const panelHomes = new WeakMap();  // 记住 panel 的原始嵌入位置（parent + nextSibling）
  function applyFloatingMode(panelEl, source, enable) {
    if (enable) {
      if (!panelHomes.has(panelEl)) {
        panelHomes.set(panelEl, {
          parent: panelEl.parentElement,
          next: panelEl.nextSibling
        });
      }
      panelEl.classList.add('xcp-floating');
      const posKey = source === '我的' ? 'posMy' : 'posMain';
      const pos = config[posKey];
      if (pos && pos.right != null) panelEl.style.right = pos.right + 'px';
      if (pos && pos.top != null) panelEl.style.top = pos.top + 'px';
      if (panelEl.parentElement !== document.body) {
        document.body.appendChild(panelEl);
      }
      enableDragFor(panelEl, source);
    } else {
      panelEl.classList.remove('xcp-floating');
      panelEl.style.right = '';
      panelEl.style.top = '';
      const home = panelHomes.get(panelEl);
      if (home && home.parent && document.body.contains(home.parent)) {
        if (home.next && home.next.parentElement === home.parent) {
          home.parent.insertBefore(panelEl, home.next);
        } else {
          home.parent.appendChild(panelEl);
        }
      }
    }
  }

  function enableDragFor(panelEl, source) {
    if (panelEl.__xcpDragBound) return;
    panelEl.__xcpDragBound = true;
    const header = panelEl.querySelector('.xcp-header');
    if (!header) return;
    let dragging = false, sx = 0, sy = 0, sr = 0, st = 0;
    header.addEventListener('mousedown', (e) => {
      if (!panelEl.classList.contains('xcp-floating')) return;
      if (e.target.closest('.xcp-icon-btn')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = panelEl.getBoundingClientRect();
      sr = window.innerWidth - r.right;
      st = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const newRight = Math.max(0, Math.min(window.innerWidth - 100, sr - (e.clientX - sx)));
      const newTop = Math.max(0, Math.min(window.innerHeight - 40, st + (e.clientY - sy)));
      panelEl.style.right = newRight + 'px';
      panelEl.style.top = newTop + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const r = panelEl.getBoundingClientRect();
      const posKey = source === '我的' ? 'posMy' : 'posMain';
      config[posKey] = {
        right: Math.round(window.innerWidth - r.right),
        top: Math.round(r.top)
      };
      saveConfig();
    });
  }

  function bindPanelEvents(rootEl) {
    if (!rootEl) return;
    const source = rootEl.dataset.source || 'KOL';
    const collapsedKey = source === '我的' ? 'collapsedMy' : 'collapsed';

    rootEl.querySelector('.xcp-header').addEventListener('click', (e) => {
      if (e.target.closest('.xcp-icon-btn')) return;
      rootEl.classList.toggle('collapsed');
      config[collapsedKey] = rootEl.classList.contains('collapsed');
      saveConfig();
    });

    const soundBtn = rootEl.querySelector('.xcp-sound-btn');
    if (soundBtn) {
      const soundKey = source === '我的' ? 'soundEnabledMy' : 'soundEnabledMain';
      soundBtn.textContent = config[soundKey] ? '🔔' : '🔕';
      soundBtn.title = config[soundKey] ? `本面板声音：开（点击关）` : `本面板声音：关（点击开）`;
      soundBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        config[soundKey] = !config[soundKey];
        soundBtn.textContent = config[soundKey] ? '🔔' : '🔕';
        soundBtn.title = config[soundKey] ? `本面板声音：开（点击关）` : `本面板声音：关（点击开）`;
        saveConfig();
      });
    }

    // 范围切换：仅本面板 vs 全页面
    const scopeBtn = rootEl.querySelector('.xcp-scope-btn');
    if (scopeBtn) {
      const scopeKey = source === '我的' ? 'scopeMy' : 'scopeMain';
      scopeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        config[scopeKey] = config[scopeKey] === 'panel' ? 'all' : 'panel';
        scopeBtn.textContent = config[scopeKey] === 'panel' ? '📍' : '🌐';
        scopeBtn.title = config[scopeKey] === 'panel'
          ? '聚合范围：仅本面板（点击切到全页面）'
          : '聚合范围：全页面（点击切到仅本面板）';
        saveConfig();
        // 切换后重新跑一遍聚合（清掉对应面板已有 alert）
        if (source === '我的') alertsMy = [];
        else alertsKol = [];
        checkConvergence();
        renderAlerts();
      });
    }

    // 浮窗模式切换
    const floatBtn = rootEl.querySelector('.xcp-float-btn');
    if (floatBtn) {
      const floatKey = source === '我的' ? 'floatingMy' : 'floatingMain';
      // 初次绑定：如果配置已开启，立刻应用浮窗（重新挂载）
      if (config[floatKey]) {
        applyFloatingMode(rootEl, source, true);
      }
      floatBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        config[floatKey] = !config[floatKey];
        floatBtn.textContent = config[floatKey] ? '🪟' : '📌';
        floatBtn.title = config[floatKey]
          ? '浮窗模式：开（点击关）'
          : '浮窗模式：关（点击开）';
        saveConfig();
        applyFloatingMode(rootEl, source, config[floatKey]);
      });
    }

    const tierBtn = rootEl.querySelector('.xcp-tier-btn');
    if (tierBtn) {
      tierBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        config.tieredAlerts = !config.tieredAlerts;
        document.querySelectorAll('.xcp-tier-btn').forEach(b => {
          b.textContent = config.tieredAlerts ? '🔥' : '🌫️';
          b.title = config.tieredAlerts ? '分级提醒：开（点击关闭）' : '分级提醒：关（点击开启）';
        });
        saveConfig();
        // 立刻重渲所有面板（已有提醒的 tier 重算，各用各的阈值）
        for (const a of alertsKol) a.tier = calcTier(a.effectiveCount || a.walletCount, config.minWallets);
        for (const a of alertsMy) a.tier = calcTier(a.effectiveCount || a.walletCount, config.minWalletsMy);
        renderAlerts();
      });
    }

    // 阈值绑定到本面板自己的 config 字段（不再跨面板同步）
    const mwKey = source === '我的' ? 'minWalletsMy' : 'minWallets';
    const twKey = source === '我的' ? 'timeWindowMinMy' : 'timeWindowMin';

    const minW = rootEl.querySelector('.xcp-min-wallets');
    minW.value = config[mwKey];
    minW.addEventListener('change', (e) => {
      config[mwKey] = Math.max(2, parseInt(e.target.value) || 2);
      e.target.value = config[mwKey];
      saveConfig(); resetAndRescan();
    });
    minW.addEventListener('click', e => e.stopPropagation());

    const tw = rootEl.querySelector('.xcp-time-window');
    tw.value = config[twKey];
    tw.addEventListener('change', (e) => {
      config[twKey] = Math.max(1, parseInt(e.target.value) || 5);
      e.target.value = config[twKey];
      saveConfig(); resetAndRescan();
    });
    tw.addEventListener('click', e => e.stopPropagation());

    rootEl.querySelector('.xcp-settings').addEventListener('click', e => e.stopPropagation());
    rootEl.querySelector('.xcp-alerts').addEventListener('click', e => e.stopPropagation());
    rootEl.querySelector('.xcp-clear-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (source === '我的') alertsMy = [];
      else alertsKol = [];
      renderAlerts();
    });

    // 星标列表展开/收起
    const starBtn = rootEl.querySelector('.xcp-star-btn');
    const starList = rootEl.querySelector('.xcp-star-list');
    if (starBtn && starList) {
      starBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = starList.style.display !== 'none';
        starList.style.display = open ? 'none' : 'block';
        if (!open) renderStarList(starList);
      });
      starList.addEventListener('click', e => e.stopPropagation());
    }
    updateStarBadge();
  }

  function renderStarList(targetEl) {
    const els = targetEl ? [targetEl] : Array.from(document.querySelectorAll('.xcp-star-list'));
    els.forEach(el => {
      if (!el) return;
      if (starred.size === 0) {
        el.innerHTML = '<div class="xcp-star-empty">还没有特别关注 — 在交易行点 ☆ 添加</div>';
        return;
      }
      el.innerHTML = `
        <div class="xcp-star-list-head">特别关注 (${starred.size})</div>
        <div class="xcp-star-list-body">
          ${Array.from(starred).map(name => `
            <span class="xcp-star-chip">
              ★ ${escHtml(name)}
              <span class="xcp-star-remove" data-wallet="${escHtml(name)}" title="移除">×</span>
            </span>
          `).join('')}
        </div>
      `;
      el.querySelectorAll('.xcp-star-remove').forEach(x => {
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleStar(x.dataset.wallet);
          renderStarList();
        });
      });
    });
  }

  function resetAndRescan() {
    alertsKol = []; alertsMy = [];
    seenKeys.clear();
    buyRecords = [];
    // 重新喂入两个来源（用 addBuyRecord 跑同一套去重 + sources 合并逻辑）
    // 用最大窗口，确保两边面板各自检测时数据都齐
    const maxWindowMs = Math.max(config.timeWindowMin, config.timeWindowMinMy) * 60 * 1000;
    const fillFrom = (arr, sourceTag) => {
      for (const t of arr) {
        if (!t.isBuy || !t.timeMs) continue;
        if ((Date.now() - t.timeMs) >= maxWindowMs) continue;
        const tagged = { ...t, source: sourceTag };
        tagged.dedupId = tagged.walletAddr || tagged.wallet;
        const key = `${tagged.dedupId}|${tagged.mint || tagged.token}|${tagged.timeMs}`;
        addBuyRecord(tagged, key);
      }
    };
    fillFrom(cloneData.kol, 'KOL');
    fillFrom(cloneData.my, '我的');
    checkConvergence();
    renderAlerts();
  }

  function renderAlertItem(a, isMy) {
    const hasStar = isAlertStarred(a);
    const closedCount = a.closedCount || 0;
    const effective = (a.effectiveCount != null) ? a.effectiveCount : a.walletCount;
    const tier = a.tier || calcTier(effective, isMy ? config.minWalletsMy : config.minWallets);
    const tierIcon = tier >= 4 ? ' 🚨' : tier >= 3 ? ' 🔥' : tier >= 2 ? ' ⚡' : '';
    // 主面板显示 KOL/我的 来源混合统计
    let mixSummary = '';
    if (!isMy) {
      const kolCount = a.wallets.filter(w => w.source === 'KOL').length;
      const myCount = a.wallets.filter(w => w.source === '我的').length;
      const parts = [];
      if (kolCount > 0) parts.push(`KOL ${kolCount}`);
      if (myCount > 0) parts.push(`<span class="xcp-mix-my">★我的 ${myCount}</span>`);
      if (parts.length > 1) mixSummary = ' · ' + parts.join(' + ');
    }
    const panelMinWallets = isMy ? config.minWalletsMy : config.minWallets;
    const isFaded = effective < panelMinWallets;   // 有效钱包已不够 → 降级显示
    return `
      <div class="xcp-alert-item xcp-tier-${tier} ${a.isNew ? 'is-new' : ''} ${isMy ? 'is-my-source' : ''} ${hasStar ? 'is-starred' : ''} ${isFaded ? 'is-faded' : ''}" data-token="${escHtml(a.token)}">
        <div class="xcp-alert-token">
          <span class="xcp-alert-token-name xcp-token-link" data-token="${escHtml(a.token)}" data-mint="${escHtml(a.mint || '')}" data-chain="${escHtml(a.chain || '')}" title="跳转到 ${escHtml(a.token)} 交易页">${escHtml(a.token)} ↗</span>${a.mint ? `<span class="xcp-mint-tag" title="合约：${escHtml(a.mint)}（点击复制）" data-mint="${escHtml(a.mint)}">${escHtml(shortMint(a.mint))}</span>` : ''}${a.platform ? `<span class="xcp-plat-badge ${escHtml(a.platform.cls)}" title="${escHtml(a.platform.label)}">${escHtml(a.platform.tag)}</span>` : ''}
          <span class="xcp-alert-count">${effective} 个钱包${closedCount > 0 ? ` <span class="xcp-closed-tag">−${closedCount} 清仓</span>` : ''}${tierIcon}</span>
        </div>
        <div class="xcp-alert-time">${escHtml(a.timeRange)}${a.mcap ? ' · 市值 ' + escHtml(a.mcap) : ''}${mixSummary}</div>
        <div class="xcp-alert-wallets">
          ${a.wallets.map(w => {
            const star = starred.has(w.name);
            const sourceMark = w.source === '我的' ? '<span class="xcp-src-my" title="我的">★</span>' : '';
            const grp = walletGroups.get(w.name);
            const grpTag = grp ? `<span class="xcp-wallet-group" title="分组">${escHtml(grp)}</span>` : '';
            return `
            <span class="xcp-alert-wallet-tag ${star ? 'is-starred' : ''} ${w.source === '我的' ? 'is-my-wallet' : ''} ${w.closed ? 'is-closed' : ''}" title="${w.closed ? '已清仓' : ''}">
              <span class="xcp-star-toggle ${star ? 'on' : ''}" data-wallet="${escHtml(w.name)}" title="${star ? '取消特别关注' : '加入特别关注'}">${star ? '★' : '☆'}</span>
              ${sourceMark}${escHtml(w.name)}${grpTag}
              <span class="xcp-wallet-amount">${escHtml(w.amount)}</span>
            </span>
          `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function renderAlerts() {
    // 渲染 KOL 主面板
    if (panelEl) {
      const container = panelEl.querySelector('.xcp-alerts');
      const badge = panelEl.querySelector('.xcp-badge');
      if (container && badge) {
        badge.textContent = alertsKol.length;
        if (alertsKol.length === 0) {
          container.innerHTML = '<div class="xcp-empty">监听中…等待 KOL 聚合信号</div>';
        } else {
          container.innerHTML = alertsKol.map(a => renderAlertItem(a, false)).join('');
        }
        bindAlertEvents(container);
      }
    }
    // 渲染嵌入克隆卡的 我的 面板
    if (cloneAlertPanelEl) {
      const container = cloneAlertPanelEl.querySelector('.xcp-alerts');
      const badge = cloneAlertPanelEl.querySelector('.xcp-badge');
      if (container && badge) {
        badge.textContent = alertsMy.length;
        if (alertsMy.length === 0) {
          container.innerHTML = '<div class="xcp-empty">监听中…等待 我的 聚合信号</div>';
        } else {
          container.innerHTML = alertsMy.map(a => renderAlertItem(a, true)).join('');
        }
        bindAlertEvents(container);
      }
    }
    updateStarBadge();
    // trigger 克隆卡 trade 列表的星标 / 状态同步（不会真正闪，因 lastRenderState 比对）
    renderCloneCard();
  }

  function bindAlertEvents(container) {
    container.querySelectorAll('.xcp-token-link').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToToken(el.dataset.token, el.dataset.mint, el.dataset.chain);
      });
    });
    container.querySelectorAll('.xcp-mint-tag').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const fullMint = el.dataset.mint || '';
        try {
          navigator.clipboard.writeText(fullMint);
          const oldText = el.textContent;
          el.textContent = '已复制';
          setTimeout(() => { el.textContent = oldText; }, 1000);
        } catch (e2) {}
      });
    });
    container.querySelectorAll('.xcp-star-toggle').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStar(el.dataset.wallet);
      });
    });
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function setStatus(emoji, title) {
    // 兼容旧调用：如果有调用方传 emoji+title 就直接显示；否则用通用诊断
    if (!panelEl) return;
    document.querySelectorAll('.xcp-status').forEach(st => {
      if (emoji && /^[🟢🔴⚪⚠️🔍]/.test(emoji)) {
        // 显式调用，仍按详细格式更新
      }
      const pool = buyRecords.length;
      const closes = closedRecords.length;
      const kCount = cloneData.kol.length;
      const mCount = cloneData.my.length;
      st.textContent = pool > 0 ? `🔍 池 ${pool}` : '🔍 等待';
      st.title = `KOL: ${kCount} 笔 · 我的: ${mCount} 笔\n池中买入: ${pool}${closes ? ' · 清仓: ' + closes : ''}`;
      if (pool > 0) {
        st.classList.add('is-ok');
        st.classList.remove('is-warn');
      } else {
        st.classList.remove('is-ok');
        st.classList.remove('is-warn');
      }
    });
  }

  // ===== 页面内跳转（不触发整页刷新）=====
  function spaNavigate(url) {
    try {
      history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function jumpToToken(token, mint, chain) {
    // 策略 1（优先）：有 mint+chain 时直接用 SPA pushState（精准到 CA，不受同名影响）
    let useChain = chain, useMint = mint;
    if (!useMint || !useChain) {
      let meta = mint ? tokenMeta.get(mint) : null;
      if (!meta) {
        for (const m of tokenMeta.values()) {
          if (m.symbol === token || m.name === token) { meta = m; break; }
        }
      }
      if (meta) { useMint = useMint || meta.mint; useChain = useChain || meta.chain; }
    }
    if (useMint && useChain) {
      const url = `/${useChain}/${useMint}`;
      if (spaNavigate(url)) return;
      window.location.href = location.origin + url;
      return;
    }

    // 策略 2（兜底）：没有 mint → 在原卡里按名字找 .btn-token click
    // 警告：同名不同 CA 时这步会匹到第一个，不准
    const cards = findAllMonitorCards();
    for (const card of cards) {
      const items = card.querySelectorAll('.monitor-item');
      for (const item of items) {
        const tEl = item.querySelector('.btn-token em');
        if (tEl && tEl.textContent.trim() === token) {
          const btn = item.querySelector('.btn-token');
          if (btn) { btn.click(); return; }
        }
      }
    }

    alert('找不到 ' + token + ' 的合约信息');
  }

  // ===== 克隆卡（双栏 KOL + 我的）=====
  function buildCloneCard() {
    const orig = findMonitorCardItem();
    if (!orig) return null;
    const clone = orig.cloneNode(true);
    clone.id = 'xcp-clone-card';
    clone.classList.add('xcp-clone-card');

    // 改标题
    const title = clone.querySelector('.title-text');
    if (title) title.textContent = '钱包监控 · 实时镜像';

    // 移除原卡复制过来的提醒面板
    const oldPanel = clone.querySelector('#xcp-inline-panel');
    if (oldPanel) oldPanel.remove();

    // 重写 tabs（使其切换我们的视图）
    const tabsEl = clone.querySelector('.monitor .hd .tabs');
    if (tabsEl) {
      tabsEl.innerHTML = `
        <li class="${config.cloneTab === 'KOL' ? 'cur' : ''}" data-xcp-tab="KOL">KOL</li>
        <li class="${config.cloneTab === '我的' ? 'cur' : ''}" data-xcp-tab="我的">我的 ★</li>
      `;
      tabsEl.querySelectorAll('li').forEach(li => {
        li.addEventListener('click', (e) => {
          e.stopPropagation();
          config.cloneTab = li.dataset.xcpTab;
          saveConfig();
          tabsEl.querySelectorAll('li').forEach(x => x.classList.remove('cur'));
          li.classList.add('cur');
          renderCloneCard();
        });
      });
    }

    // 替换 .bd 内容为我们的渲染容器
    const bd = clone.querySelector('.monitor .bd');
    if (bd) {
      bd.innerHTML = '<div class="xcp-clone-list"><div class="xcp-clone-empty">等待 socket.io 推送…</div></div>';
    }

    // 隐藏右上角的关闭按钮
    const closeBtn = clone.querySelector('.card-header .close, .card-header [class*="close"]');
    if (closeBtn) closeBtn.style.display = 'none';

    return clone;
  }

  // 节流 + 增量渲染
  let renderClonePending = false;
  let lastRenderState = '';
  let cloneAlertPanelEl = null;  // 克隆卡内嵌的 我的聚合面板
  function renderCloneCard() {
    if (!cloneCardEl) return;
    if (renderClonePending) return;
    renderClonePending = true;
    requestAnimationFrame(() => {
      renderClonePending = false;
      doRenderCloneCard();
    });
  }

  function tradeKey(t) {
    return `${t.wallet}|${t.signature || (t.token + '|' + t.timeMs)}`;
  }

  function doRenderCloneCard() {
    if (!cloneCardEl) return;
    const bd = cloneCardEl.querySelector('.monitor .bd');
    if (!bd) return;
    let list = bd.querySelector('.xcp-clone-list');
    if (!list) {
      list = document.createElement('div');
      list.className = 'xcp-clone-list';
      bd.appendChild(list);
    }

    const tabKey = config.cloneTab === '我的' ? 'my' : 'kol';
    const trades = cloneData[tabKey] || [];

    // 在 .bd 上方挂"我的聚合"完整面板（仅 我的 tab 显示）
    if (tabKey === 'my') {
      if (!cloneAlertPanelEl || !document.body.contains(cloneAlertPanelEl)) {
        cloneAlertPanelEl = createAlertPanel({
          source: '我的',
          themeClass: 'xcp-inline-my',
          titleEmoji: '★',
          titleText: '我的 聚合',
          showStarList: true,
          showSound: true,
          id: 'xcp-clone-alert-panel'
        });
        const monitorEl = cloneCardEl.querySelector('.monitor');
        if (monitorEl) monitorEl.insertBefore(cloneAlertPanelEl, bd);
        bindPanelEvents(cloneAlertPanelEl);
        // 立即渲染一次现有 alerts
        const c = cloneAlertPanelEl.querySelector('.xcp-alerts');
        const b = cloneAlertPanelEl.querySelector('.xcp-badge');
        if (c && b) {
          b.textContent = alertsMy.length;
          c.innerHTML = alertsMy.length === 0
            ? '<div class="xcp-empty">监听中…等待 我的 聚合信号</div>'
            : alertsMy.map(a => renderAlertItem(a, true)).join('');
          bindAlertEvents(c);
        }
      } else {
        cloneAlertPanelEl.style.display = '';
      }
    } else {
      // 切回 KOL 时隐藏 我的 面板
      if (cloneAlertPanelEl) cloneAlertPanelEl.style.display = 'none';
    }

    let bodyHtml;
    if (trades.length === 0) {
      bodyHtml = `<div class="xcp-clone-empty">
        等待 ${escHtml(config.cloneTab)} 数据…
        <br><small>${tabKey === 'my' ? '需要先在原卡点击「我的」加载，或等 socket.io 推送' : ''}</small>
      </div>`;
    } else {
      bodyHtml = trades.map(t => {
        const cls = t.isBuy ? 'is-buy' : 'is-sell';
        const dot = t.isBuy ? '🟢' : '🔴';
        const action = (t.action || '').replace(/^[🟢🔴]\s*/, '');
        const star = starred.has(t.wallet);
        const tokenMetaInfo = tokenMeta.get(t.mint || ('NAME:' + t.token)) || {};
        const tokenLogo = t.logo || tokenMetaInfo.logo || '';
        return `
        <div class="xcp-clone-row ${cls} ${star ? 'is-starred' : ''}" data-key="${escHtml(tradeKey(t))}">
          <div class="xcp-clone-row-head">
            <span class="xcp-clone-time">${escHtml(t.time)}</span>
            <span class="xcp-clone-ago">${escHtml(timeAgo(t.timeMs))}</span>
          </div>
          <div class="xcp-clone-wallet">
            <span class="xcp-star-toggle ${star ? 'on' : ''}" data-wallet="${escHtml(t.wallet)}" title="${star ? '取消特别关注' : '加入特别关注'}">${star ? '★' : '☆'}</span>
            ${t.avatar ? `<img class="xcp-clone-avatar" src="${escHtml(t.avatar)}" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="xcp-clone-avatar-fallback"></span>'}
            <span class="xcp-clone-wallet-name">[ ${escHtml(t.wallet)} ]</span>
          </div>
          <div class="xcp-clone-action">
            <span class="xcp-clone-dot">${dot}</span>
            <span class="xcp-clone-act">${escHtml(action)}</span>
            <span class="xcp-clone-amount">${escHtml(t.amount)}</span>
            <span class="xcp-clone-token-pill" data-token="${escHtml(t.token)}" data-mint="${escHtml(t.mint || '')}" data-chain="${escHtml(t.chain || '')}">
              ${tokenLogo ? `<img class="xcp-clone-token-logo" src="${escHtml(tokenLogo)}" loading="lazy" referrerpolicy="no-referrer" />` : ''}
              <span class="xcp-clone-token-name">${escHtml(t.token)}</span>
            </span>
          </div>
          <div class="xcp-clone-meta">${t.mcap ? '市值: ' + escHtml(t.mcap) : ''} ${t.chain ? '· ' + escHtml(t.chain.toUpperCase()) : ''}</div>
        </div>`;
      }).join('');
    }

    const newHtml = bodyHtml;
    // 防闪烁：内容没变就不重写（包含当前 tab）
    const stateKey = tabKey + '|' + newHtml;
    if (stateKey === lastRenderState) return;
    lastRenderState = stateKey;
    list.innerHTML = newHtml;

    bindAlertEvents(list);
    list.querySelectorAll('.xcp-clone-token-pill').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToToken(el.dataset.token, el.dataset.mint, el.dataset.chain);
      });
    });
    list.querySelectorAll('.xcp-star-toggle').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStar(el.dataset.wallet);
      });
    });
  }

  // ===== 挂载 =====
  function mountAlertPanel() {
    const card = findMonitorCard();
    if (!card) return false;
    if (card.querySelector('#xcp-inline-panel')) return true;
    const monitor = card.querySelector('.monitor');
    if (!monitor) return false;
    const hd = monitor.querySelector('.hd');
    if (!hd) return false;
    const bd = monitor.querySelector('.bd');
    if (!bd) return false;
    panelEl = createAlertPanel({
      source: 'KOL',
      themeClass: 'xcp-inline-kol',
      titleEmoji: '🔥',
      titleText: '聚合买入提醒',
      showStarList: true,
      showSound: true,
      id: 'xcp-inline-panel'
    });
    monitor.insertBefore(panelEl, bd);
    bindPanelEvents(panelEl);

    // 旧版双卡：第二张也插一个面板（绿色 我的 主题）
    if (detectLayout() === 'legacy') {
      const allCards = findAllMonitorCards();
      if (allCards.length >= 2) {
        const card2 = allCards[1];
        if (!card2.querySelector('#xcp-inline-panel-my')) {
          const monitor2 = card2.querySelector('.monitor');
          const bd2 = monitor2 && monitor2.querySelector('.bd');
          if (monitor2 && bd2) {
            cloneAlertPanelEl = createAlertPanel({
              source: '我的',
              themeClass: 'xcp-inline-my',
              titleEmoji: '★',
              titleText: '我的 聚合',
              showStarList: true,
              showSound: true,
              id: 'xcp-inline-panel-my'
            });
            monitor2.insertBefore(cloneAlertPanelEl, bd2);
            bindPanelEvents(cloneAlertPanelEl);
          }
        }
      }
    }
    return true;
  }
  function mountCloneCard() {
    // 旧版有两张原生卡，不需要克隆
    if (detectLayout() === 'legacy') return false;
    const orig = findMonitorCardItem();
    if (!orig) return false;
    if (document.getElementById('xcp-clone-card')) return true;
    cloneCardEl = buildCloneCard();
    if (!cloneCardEl) return false;

    // 清除继承的 inline grid 定位（dock 用 CSS Grid，克隆会卡到 0px 行）
    cloneCardEl.style.gridRow = '';
    cloneCardEl.style.gridColumn = '';
    cloneCardEl.removeAttribute('style');

    // 找原卡所在的 column，用相同的结构在它旁边新建一列
    const origColumn = orig.closest('.discover-v2-dock-column');
    if (!origColumn) {
      orig.parentNode.insertBefore(cloneCardEl, orig.nextSibling);
      renderCloneCard();
      return true;
    }

    // 复制一个空列，把克隆塞进去
    const newColumn = origColumn.cloneNode(false);
    newColumn.id = 'xcp-clone-column';
    const wrap = origColumn.querySelector('.dock-column-cards-wrap');
    const cards = origColumn.querySelector('.dock-column-cards');
    if (wrap && cards) {
      const newWrap = wrap.cloneNode(false);
      const newCards = cards.cloneNode(false);
      // 清掉克隆容器上可能继承的 grid 模板（让 auto 流式撑高）
      newCards.style.gridTemplateRows = 'auto';
      newCards.style.height = '100%';
      newCards.appendChild(cloneCardEl);
      newWrap.appendChild(newCards);
      newColumn.appendChild(newWrap);
    } else {
      newColumn.appendChild(cloneCardEl);
    }

    // 插入到原列右边
    origColumn.parentNode.insertBefore(newColumn, origColumn.nextSibling);

    // 撑满高度
    cloneCardEl.style.height = '100%';
    cloneCardEl.style.minHeight = '600px';

    renderCloneCard();
    return true;
  }

  function startMountWatcher() {
    if (mountCheckInterval) clearInterval(mountCheckInterval);
    mountCheckInterval = setInterval(() => {
      const layout = detectLayout();
      const card = findMonitorCard();
      if (!card) {
        if (panelEl) panelEl = null;
        const oldCol = document.getElementById('xcp-clone-column');
        if (oldCol) oldCol.remove();
        if (cloneCardEl && !document.body.contains(cloneCardEl)) cloneCardEl = null;
        if (cloneAlertPanelEl && !document.body.contains(cloneAlertPanelEl)) cloneAlertPanelEl = null;
        return;
      }
      if (!card.querySelector('#xcp-inline-panel')) {
        if (mountAlertPanel()) renderAlerts();
      }
      if (layout === 'legacy') {
        const allCards = findAllMonitorCards();
        // 第二张卡的我的面板检查
        if (allCards.length >= 2 && !allCards[1].querySelector('#xcp-inline-panel-my')) {
          mountAlertPanel();
          renderAlerts();
        }
        // 只在 observer 数量明显不对时重启
        const expectedObservers = Math.min(allCards.length, 2);
        if (origObservers.length === 0 && expectedObservers > 0) {
          startOrigObserver();
        }
      } else {
        if (!document.getElementById('xcp-clone-card')) {
          if (mountCloneCard()) renderCloneCard();
        }
      }
    }, 2000);
  }

  // 周期清理 + 时间戳刷新
  function startCleanup() {
    if (cleanupInterval) clearInterval(cleanupInterval);
    cleanupInterval = setInterval(() => {
      cleanOldRecords();
      // 刷新 N 秒前显示
      if (cloneCardEl) {
        cloneCardEl.querySelectorAll('.xcp-clone-ago').forEach(el => {
          // 不刷新（避免重排）— 改成简单做法：每 30s 整体重渲一次
        });
      }
    }, 30000);

    // 整体重渲克隆卡用于刷新 timeAgo
    setInterval(() => renderCloneCard(), 30000);
  }

  // 用全局事件委托，避免 Vue 重渲丢失监听
  let tabClickBound = false;
  function bindOrigTabListeners() {
    if (tabClickBound) return;
    document.addEventListener('click', (e) => {
      const li = e.target.closest('.monitor .hd .tabs li');
      if (!li) return;
      const card = li.closest('.discover-v2-dock-card');
      if (!card) return;
      const t = card.querySelector('.title-text');
      if (!t || t.textContent.trim() !== '钱包监控') return;
      // 切换后等数据加载，分多次扫描
      setTimeout(scanOrigDomTrades, 300);
      setTimeout(scanOrigDomTrades, 1000);
      setTimeout(scanOrigDomTrades, 2500);
    }, true);
    tabClickBound = true;
  }

  function startDomScanner() {
    if (domScanInterval) clearInterval(domScanInterval);
    domScanInterval = setInterval(() => {
      bindOrigTabListeners();
      scanOrigDomTrades();
      injectOrigStars();
    }, 3000);
    scanOrigDomTrades();
    injectOrigStars();
    startOrigObserver();
  }

  // ===== 注入星标按钮到原卡每条 trade =====
  let origObserver = null;
  let origObservers = [];
  let injectStarsScheduled = false;
  function scheduleInjectStars() {
    if (injectStarsScheduled) return;
    injectStarsScheduled = true;
    setTimeout(() => {
      injectStarsScheduled = false;
      injectOrigStars();
    }, 250);
  }

  function startOrigObserver() {
    origObservers.forEach(o => { try { o.disconnect(); } catch(e) {} });
    origObservers = [];
    const cards = findAllMonitorCards();
    cards.forEach(card => {
      const wrapper = card.querySelector('.vue-recycle-scroller');
      if (!wrapper) return;
      const ob = new MutationObserver(() => scheduleInjectStars());
      // 只看 childList，不看 attributes（虚拟滚动会高频改 transform/style）
      ob.observe(wrapper, { childList: true, subtree: true });
      origObservers.push(ob);
    });
  }

  function injectOrigStars() {
    const cards = findAllMonitorCards();
    cards.forEach(card => {
      const items = card.querySelectorAll('.monitor-item');
      items.forEach(item => {
        const walletEl = item.querySelector('.btn-wallet em');
        if (!walletEl) return;
        const wallet = walletEl.textContent.trim();
        const isStar = starred.has(wallet);

        item.classList.toggle('xcp-orig-starred', isStar);

        let starBtn = item.querySelector('.xcp-orig-star');
        // 旧版可能没有 .wallet-pnl-wrap，往父级 .monitor-item 直接插
        const walletWrap = item.querySelector('.wallet-pnl-wrap') || item.querySelector('.btn-wallet')?.parentElement;
        if (!walletWrap) return;

        if (!starBtn) {
          starBtn = document.createElement('span');
          starBtn.className = 'xcp-orig-star';
          starBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const curWallet = item.querySelector('.btn-wallet em')?.textContent.trim();
            if (curWallet) toggleStar(curWallet);
          });
          walletWrap.insertBefore(starBtn, walletWrap.firstChild);
        }

        starBtn.textContent = isStar ? '★' : '☆';
        starBtn.classList.toggle('on', isStar);
        starBtn.title = isStar ? '取消特别关注' : '加入特别关注';
      });
    });
  }

  // ===== 检查新版本 =====
  const REPO = '0xuezhang985/wallet-convergence-alert';
  function cmpVer(a, b) {
    const pa = a.split('.').map(n => parseInt(n) || 0);
    const pb = b.split('.').map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  async function checkForUpdate() {
    try {
      // 6 小时内只查一次
      const cacheRaw = localStorage.getItem('xcp_update_cache');
      const cache = cacheRaw ? JSON.parse(cacheRaw) : null;
      const now = Date.now();
      let latest = null;
      if (cache && cache.fetchedAt && (now - cache.fetchedAt) < 6 * 3600 * 1000) {
        latest = cache.tag;
      } else {
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
        if (!r.ok) return;
        const j = await r.json();
        latest = (j.tag_name || '').replace(/^v/, '');
        localStorage.setItem('xcp_update_cache', JSON.stringify({ tag: latest, fetchedAt: now }));
      }
      const cur = chrome.runtime.getManifest().version;
      if (latest && cmpVer(latest, cur) > 0) {
        showUpdateBanner(latest);
      }
    } catch (e) {}
  }

  function showUpdateBanner(latest) {
    if (!panelEl) return;
    if (panelEl.querySelector('.xcp-update-banner')) return;
    const b = document.createElement('div');
    b.className = 'xcp-update-banner';
    b.innerHTML = `🎉 新版 v${escHtml(latest)} 可用 — <a href="https://github.com/${REPO}/releases/latest" target="_blank" rel="noopener">点击下载</a> <span class="xcp-update-close" title="忽略本次提醒">×</span>`;
    panelEl.insertBefore(b, panelEl.firstChild);
    b.querySelector('.xcp-update-close').addEventListener('click', (e) => {
      e.stopPropagation();
      b.remove();
    });
  }

  // ===== 初始化 =====
  function init() {
    const tryInit = () => {
      const ok = mountAlertPanel();
      if (ok) {
        renderAlerts();
        mountCloneCard();
        startMountWatcher();
        startCleanup();
        startDomScanner();
        bindOrigTabListeners();
        // 拉取两边历史 — 不需要用户点击我的
        fetchInitialHistory();
        startHistoryRefresh();
        // 主动猜测钱包分组端点
        fetchWalletGroups();
        // 检查 GitHub release 新版本
        checkForUpdate();
        return true;
      }
      return false;
    };
    if (tryInit()) return;
    const waitTimer = setInterval(() => {
      if (tryInit()) clearInterval(waitTimer);
    }, 1000);
    setTimeout(() => clearInterval(waitTimer), 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 调试 API
  window.__xcp = {
    config, cloneData, buyRecords, tokenMeta, starred, walletGroups,
    get alertsKol() { return alertsKol; },
    get alertsMy() { return alertsMy; },
    rerender: () => { lastRenderState = ''; renderCloneCard(); renderAlerts(); },
    refetchGroups: () => fetchWalletGroups(),
    // 手动添加 wallet→group 映射（如果自动捕获失败时可用）
    setGroup: (wallet, group) => { walletGroups.set(wallet, group); lastRenderState = ''; renderAlerts(); renderCloneCard(); }
  };
})();
