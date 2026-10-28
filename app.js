/* ==========================================================================
   角色卡档案馆 · 主程序
   --------------------------------------------------------------------------
   这个文件负责：读取角色卡、渲染卡片墙、打开档案、上传 / 导出角色卡。
   想改文字和颜色，优先改 config.js 和 styles.css，不需要动这里。
   ========================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 小工具                                                              */
  /* ------------------------------------------------------------------ */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const utf8 = new TextDecoder('utf-8');

  const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

  const escapeXml = escapeHtml;

  const svgUri = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

  function hash(str) {
    let h = 2166136261;
    const text = String(str);
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  const shortHash = (str) => (hash(str) % 0xffff).toString(16).toUpperCase().padStart(4, '0');

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 忽略隐私模式报错 */ }
  }

  /* ------------------------------------------------------------------ */
  /* 默认配置（真实配置在 config.js，这里只是兜底）                        */
  /* ------------------------------------------------------------------ */

  function avatarSvg(glyph) {
    return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f2f9ff"/><stop offset="1" stop-color="#9dc8ef"/>
      </linearGradient></defs>
      <rect width="160" height="160" rx="80" fill="url(#a)"/>
      <circle cx="80" cy="80" r="62" fill="#ffffff" opacity=".38"/>
      <circle cx="80" cy="80" r="57" fill="none" stroke="#2e6cae" stroke-opacity=".38" stroke-width="1.2"/>
      <text x="80" y="103" text-anchor="middle" font-family="Songti SC, STSong, serif" font-size="64" fill="#245a8c">${escapeXml(glyph)}</text>
    </svg>`);
  }

  const DEFAULT_AVATAR = avatarSvg('蓝');

  const DEFAULT_CONFIG = {
    siteTitle: '蓝鸢 · 角色卡档案馆',
    username: '蓝鸢',
    english: 'LANYUAN · CHARACTER ARCHIVE',
    author: '蓝鸢',
    master: '',
    bio: '这里收藏我写下的角色卡。愿每一次相遇，都像风穿过蓝色的天空。',
    avatar: DEFAULT_AVATAR,
    accent: '#4b8fd6',
    footer: '© 2026 蓝鸢',
    footerRight: 'UNIFIED CARD LAYOUT',
    showDemo: true
  };

  function loadConfig() {
    const config = { ...DEFAULT_CONFIG };
    const custom = window.__ARCHIVE_CONFIG__;
    if (custom && typeof custom === 'object') {
      Object.keys(custom).forEach((key) => {
        const value = custom[key];
        if (value !== undefined && value !== null) config[key] = value;
      });
    }
    return config;
  }

  /* ------------------------------------------------------------------ */
  /* 管理模式（?admin=1）                                                */
  /* ------------------------------------------------------------------ */

  function wantsAdmin() {
    try {
      const params = new URLSearchParams(location.search);
      return params.get('admin') === '1' || location.hash === '#admin';
    } catch {
      return false;
    }
  }

  function exitAdmin() {
    state.admin = false;
    document.body.classList.remove('is-admin');

    try {
      const url = new URL(location.href);
      url.searchParams.delete('admin');
      url.searchParams.delete('key');
      if (url.hash === '#admin') url.hash = '';
      history.replaceState(null, '', url);
    } catch { /* 忽略 */ }

    $$('.modal.is-open').forEach((modal) => closeModal('#' + modal.id));
    loadCards().then(render);
    toast('已退出管理模式', 'ok');
  }

  /* ------------------------------------------------------------------ */
  /* 颜色                                                                */
  /* ------------------------------------------------------------------ */

  function rgbOf(hex) {
    let h = String(hex || '#4b8fd6').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function hexOf({ r, g, b }) {
    return '#' + [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('');
  }

  function mixColor(a, b, t) {
    const A = rgbOf(a);
    const B = rgbOf(b);
    return hexOf({
      r: A.r + (B.r - A.r) * t,
      g: A.g + (B.g - A.g) * t,
      b: A.b + (B.b - A.b) * t
    });
  }

  /* ------------------------------------------------------------------ */
  /* 状态                                                                */
  /* ------------------------------------------------------------------ */

  const state = {
    config: { ...DEFAULT_CONFIG },
    cards: [],
    filter: 'all',
    query: '',
    activeId: null,
    tab: 'opening',
    localCount: 0,
    loaded: false,
    admin: false
  };

  const urlCache = new Map();

  const TABS = [
    { key: 'opening', label: '开场白', en: 'OPENING' },
    { key: 'setting', label: '人物设定', en: 'PROFILE' },
    { key: 'worldbook', label: '世界书', en: 'WORLD BOOK' },
    { key: 'preset', label: '预设', en: 'PRESET' }
  ];

  const ACCENTS = [
    { color: '#4b8fd6', name: '雾蓝' },
    { color: '#3f8fc4', name: '湖蓝' },
    { color: '#5b7fb3', name: '灰蓝' },
    { color: '#3aa3b8', name: '青蓝' },
    { color: '#7f8fd6', name: '鸢尾' }
  ];

  /* ------------------------------------------------------------------ */
  /* 本地存储（IndexedDB；不可用时退回内存）                              */
  /* ------------------------------------------------------------------ */

  const DB_NAME = 'character-card-archive';
  const DB_STORE = 'cards';

  let dbPromise = null;
  let dbUnavailable = false;
  const memoryStore = [];

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('浏览器不支持 IndexedDB'));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('打开数据库失败'));
      request.onblocked = () => reject(new Error('数据库被其他页面占用'));
    }).catch((error) => {
      dbUnavailable = true;
      throw error;
    });

    return dbPromise;
  }

  const storage = {
    async all() {
      if (dbUnavailable) return memoryStore.slice();
      try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readonly');
          const request = tx.objectStore(DB_STORE).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        });
      } catch (error) {
        dbUnavailable = true;
        console.warn('[archive] 本地数据库不可用，本次使用临时存储：', error);
        return memoryStore.slice();
      }
    },

    async put(record) {
      if (dbUnavailable) {
        const index = memoryStore.findIndex((item) => item.id === record.id);
        if (index >= 0) memoryStore[index] = record;
        else memoryStore.push(record);
        return;
      }
      try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        dbUnavailable = true;
        memoryStore.push(record);
        console.warn('[archive] 角色卡只保存在临时内存中：', error);
      }
    },

    async remove(id) {
      if (dbUnavailable) {
        const index = memoryStore.findIndex((item) => item.id === id);
        if (index >= 0) memoryStore.splice(index, 1);
        return;
      }
      try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch { /* 忽略 */ }
    },

    async clear() {
      memoryStore.length = 0;
      if (dbUnavailable) return;
      try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch { /* 忽略 */ }
    }
  };

  /* ------------------------------------------------------------------ */
  /* 封面 / 头像                                                          */
  /* ------------------------------------------------------------------ */

  const COVER_PALETTES = [
    ['#eef7ff', '#b9d8f6', '#3f7fc4'],
    ['#eaf7fb', '#a9d3ea', '#357fa8'],
    ['#eef3fd', '#c2d3f0', '#4d6fb0'],
    ['#e9f7f5', '#b0dcd6', '#3f8f88'],
    ['#eaf4fb', '#b3cfe6', '#48688f'],
    ['#f2f7ff', '#c9d9ee', '#5b7fa8']
  ];

  function coverSvg(name, seed) {
    const palette = COVER_PALETTES[hash(seed) % COVER_PALETTES.length];
    const glyph = (String(name || '?').trim().slice(0, 1) || '?');
    const [light, deep, ink] = palette;

    return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${deep}"/>
        </linearGradient>
        <radialGradient id="r" cx="28%" cy="16%" r="82%">
          <stop offset="0" stop-color="#ffffff" stop-opacity=".92"/>
          <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="600" height="800" fill="url(#g)"/>
      <rect width="600" height="800" fill="url(#r)"/>
      <circle cx="474" cy="126" r="150" fill="#ffffff" opacity=".3"/>
      <circle cx="112" cy="672" r="212" fill="${ink}" opacity=".1"/>
      <g opacity=".16" stroke="${ink}" stroke-width="1">
        <path d="M0 612h600M0 668h600M0 724h600"/>
      </g>
      <rect x="24" y="24" width="552" height="752" fill="none" stroke="#ffffff" stroke-opacity=".5"/>
      <text x="300" y="452" text-anchor="middle" font-family="Songti SC, STSong, serif" font-size="300" fill="${ink}" opacity=".88">${escapeXml(glyph)}</text>
      <text x="300" y="640" text-anchor="middle" font-family="serif" font-size="17" letter-spacing="9" fill="${ink}" opacity=".46">CHARACTER CARD</text>
    </svg>`);
  }

  /* ------------------------------------------------------------------ */
  /* 示例卡（可在「站点设置」里隐藏 / 删除）                               */
  /* ------------------------------------------------------------------ */

  const DEMO_DATA = [
    {
      name: '沈青禾',
      role: '旧书店店主 · 替你在雨天留一盏灯',
      tags: ['治愈', '日常'],
      opening: `（雨从傍晚下到现在，青禾书店的灯还亮着。门楣上的铜铃轻轻响了一声，他从书架后抬起头，指尖还夹着一枚黄铜书签。）

“来了？伞放门口就好。……茶刚泡上，还烫。”`,
      setting: `【角色描述】
沈青禾，三十四岁，旧书店「青禾」的店主。说话慢，记性极好，能记住每位客人上次买走的书。

【性格】
温和、克制，习惯把关心藏在细节里。不擅长道别，擅长等。

【场景】
城南一条种满梧桐的旧街，雨季漫长。书店二楼有一扇总也关不严的窗。`,
      worldbook: `【青禾书店】
一层卖旧书与手冲咖啡；二层不对外开放，是他整理藏书和睡午觉的地方。

【黄铜书签】
银杏叶形状，他母亲留下的旧物。从不出借，却常常夹在你正翻到的那一页。`,
      preset: `【叙事风格】
第二人称，节奏舒缓，重视环境、气味与停顿。

【回复要求】
每次回复不超过四段，允许沉默和留白。`
    },
    {
      name: '迟雾',
      role: '气象观测员 · 在云端记录每一次台风',
      tags: ['清冷', '陪伴'],
      opening: `（山顶观测站的玻璃上全是雾。她把手从键盘上移开，朝门口偏了偏头。）

“台风路径刚更新。你要不要……先坐下来，等这阵风过去？”`,
      setting: `【角色描述】
迟雾，二十七岁，负责一座海边高山观测站。常年一个人值夜班。

【性格】
冷静、精确，谈起云和风会变得话多。不太会安慰人，但会记得替你留一盏走廊灯。

【场景】
海拔一千二百米的观测站，窗外是不断翻涌的云海。`,
      worldbook: `【观测站】
三层小楼，顶层是风速仪和雷达。厨房里永远有一壶温着的姜茶。

【第七号台风】
三年前那场台风，让她留在了山上。她很少提起。`,
      preset: `【叙事风格】
以环境描写开场，句子短，留白多。

【回复要求】
避免直接说教，用行动代替解释。`
    },
    {
      name: '白榆',
      role: '夜班电台主播 · 替城市收留没说完的话',
      tags: ['深夜', '倾听'],
      opening: `（凌晨一点零七分，电台的 ON AIR 灯亮着。她推起推子，声音落进城市上空的雨里。）

“这里是《末班车》。今晚，我们聊一件你一直没舍得放下的事。”`,
      setting: `【角色描述】
白榆，三十岁，深夜电台主持人。声音低而稳，习惯在节目最后读一封听众来信。

【性格】
耐心、清醒，擅长接住别人的情绪。下了节目会一个人走到江边，把没说完的话说给风听。

【场景】
老城区广播大楼十二层，凌晨的直播间，桌上一杯凉掉的咖啡。`,
      worldbook: `【末班车】
每周三、五凌晨一点到三点播出。没有脚本，只有来信和歌。

【那封没读的信】
抽屉最底层，信封上没有署名。`,
      preset: `【叙事风格】
电台独白感，重视声音与静默。

【回复要求】
多用短句和停顿，每段不超过六行。`
    },
    {
      name: '江照',
      role: '修表匠 · 相信时间会替人做决定',
      tags: ['旧城', '慢热'],
      opening: `（工作台的台灯圈出一小块亮。他眯着眼，把一枚齿轮放进机芯，镊子尖稳得像没有重量。）

“坐。你的表……不是坏了，是走得太急了。”`,
      setting: `【角色描述】
江照，四十二岁，在老街修了二十年表。手指有薄茧，说话不多。

【性格】
沉静、专注。相信时间会替人做决定，所以从不催人。

【场景】
巷子深处的钟表铺，墙上挂着几十只走时不同的钟。`,
      worldbook: `【江记钟表】
没有招牌，只在上学放学时开门。熟客都知道要敲三下门。

【一只停摆的表】
柜台最里侧，表盖内侧刻着两个字母。他从不接这只表的修理。`,
      preset: `【叙事风格】
慢节奏，细节密集，像镜头贴近手指与齿轮。

【回复要求】
少用形容词，让动作说话。`
    },
    {
      name: '阿眠',
      role: '深潜器驾驶员 · 八百米以下的蓝',
      tags: ['深海', '孤勇'],
      opening: `（舱内只有仪表的蓝光。她盯着深度计，声音通过耳机传来，带着一点电流的沙沙声。）

“下潜到八百米了。……你要不要看看窗外？这里没有雨。”`,
      setting: `【角色描述】
阿眠，二十九岁，深潜器驾驶员。一年里有半年在海上。

【性格】
胆大、话直，怕黑却不怕深海。上岸后会失眠，只有在水下才睡得着。

【场景】
科考船「白鲸号」的深潜舱，深度计、舷窗，以及无边无际的蓝。`,
      worldbook: `【白鲸号】
服役十二年的老船，舱壁上有历任驾驶员刻下的名字。

【八百米】
她第一次独自下潜的深度。那天，她在舷窗外看见了一整片发光的浮游生物。`,
      preset: `【叙事风格】
第一人称视角的陪伴感，强调压迫感与静谧。

【回复要求】
保持在水下的节奏，不要急着浮上水面。`
    },
    {
      name: '鹤川',
      role: '山间邮差 · 把寄不出去的话送到山上',
      tags: ['山野', '明亮'],
      opening: `（山路尽头，他推着自行车上来，后座绑着一摞用油纸包好的信。风把他的围巾吹得老高。）

“今天只有一封。……收件人写的是你的名字。”`,
      setting: `【角色描述】
鹤川，二十六岁，负责山里七个村子的邮路。走过最远的雪线，也送过没有地址的信。

【性格】
开朗、固执，相信每封信都值得被送到。走路很快，说话很慢。

【场景】
海拔两千米的山道，春天有野樱，冬天封路三个月。`,
      worldbook: `【七村邮路】
从山脚到山顶，一共二十三公里。他走了四年，能叫出每一户人家的狗的名字。

【没有地址的信】
邮包里永远留着一个空位，给那些寄不出去的话。`,
      preset: `【叙事风格】
明亮、有风感，多写路、天气和脚步。

【回复要求】
保持轻快，偶尔停下来看看风景。`
    }
  ];

  function demoCard(data, index) {
    const id = 'demo-' + index;
    return {
      id,
      name: data.name,
      alias: 'SAMPLE · ' + String(index + 1).padStart(4, '0'),
      role: data.role,
      tags: data.tags || [],
      creator: '示例',
      createdAt: '2026-09-01',
      sections: {
        opening: data.opening || '',
        setting: data.setting || '',
        worldbook: data.worldbook || '',
        preset: data.preset || ''
      },
      source: 'demo',
      cover: coverSvg(data.name, id)
    };
  }

  /* ------------------------------------------------------------------ */
  /* 角色卡数据加载                                                       */
  /* ------------------------------------------------------------------ */

  function normalizePublished(card, index) {
    const sections = { opening: '', setting: '', worldbook: '', preset: '', ...(card.sections || {}) };
    return {
      ...card,
      id: card.id || 'pub-' + index + '-' + shortHash(card.name || 'card'),
      name: card.name || '未命名角色',
      alias: card.alias || 'CARD · ' + shortHash(card.name || 'card'),
      tags: Array.isArray(card.tags) ? card.tags : [],
      role: card.role || '',
      creator: card.creator || state.config.author || '未署名',
      sections,
      source: 'published',
      cover: card.cover || coverSvg(card.name || '角色', card.id || card.name || String(index))
    };
  }

  async function loadCards() {
    const hidden = new Set(readJSON('archive.demoHidden', []));
    const local = state.admin
      ? (await storage.all()).map((card) => ({ ...card, source: 'local' }))
      : [];
    const published = Array.isArray(window.__ARCHIVE_CARDS__)
      ? window.__ARCHIVE_CARDS__.map(normalizePublished)
      : [];
    const demos = state.config.showDemo === false
      ? []
      : DEMO_DATA.map(demoCard).filter((card) => !hidden.has(card.id));

    state.localCount = local.length;
    state.cards = [...local, ...published, ...demos]
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  function imageSrc(card) {
    if (card.imageBlob) {
      if (!urlCache.has(card.id)) urlCache.set(card.id, URL.createObjectURL(card.imageBlob));
      return urlCache.get(card.id);
    }
    return card.image || card.cover || coverSvg(card.name, card.id);
  }

  function canDownload(card) {
    return Boolean(card.imageBlob || card.image);
  }

  function cardHTML(card, index) {
    const src = imageSrc(card);
    const flag = card.source === 'demo' ? '<span class="card-flag">示例</span>' : '';
    const download = canDownload(card)
      ? `<button class="card-dl" type="button" data-dl="${escapeHtml(card.id)}" aria-label="下载 ${escapeHtml(card.name)} 的角色卡" title="下载角色卡">
           <svg class="ico" aria-hidden="true"><use href="#i-download"/></svg>
         </button>`
      : '';

    return `<article class="card" style="--i:${Math.min(index, 10)}" data-id="${escapeHtml(card.id)}">
      <div class="card-art">
        <img src="${escapeHtml(src)}" alt="${escapeHtml(card.name)} 的卡面" loading="lazy" decoding="async">
        <div class="card-veil"></div>
        ${flag}${download}
        <button class="card-hit" type="button" data-open="${escapeHtml(card.id)}" aria-label="查看 ${escapeHtml(card.name)} 的档案">
          <span class="card-hit-label">查看档案 <svg class="ico" aria-hidden="true"><use href="#i-arrow"/></svg></span>
        </button>
      </div>
      <div class="card-foot">
        <div class="card-title">
          <b>${escapeHtml(card.name)}</b>
          <small>${escapeHtml(card.role || '—')}</small>
        </div>
        <span class="card-go" aria-hidden="true"><svg class="ico"><use href="#i-arrow"/></svg></span>
      </div>
    </article>`;
  }

  function visibleCards() {
    const query = state.query.trim().toLowerCase();
    return state.cards.filter((card) => {
      if (state.filter !== 'all' && (card.creator || '未署名') !== state.filter) return false;
      if (!query) return true;
      return [card.name, card.role, card.creator, (card.tags || []).join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }

  function renderFilters() {
    const counts = new Map();
    state.cards.forEach((card) => {
      const creator = card.creator || '未署名';
      counts.set(creator, (counts.get(creator) || 0) + 1);
    });

    const entries = [['all', '全部', state.cards.length], ...Array.from(counts.entries()).map(([name, n]) => [name, name, n])];
    if (!entries.some(([id]) => id === state.filter)) state.filter = 'all';

    $('#filters').innerHTML = entries.map(([id, label, n]) => `
      <button class="chip${id === state.filter ? ' is-active' : ''}" type="button"
        data-filter="${escapeHtml(id)}" aria-pressed="${id === state.filter}">
        ${escapeHtml(label)}<small>${n}</small>
      </button>`).join('');
  }

  function renderEmpty(list) {
    const empty = $('#empty');
    const noCards = state.cards.length === 0;
    empty.classList.toggle('is-on', state.loaded && list.length === 0);
    if (list.length) return;

    if (!state.admin) {
      empty.dataset.mode = 'none';
      $('#emptyTitle').textContent = noCards ? '还没有公开的角色卡' : '没有找到匹配的档案';
      $('#emptyText').textContent = noCards
        ? '馆主还没有发布角色卡，晚一点再来看看吧。'
        : '换一个关键词，或者切回「全部」再看看。';
      return;
    }

    if (noCards) {
      empty.dataset.mode = 'upload';
      $('#emptyTitle').textContent = '还没有角色卡';
      $('#emptyText').textContent = '把你写好的 PNG 角色卡或 JSON 文件拖进来，就能在这里看到它。';
      $('#emptyBtnText').textContent = '上传第一张角色卡';
    } else {
      empty.dataset.mode = 'reset';
      $('#emptyTitle').textContent = '没有找到匹配的档案';
      $('#emptyText').textContent = '换一个关键词，或者切回「全部」再看看。';
      $('#emptyBtnText').textContent = '清除筛选';
    }
  }

  function render() {
    if (state.filter !== 'all' && !state.cards.some((card) => (card.creator || '未署名') === state.filter)) {
      state.filter = 'all';
    }
    const list = visibleCards();

    $('#headerCount').textContent = String(state.cards.length).padStart(2, '0');
    $('#statusText').textContent = state.cards.length ? 'READY' : 'EMPTY';
    $('#status').classList.toggle('is-empty', state.cards.length === 0);

    const gallery = $('#gallery');
    gallery.innerHTML = list.map(cardHTML).join('');
    gallery.hidden = list.length === 0;
    gallery.setAttribute('aria-busy', 'false');

    renderFilters();
    renderEmpty(list);
  }

  /* ------------------------------------------------------------------ */
  /* 档案详情                                                            */
  /* ------------------------------------------------------------------ */

  function renderRich(text) {
    const blocks = [];
    let buffer = [];

    const flush = () => {
      if (!buffer.length) return;
      blocks.push('<p>' + buffer.map(escapeHtml).join('<br>') + '</p>');
      buffer = [];
    };

    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        flush();
        return;
      }
      const heading = trimmed.match(/^【([^】]{1,24})】$/);
      if (heading) {
        flush();
        blocks.push('<h4>' + escapeHtml(heading[1]) + '</h4>');
        return;
      }
      buffer.push(line.replace(/\s+$/, ''));
    });
    flush();

    return blocks.join('') || '<p class="reader-empty">暂无内容。</p>';
  }

  function renderTabs() {
    $('#detailTabs').innerHTML = TABS.map((tab, index) => `
      <button class="tab${tab.key === state.tab ? ' is-active' : ''}" type="button"
        role="tab" aria-selected="${tab.key === state.tab}" data-tab="${tab.key}">
        <span>0${index + 1}</span>${tab.label}
      </button>`).join('');
  }

  function activeCard() {
    return state.cards.find((card) => card.id === state.activeId);
  }

  function renderReader() {
    const card = activeCard();
    if (!card) return;
    const tabIndex = Math.max(0, TABS.findIndex((tab) => tab.key === state.tab));
    const tab = TABS[tabIndex];
    const raw = (card.sections && card.sections[tab.key]) || '';

    $('#readerIndex').textContent = `0${tabIndex + 1} · ${tab.en}`;
    const body = $('#readerBody');
    body.innerHTML = raw.trim()
      ? renderRich(raw)
      : `<p class="reader-empty">这一部分还没有内容${tab.key === 'worldbook' ? '，这张卡可能没有附带世界书。' : '。'}</p>`;
    body.scrollTop = 0;
  }

  function openDetail(id) {
    const card = state.cards.find((item) => item.id === id);
    if (!card) return;

    state.activeId = id;
    state.tab = 'opening';

    $('#detailName').textContent = card.name;
    $('#detailMeta').textContent = [card.alias, card.creator].filter(Boolean).join(' · ');
    $('#detailBadge').textContent = card.source === 'local' ? '本机' : card.source === 'published' ? '已发布' : '示例';

    const image = $('#detailImage');
    image.src = imageSrc(card);
    image.alt = card.name + ' 的卡面';

    renderTabs();
    renderReader();

    const download = $('#detailDownload');
    download.hidden = !canDownload(card);
    download.textContent = card.imageBlob ? '下载原卡' : '保存卡面';

    const remove = $('#deleteCardBtn');
    remove.hidden = card.source === 'published' || !state.admin;
    remove.textContent = card.source === 'demo' ? '移除示例卡' : '删除这张卡';

    $('#detailHint').textContent = card.source === 'local'
      ? '仅保存在本机浏览器 · 导出 cards.js 后访客可见'
      : card.source === 'published'
        ? '已发布 · 所有访客可见'
        : (state.admin ? '示例卡 · 可在设置中恢复' : '示例卡 · 仅作展示');

    openModal('#detailModal');
  }

  function safeName(name) {
    return String(name || 'card').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  }

  function triggerDownload(href, filename) {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function imageExtension(src) {
    const match = /^data:image\/([a-z0-9.+-]+)/i.exec(src || '');
    const type = (match ? match[1] : 'png').toLowerCase();
    if (type === 'jpeg') return 'jpg';
    if (type === 'svg+xml') return 'svg';
    return type;
  }

  function downloadCard(card) {
    if (!card) return;
    if (card.imageBlob) {
      const url = URL.createObjectURL(card.imageBlob);
      triggerDownload(url, safeName(card.name) + '.png');
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } else if (card.image) {
      triggerDownload(card.image, safeName(card.name) + '.' + imageExtension(card.image));
    } else {
      toast('这张卡没有可下载的图片', 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 读取角色卡（PNG / JSON）                                             */
  /* ------------------------------------------------------------------ */

  function decodeBase64Utf8(base64) {
    const clean = String(base64).replace(/\s+/g, '');
    const binary = atob(clean);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return utf8.decode(bytes);
  }

  async function parsePng(file) {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];

    if (!signature.every((value, index) => buffer[index] === value)) {
      throw new Error('不是有效的 PNG 文件');
    }

    const view = new DataView(buffer.buffer);
    const texts = {};
    let offset = 8;

    while (offset + 8 <= buffer.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(...buffer.subarray(offset + 4, offset + 8));
      const start = offset + 8;
      const end = start + length;

      if (end > buffer.length) break;

      if (type === 'tEXt') {
        const data = buffer.subarray(start, end);
        const nul = data.indexOf(0);
        if (nul > 0) {
          texts[utf8.decode(data.subarray(0, nul))] = utf8.decode(data.subarray(nul + 1));
        }
      } else if (type === 'iTXt') {
        const data = buffer.subarray(start, end);
        const nul = data.indexOf(0);
        if (nul > 0) {
          const key = utf8.decode(data.subarray(0, nul));
          let cursor = nul + 1;
          const compressed = data[cursor];
          cursor += 2;
          const langEnd = data.indexOf(0, cursor);
          cursor = langEnd + 1;
          const translatedEnd = data.indexOf(0, cursor);
          cursor = translatedEnd + 1;
          if (compressed === 0) {
            texts[key] = utf8.decode(data.subarray(cursor));
          }
        }
      } else if (type === 'IEND') {
        break;
      }

      offset = end + 4;
    }

    const payload = texts.chara || texts.ccv3 || texts.character || texts.Chara;
    if (!payload) {
      throw new Error('这张 PNG 里没有角色卡数据（可能只是普通图片）');
    }

    let json;
    try {
      json = JSON.parse(decodeBase64Utf8(payload));
    } catch {
      throw new Error('PNG 里的角色卡数据无法解析');
    }

    return { json, blob: file };
  }

  async function parseFile(file) {
    const fileName = (file.name || '').toLowerCase();

    if (fileName.endsWith('.png') || file.type === 'image/png') {
      const { json, blob } = await parsePng(file);
      return buildCard(json, { blob, fileName: file.name });
    }

    if (fileName.endsWith('.json') || file.type === 'application/json' || file.type === 'text/plain') {
      const text = await file.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('JSON 格式有误');
      }
      if (Array.isArray(json)) {
        throw new Error('一个文件里有多张卡，请分开上传');
      }
      return buildCard(json, { fileName: file.name });
    }

    throw new Error('只支持 PNG 角色卡或 JSON 文件');
  }

  function block(pairs) {
    return pairs
      .filter(([, value]) => value && String(value).trim())
      .map(([label, value]) => `【${label}】\n${String(value).trim()}`)
      .join('\n\n');
  }

  function firstLine(text) {
    const line = String(text || '').split('\n').map((item) => item.trim()).filter(Boolean)[0] || '';
    return line.replace(/^#+\s*/, '').replace(/\*\*/g, '').slice(0, 40);
  }

  function firstSentence(text) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    const sentence = flat.split(/[。！？!?\n]/)[0] || flat;
    return sentence.slice(0, 42);
  }

  function normalizeDate(value) {
    if (!value) return '';
    if (typeof value === 'number') {
      const date = new Date(value * (value < 1e12 ? 1000 : 1));
      if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    }
    const match = String(value).match(/\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : '';
  }

  function buildCard(raw, { blob = null, fileName = '' } = {}) {
    let source = raw;
    if (source && source.card && typeof source.card === 'object' && !source.data) {
      source = source.card;
    }
    const data = (source && typeof source.data === 'object') ? source.data : (source || {});

    const name = String(data.name || data.char_name || (source && source.name) || '').trim() || '未命名角色';
    const description = String(data.description || data.char_persona || '').trim();
    const personality = String(data.personality || '').trim();
    const scenario = String(data.scenario || '').trim();
    const notes = String(data.creator_notes || data.creatorcomment || '').trim();
    const firstMes = String(data.first_mes || data.first_message || data.greeting || '').trim();
    const example = String(data.mes_example || data.example_dialogue || '').trim();
    const system = String(data.system_prompt || '').trim();
    const post = String(data.post_history_instructions || '').trim();
    const alternates = Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const entries = Array.isArray(data.character_book && data.character_book.entries)
      ? data.character_book.entries
      : [];
    const tags = Array.isArray(data.tags)
      ? data.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 4)
      : [];
    const creator = String(data.creator || (source && source.creator) || state.config.author || '').trim();

    const opening = [
      firstMes,
      alternates.length
        ? '—— 备用开场白 ——\n\n' + alternates.map((greeting, index) => `【备用 ${index + 1}】\n${greeting}`).join('\n\n')
        : ''
    ].filter(Boolean).join('\n\n');

    const setting = block([
      ['角色描述', description],
      ['性格', personality],
      ['场景', scenario],
      ['创作者备注', notes]
    ]);

    const worldbook = entries.length
      ? entries.map((entry, index) => {
        const title = String(entry.name || entry.comment || `条目 ${index + 1}`).trim();
        const keys = Array.isArray(entry.keys) ? entry.keys.filter(Boolean).join('、') : '';
        return `【${title}】${keys ? `\n关键词：${keys}` : ''}\n${String(entry.content || '').trim()}`;
      }).join('\n\n')
      : '';

    const preset = block([
      ['系统提示词', system],
      ['历史后置指令', post],
      ['示例对话', example]
    ]);

    const role = firstLine(notes) || firstSentence(description) || (tags[0] ? tags[0] + ' · 角色卡' : '角色卡');
    const createdAt = normalizeDate(data.create_date || data.createdAt || (source && source.create_date)) || new Date().toISOString().slice(0, 10);
    const id = 'local-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    const avatar = typeof data.avatar === 'string' && /^(data:image\/|https?:\/\/)/.test(data.avatar)
      ? data.avatar
      : '';

    return {
      id,
      name,
      alias: 'CARD · ' + shortHash(name + creator + id),
      role: role.slice(0, 42),
      tags,
      creator: creator || state.config.author || '未署名',
      createdAt,
      sections: { opening, setting, worldbook, preset },
      image: avatar,
      imageBlob: blob,
      cover: coverSvg(name, name + id),
      fileName
    };
  }

  /* ------------------------------------------------------------------ */
  /* 上传                                                                */
  /* ------------------------------------------------------------------ */

  let busyToast = null;

  async function handleFiles(fileList) {
    if (!state.admin) return;
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;

    clearBusy();
    busyToast = toast(`正在读取 ${files.length} 个文件…`, 'busy');

    let added = 0;
    const errors = [];

    for (const file of files) {
      try {
        const card = await parseFile(file);
        await storage.put(card);
        added += 1;
      } catch (error) {
        errors.push(`${file.name}：${error && error.message ? error.message : '解析失败'}`);
      }
    }

    clearBusy();
    await loadCards();
    render();

    if (added) {
      toast(`已加入 ${added} 张角色卡 · 记得「导出 cards.js」发布`, 'ok', 5000);
    }
    if (errors.length) {
      toast(errors[0] + (errors.length > 1 ? `（共 ${errors.length} 个文件失败）` : ''), 'error', 6500);
      console.warn('[archive] 导入失败：', errors);
    }
    if (!added && !errors.length) {
      toast('没有读取到角色卡', 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 导出                                                                */
  /* ------------------------------------------------------------------ */

  async function compressToDataUrl(blob, maxSize = 880, quality = 0.82) {
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      return canvas.toDataURL('image/webp', quality);
    } catch {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    triggerDownload(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function exportCards() {
    const local = state.cards.filter((card) => card.source === 'local');
    if (!local.length) {
      toast('还没有本地上传的角色卡', 'error');
      return;
    }

    clearBusy();
    busyToast = toast(`正在打包 ${local.length} 张角色卡…`, 'busy');

    const payload = [];
    for (const card of local) {
      const image = card.imageBlob
        ? await compressToDataUrl(card.imageBlob)
        : (card.image || card.cover);
      payload.push({
        id: card.id,
        name: card.name,
        alias: card.alias,
        role: card.role,
        tags: card.tags,
        creator: card.creator,
        createdAt: card.createdAt,
        sections: card.sections,
        image
      });
    }

    const text = `/* 角色卡档案馆 · 卡片数据
   由「导出 cards.js」生成（${new Date().toLocaleString('zh-CN')}）。
   把这个文件放到 index.html 同一个目录，访客就能看到这些角色卡。 */
window.__ARCHIVE_CARDS__ = ${JSON.stringify(payload)};
`;

    clearBusy();
    downloadBlob(new Blob([text], { type: 'text/javascript;charset=utf-8' }), 'cards.js');
    toast('已导出 cards.js · 上传到网站目录即可', 'ok', 5000);
  }

  function currentFormConfig() {
    const username = ($('#setUsername').value || '').trim() || '未命名';
    return {
      ...state.config,
      username,
      english: ($('#setEnglish').value || '').trim(),
      author: ($('#setAuthor').value || '').trim() || username,
      master: ($('#setMaster').value || '').trim(),
      bio: ($('#setBio').value || '').trim(),
      footer: ($('#setFooter').value || '').trim(),
      footerRight: ($('#setFooterRight').value || '').trim(),
      avatar: avatarDraft === DEFAULT_AVATAR ? '' : (avatarDraft || ''),
      accent: accentDraft || '#4b8fd6',
      showDemo: $('#setDemo').checked
    };
  }

  function exportConfig() {
    const config = currentFormConfig();
    const text = `/* 站点身份配置 · 改完保存，刷新页面即可生效 */
window.__ARCHIVE_CONFIG__ = ${JSON.stringify(config, null, 2)};
`;
    downloadBlob(new Blob([text], { type: 'text/javascript;charset=utf-8' }), 'config.js');
    toast('已导出 config.js · 替换网站里的同名文件', 'ok', 5000);
  }

  /* ------------------------------------------------------------------ */
  /* 设置                                                                */
  /* ------------------------------------------------------------------ */

  let avatarDraft = null;
  let accentDraft = null;
  let settingsApplied = false;

  function renderAvatarEditor() {
    $('#avatarPreview').src = avatarDraft || DEFAULT_AVATAR;
  }

  function renderSwatches() {
    $('#swatches').innerHTML = ACCENTS.map(({ color, name }) => `
      <button class="swatch${color === accentDraft ? ' is-active' : ''}" type="button"
        data-color="${color}" title="${name}" aria-label="主题色 ${name}"
        style="background:${color}"></button>`).join('');
  }

  function previewAccent(color) {
    const root = document.documentElement.style;
    root.setProperty('--accent', color);
    root.setProperty('--accent-deep', mixColor(color, '#123a63', 0.35));
    root.setProperty('--accent-soft', mixColor(color, '#ffffff', 0.84));
    root.setProperty('--accent-light', mixColor(color, '#ffffff', 0.2));
  }

  function openSettings() {
    const config = state.config;
    $('#setUsername').value = config.username || '';
    $('#setEnglish').value = config.english || '';
    $('#setAuthor').value = config.author || '';
    $('#setMaster').value = config.master || '';
    $('#setBio').value = config.bio || '';
    $('#setFooter').value = config.footer || '';
    $('#setFooterRight').value = config.footerRight || '';
    $('#setDemo').checked = config.showDemo !== false;

    avatarDraft = config.avatar || DEFAULT_AVATAR;
    accentDraft = config.accent || '#4b8fd6';
    settingsApplied = false;

    renderAvatarEditor();
    renderSwatches();
    openModal('#settingsModal');
  }

  function applySettings() {
    state.config = currentFormConfig();
    applyConfig(state.config);
    settingsApplied = true;
    closeModal('#settingsModal');
    toast('已应用预览 · 导出 config.js 后永久生效', 'ok', 4200);
    loadCards().then(render);
  }

  async function handleAvatarFile(file) {
    if (!file) return;
    try {
      const dataUrl = await compressToDataUrl(file, 256, 0.9);
      avatarDraft = dataUrl;
      renderAvatarEditor();
    } catch {
      toast('头像读取失败', 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 关于                                                                */
  /* ------------------------------------------------------------------ */

  function openAbout() {
    const config = state.config;
    $('#aboutAvatar').src = config.avatar || DEFAULT_AVATAR;
    $('#aboutName').textContent = config.username || '未命名';
    $('#aboutEn').textContent = config.english || '';
    $('#aboutBio').textContent = config.bio || '';
    $('#aboutAuthor').textContent = config.author || '—';
    $('#aboutMaster').textContent = config.master || '未填写';
    $('#aboutCount').textContent = state.cards.length + ' 张';
    $('#aboutLocal').textContent = state.localCount + ' 张';
    openModal('#aboutModal');
  }

  /* ------------------------------------------------------------------ */
  /* 弹层 / 提示                                                         */
  /* ------------------------------------------------------------------ */

  let lastFocus = null;

  function openModal(selector) {
    const modal = $(selector);
    if (!modal) return;
    lastFocus = document.activeElement;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('is-locked');
    modal.setAttribute('tabindex', '-1');
    modal.focus({ preventScroll: true });
  }

  function closeModal(selector) {
    const modal = $(selector);
    if (!modal || !modal.classList.contains('is-open')) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    if (!$('.modal.is-open')) document.body.classList.remove('is-locked');
    if (selector === '#settingsModal' && !settingsApplied) applyConfig(state.config);
    if (lastFocus && document.contains(lastFocus)) {
      try { lastFocus.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    }
  }

  function toast(message, type = '', duration = 3200) {
    const container = $('#toasts');
    const element = document.createElement('div');
    element.className = 'toast' + (type ? ' is-' + type : '');
    element.textContent = message;
    container.appendChild(element);

    if (type === 'busy') return element;

    setTimeout(() => {
      element.style.opacity = '0';
      element.style.transform = 'translateY(8px)';
      element.style.transition = 'opacity .25s, transform .25s';
      setTimeout(() => element.remove(), 260);
    }, duration);

    return element;
  }

  function clearBusy() {
    if (busyToast) {
      busyToast.remove();
      busyToast = null;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板', 'ok', 1800);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        toast('已复制到剪贴板', 'ok', 1800);
      } catch {
        toast('复制失败，请手动选择文字', 'error');
      }
      area.remove();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 应用配置                                                            */
  /* ------------------------------------------------------------------ */

  function applyConfig(config) {
    const accent = /^#[0-9a-f]{6}$/i.test(config.accent || '') ? config.accent : '#4b8fd6';
    previewAccent(accent);

    document.title = config.siteTitle || ((config.username || '我') + ' · 角色卡档案馆');

    const avatar = config.avatar || DEFAULT_AVATAR;
    $('#headerAvatar').src = avatar;
    $('#aboutAvatar').src = avatar;
    $('#favicon').href = avatar;

    $('#headerName').textContent = config.username || '未命名';
    $('#headerEnglish').textContent = config.english || '';

    const credit = ['作者 ' + (config.author || config.username || '未命名')];
    if (config.master) credit.push('主人 ' + config.master);
    $('#headerCredit').textContent = credit.join(' · ');

    $('#footerLeft').textContent = config.footer || '';
    $('#footerRight').textContent = config.footerRight || '';
  }

  /* ------------------------------------------------------------------ */
  /* 背景花瓣                                                            */
  /* ------------------------------------------------------------------ */

  function buildPetals() {
    const container = $('#petals');
    if (!container) return;
    const count = window.innerWidth < 720 ? 9 : 16;

    for (let i = 0; i < count; i++) {
      const petal = document.createElement('span');
      const size = 6 + Math.random() * 9;
      petal.className = 'petal';
      petal.style.left = (Math.random() * 100).toFixed(2) + '%';
      petal.style.width = size.toFixed(1) + 'px';
      petal.style.height = (size * 0.86).toFixed(1) + 'px';
      petal.style.opacity = (0.22 + Math.random() * 0.38).toFixed(2);
      petal.style.animationDuration = (19 + Math.random() * 15).toFixed(1) + 's';
      petal.style.animationDelay = (-Math.random() * 34).toFixed(1) + 's';
      petal.style.setProperty('--drift', (Math.random() * 140 - 70).toFixed(0) + 'px');
      container.appendChild(petal);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                            */
  /* ------------------------------------------------------------------ */

  function bind() {
    const fileInput = $('#fileInput');

    const pickFile = () => {
      if (!state.admin) return;
      fileInput.click();
    };
    $('#uploadBtn').addEventListener('click', pickFile);
    $('#exitAdmin').addEventListener('click', exitAdmin);
    $('#emptyBtn').addEventListener('click', () => {
      if ($('#empty').dataset.mode === 'reset') {
        state.query = '';
        state.filter = 'all';
        $('#searchInput').value = '';
        render();
      } else {
        pickFile();
      }
    });

    fileInput.addEventListener('change', () => {
      if (!state.admin) {
        fileInput.value = '';
        return;
      }
      handleFiles(fileInput.files);
      fileInput.value = '';
    });

    $('#aboutBtn').addEventListener('click', openAbout);
    $('#aboutBtn2').addEventListener('click', openAbout);
    $('#settingsBtn').addEventListener('click', openSettings);

    $('#aboutSettings').addEventListener('click', () => {
      closeModal('#aboutModal');
      setTimeout(openSettings, 80);
    });
    $('#aboutUpload').addEventListener('click', () => {
      closeModal('#aboutModal');
      setTimeout(pickFile, 80);
    });

    $('#filters').addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      state.filter = button.dataset.filter;
      render();
    });

    let searchTimer = null;
    $('#searchInput').addEventListener('input', (event) => {
      clearTimeout(searchTimer);
      const value = event.target.value;
      searchTimer = setTimeout(() => {
        state.query = value;
        render();
      }, 140);
    });

    $('#gallery').addEventListener('click', (event) => {
      const download = event.target.closest('[data-dl]');
      if (download) {
        event.stopPropagation();
        downloadCard(state.cards.find((card) => card.id === download.dataset.dl));
        return;
      }
      const card = event.target.closest('.card');
      if (card) openDetail(card.dataset.id);
    });

    $('#detailTabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (!tab) return;
      state.tab = tab.dataset.tab;
      renderTabs();
      renderReader();
    });

    $('#copyBtn').addEventListener('click', () => {
      const card = activeCard();
      if (!card) return;
      const raw = (card.sections && card.sections[state.tab]) || '';
      if (!raw.trim()) {
        toast('这一部分还没有内容', 'error', 1800);
        return;
      }
      copyText(`${card.name} · ${TABS.find((tab) => tab.key === state.tab).label}\n\n${raw}`);
    });

    $('#detailDownload').addEventListener('click', () => downloadCard(activeCard()));

    $('#deleteCardBtn').addEventListener('click', async () => {
      const card = activeCard();
      if (!card || card.source === 'published') return;

      const message = card.source === 'demo'
        ? '移除这张示例卡？'
        : `删除「${card.name}」？\n删除后本机数据不可恢复（已导出的 cards.js 不受影响）。`;
      if (!window.confirm(message)) return;

      if (card.source === 'demo') {
        const hidden = readJSON('archive.demoHidden', []);
        if (!hidden.includes(card.id)) hidden.push(card.id);
        writeJSON('archive.demoHidden', hidden);
      } else {
        await storage.remove(card.id);
        if (urlCache.has(card.id)) {
          URL.revokeObjectURL(urlCache.get(card.id));
          urlCache.delete(card.id);
        }
      }

      closeModal('#detailModal');
      await loadCards();
      render();
      toast(card.source === 'demo' ? '已移除示例卡' : '已删除', 'ok');
    });

    document.addEventListener('click', (event) => {
      const closer = event.target.closest('[data-close]');
      if (!closer) return;
      const modal = closer.closest('.modal');
      if (modal) closeModal('#' + modal.id);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const open = $$('.modal.is-open');
      if (open.length) closeModal('#' + open[open.length - 1].id);
    });

    /* ---------- 设置表单 ---------- */

    $('#avatarPick').addEventListener('click', () => $('#avatarFile').click());
    $('#avatarFile').addEventListener('change', (event) => {
      handleAvatarFile(event.target.files && event.target.files[0]);
      event.target.value = '';
    });
    $('#avatarReset').addEventListener('click', () => {
      avatarDraft = DEFAULT_AVATAR;
      renderAvatarEditor();
    });

    $('#swatches').addEventListener('click', (event) => {
      const swatch = event.target.closest('[data-color]');
      if (!swatch) return;
      accentDraft = swatch.dataset.color;
      previewAccent(accentDraft);
      renderSwatches();
    });

    $('#applySettings').addEventListener('click', applySettings);
    $('#exportConfig').addEventListener('click', exportConfig);
    $('#exportCards').addEventListener('click', exportCards);

    $('#restoreDemo').addEventListener('click', async () => {
      localStorage.removeItem('archive.demoHidden');
      state.config.showDemo = true;
      $('#setDemo').checked = true;
      await loadCards();
      render();
      toast('示例卡已恢复', 'ok');
    });

    $('#clearLocal').addEventListener('click', async () => {
      if (!window.confirm('清空所有本地上传的角色卡？\n此操作不可恢复，已导出的 cards.js 不受影响。')) return;
      await storage.clear();
      urlCache.forEach((url) => URL.revokeObjectURL(url));
      urlCache.clear();
      await loadCards();
      render();
      toast('已清空本地上传', 'ok');
    });

    /* ---------- 拖拽上传 ---------- */

    let dragDepth = 0;
    const veil = $('#dropVeil');
    const hasFiles = (event) => {
      const items = event.dataTransfer && event.dataTransfer.types;
      return Boolean(items && Array.from(items).includes('Files'));
    };

    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (!state.admin) return;
      dragDepth += 1;
      veil.classList.add('is-on');
    });
    window.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
    });
    window.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      if (!state.admin) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) veil.classList.remove('is-on');
    });
    window.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      veil.classList.remove('is-on');
      if (!state.admin) return;
      handleFiles(event.dataTransfer.files);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function init() {
    state.config = loadConfig();

    const params = new URLSearchParams(location.search);
    const viaUrl = params.get('admin') === '1' || location.hash === '#admin';

    state.admin = wantsAdmin();
    document.body.classList.toggle('is-admin', state.admin);

    applyConfig(state.config);
    buildPetals();
    bind();

    try {
      await loadCards();
    } catch (error) {
      console.error('[archive] 加载失败：', error);
      toast('读取角色卡失败，请刷新页面重试', 'error', 5000);
    }

    state.loaded = true;
    render();

    if (state.admin && viaUrl) {
      toast('管理模式已开启 · 上传和设置按钮已显示', 'ok', 3600);
    }
  }

  init();
})();
