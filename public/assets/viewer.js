import { hexToBytes } from './wcv3-header.js';
import { decryptFrame, decryptWcv2Frame } from './wcv3-crypto.js';

/* ── WCV3 Data Layer ────────────────────────────── */
class Wcv3DataLayer {
  constructor(session) {
    this.reader = session.reader;
    this.key = session.sessionKey;
    this.header = session.header;
    this.manifest = session.manifest;
    this.planner = session.planner;
    this.decryptedResources = session.decryptedResources;
    this.temporaryUrls = session.temporaryUrls;
    this._wcv2PackageId = session._wcv2PackageId || null;
    this._wcv2RecordById = session._wcv2RecordById || null;
    this._contacts = null;
    this._dates = null;
    this._searchIndex = null;
    this._mediaUrls = new Map();
  }

  _resourceById(id) {
    if (typeof id === 'string') id = hexToBytes(id);
    return this.planner.resource(id);
  }

  async _decryptResource(id) {
    const rid = typeof id === 'string' ? hexToBytes(id) : id;
    const cached = this.decryptedResources.get(rid);
    if (cached) return cached;
    const info = this._resourceById(rid);
    const frame = await this.reader.readFrame(info.offset, info.length);
    let data;
    if (this._wcv2PackageId) {
      const recordIndex = this._wcv2RecordById[Array.from(rid, b => b.toString(16).padStart(2, '0')).join('')];
      data = await decryptWcv2Frame(this.key, this._wcv2PackageId, recordIndex, frame);
    } else {
      data = await decryptFrame(this.key, this.header, rid, frame);
    }
    this.decryptedResources.set(rid, data);
    return data;
  }

  async getContacts() {
    if (this._contacts) return this._contacts;
    const id = this.manifest.contactsResource;
    const raw = await this._decryptResource(id);
    this._contacts = JSON.parse(new TextDecoder().decode(raw));
    return this._contacts;
  }

  async getDates() {
    if (this._dates) return this._dates;
    const id = this.manifest.datesResource;
    const raw = await this._decryptResource(id);
    this._dates = JSON.parse(new TextDecoder().decode(raw));
    return this._dates;
  }

  async getMessages(pageNum) {
    const logical = `page_${pageNum}`;
    const ridHex = this.manifest.messagePages?.[logical];
    if (!ridHex) return { messages: [], hasMore: false, total: 0 };
    const raw = await this._decryptResource(ridHex);
    const data = JSON.parse(new TextDecoder().decode(raw));
    return {
      messages: (data.messages || []).map(m => ({
        timestamp: m.t || m.timestamp || 0,
        type: m.y || m.type || 1,
        isSender: m.s !== undefined ? m.s : m.isSender,
        content: m.c !== undefined ? m.c : (m.content || ''),
        extra: m.e !== undefined ? m.e : (m.extra || {}),
      })),
      hasMore: data.hasMore !== undefined ? data.hasMore : true,
      total: data.total || 0,
    };
  }

  async getSearchIndex() {
    if (this._searchIndex) return this._searchIndex;
    const shards = this.manifest.searchShards || {};
    const index = {};
    const msgMeta = {};
    for (const [bucket, ridHex] of Object.entries(shards)) {
      const raw = await this._decryptResource(ridHex);
      const shard = JSON.parse(new TextDecoder().decode(raw));
      for (const [term, ids] of Object.entries(shard.terms || {})) {
        if (!index[term]) index[term] = [];
        index[term].push(...ids);
      }
    }
    this._searchIndex = { index, messages: msgMeta };
    return this._searchIndex;
  }

  async getMediaUrl(resourceId) {
    const cached = this._mediaUrls.get(resourceId);
    if (cached) return cached;
    const rid = typeof resourceId === 'string' ? hexToBytes(resourceId) : resourceId;
    const data = await this._decryptResource(rid);
    const item = this.planner.resource(rid);
    const blob = new Blob([data], { type: item.contentType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    this.temporaryUrls.add(url);
    this._mediaUrls.set(resourceId, url);
    return url;
  }

  getConversation() {
    const convs = this.manifest.conversations || [];
    return convs[0] || { id: 'conversation', pages: [] };
  }

  getTotalPages() {
    const conv = this.getConversation();
    return (conv.pages || []).length;
  }

  destroy() {
    for (const url of this._mediaUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this._mediaUrls.clear();
    this._contacts = null;
    this._dates = null;
    this._searchIndex = null;
  }
}

/* ── Viewer State ───────────────────────────────── */
const state = {
  dl: null,
  contacts: [],
  currentContact: null,
  messages: [],
  currentPage: 1,
  hasMore: false,
  totalMessages: 0,
  isLoading: false,
  searchQuery: '',
  searchResults: [],
  searchIndexCache: null,
  availableDates: {},
  datePickerYear: new Date().getFullYear(),
  datePickerMonth: new Date().getMonth() + 1,
  datePickerMode: 'calendar',
  dateJumped: null,
};

/* ── DOM refs ───────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);
let dom = {};

/* ── Helpers ────────────────────────────────────── */
function formatDate(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return '今天';
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatTime(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function highlightText(text, query) {
  if (!query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const q = escapeHtml(query);
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(re, '<span class="highlight">$1</span>');
}

function tokenize(text) {
  const cleaned = String(text).toLowerCase().replace(/[^一-鿿\w]/g, ' ');
  const tokens = new Set();
  for (let i = 0; i < cleaned.length - 1; i++) {
    const ch = cleaned[i], next = cleaned[i + 1];
    if (ch >= '一' && ch <= '鿿' && next >= '一' && next <= '鿿') {
      tokens.add(ch + next);
    }
  }
  cleaned.split(/\s+/).filter(w => w.length > 1).forEach(w => tokens.add(w));
  return [...tokens];
}

/* ── Data Loading ───────────────────────────────── */
async function loadContacts() {
  state.contacts = await state.dl.getContacts();
  if (state.contacts.length > 0 && !state.currentContact) {
    state.currentContact = state.contacts[0];
    dom.topbarName.textContent = state.currentContact.name || '聊天记录';
  }
}

async function loadMessages(page = 1, append = false) {
  if (state.isLoading) return;
  state.isLoading = true;
  if (dom.btnLoadMore) dom.btnLoadMore.disabled = true;

  const anchor = append && state.messages.length > 0 ? state.messages[0].timestamp : null;

  try {
    const data = await state.dl.getMessages(page);
    state.currentPage = page;
    state.hasMore = data.hasMore;
    state.totalMessages = data.total;

    if (append) {
      state.messages = [...data.messages, ...state.messages];
    } else {
      state.messages = data.messages;
    }

    if (anchor) dom.chatArea.classList.add('no-smooth-scroll');
    renderMessages();
    updateLoadMore();

    if (anchor) {
      requestAnimationFrame(() => {
        const el = dom.messagesList.querySelector(`[data-ts="${anchor}"]`);
        if (el) el.scrollIntoView({ block: 'start' });
        requestAnimationFrame(() => dom.chatArea.classList.remove('no-smooth-scroll'));
      });
    }
  } finally {
    state.isLoading = false;
    if (dom.btnLoadMore) dom.btnLoadMore.disabled = false;
  }
}

/* ── Search ──────────────────────────────────────── */
async function searchMessages(query) {
  if (!query.trim()) {
    state.searchResults = [];
    hideSearchPanel();
    renderMessages();
    return;
  }
  state.searchQuery = query;

  try {
    const idx = await state.dl.getSearchIndex();
    const tokens = tokenize(query);
    let matchedIds = null;
    for (const token of tokens) {
      const ids = idx.index[token];
      if (!ids) { matchedIds = []; break; }
      if (matchedIds === null) matchedIds = new Set(ids);
      else matchedIds = new Set([...matchedIds].filter(id => ids.includes(id)));
    }

    const results = [];
    for (const id of (matchedIds || [])) {
      const parts = id.split(':');
      const pageNum = parseInt(parts[0]);
      const localIndex = parseInt(parts[1]);
      // Load the page to get the message
      if (pageNum > 0) {
        results.push({ msgId: id, pageNum, localIndex, loaded: false });
      }
      if (results.length >= 100) break;
    }

    state.searchResults = results;
    renderSearchPanel();
  } catch (e) {
    state.searchResults = [];
    renderSearchPanel();
  }
}

/* ── Rendering ──────────────────────────────────── */
function renderMessages() {
  dom.messagesList.innerHTML = '';

  if (state.messages.length === 0 && !state.searchQuery) {
    dom.emptyHint.hidden = false;
    return;
  }
  dom.emptyHint.hidden = true;

  const searchMatchTs = new Set(state.searchResults.map(r => r.msgId));

  let lastDate = null;
  let prevTs = null;

  state.messages.forEach((msg, i) => {
    const showTime = i === 0 || (prevTs !== null && msg.timestamp - prevTs > 180);
    if (showTime && !state.dateJumped) {
      const timeDiv = document.createElement('div');
      timeDiv.className = 'time-divider';
      timeDiv.innerHTML = `<span>${formatTime(msg.timestamp)}</span>`;
      dom.messagesList.appendChild(timeDiv);
    }
    prevTs = msg.timestamp;

    const msgDate = formatDate(msg.timestamp);
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.innerHTML = `<span>${msgDate}</span>`;
      dom.messagesList.appendChild(divider);
    }

    const id = `${state.currentPage}:${i}`;
    const row = createMessageRow(msg, id, searchMatchTs.has(id));
    dom.messagesList.appendChild(row);
  });

  if (state.currentPage === 1 && !state.searchQuery) {
    setTimeout(() => { dom.chatArea.scrollTop = dom.chatArea.scrollHeight; }, 50);
  }
}

function createMessageRow(msg, msgId, isSearchMatch) {
  const row = document.createElement('div');

  if (msg.type === 10000) {
    row.className = 'msg-row system';
    row.innerHTML = `<div class="msg-bubble"><span class="text">${escapeHtml(msg.content || '')}</span></div>`;
    return row;
  }

  const showAsSent = !msg.isSender;
  row.className = `msg-row ${showAsSent ? 'sent' : 'received'}`;
  if (isSearchMatch) row.className += ' search-match';
  row.dataset.msgId = msgId;
  row.dataset.ts = msg.timestamp;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = msg.isSender ? '我' : (state.currentContact?.name || 'Ta').charAt(0);
  row.appendChild(avatar);

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  const content = msg.content || '';
  const extra = msg.extra || {};
  const query = state.searchQuery;

  switch (msg.type) {
    case 1: bubble.appendChild(buildText(content, query)); break;
    case 3: buildImageBubble(bubble, msg); break;
    case 34: buildVoiceBubble(bubble, msg, showAsSent); break;
    case 42: buildCardBubble(bubble, extra); break;
    case 43: buildVideoBubble(bubble, msg); break;
    case 47: buildEmojiBubble(bubble, content); break;
    case 48: buildPositionBubble(bubble, extra); break;
    case 49: buildAppMessageBubble(bubble, msg, extra, content, query); break;
    case 50: buildVoipBubble(bubble, content, extra); break;
    default: bubble.appendChild(buildText(content, query));
  }

  row.appendChild(bubble);
  return row;
}

function buildText(content, query) {
  const span = document.createElement('span');
  span.className = 'text';
  span.innerHTML = highlightText(content || '', query);
  return span;
}

function buildImageBubble(bubble, msg) {
  const img = document.createElement('img');
  img.className = 'msg-image';
  img.alt = '图片';
  img.addEventListener('click', () => openImagePreview(img.src));
  img.addEventListener('error', () => { img.style.display = 'none'; });
  if (msg.extra?.resourceId) {
    state.dl.getMediaUrl(msg.extra.resourceId).then(url => { img.src = url; });
  }
  bubble.appendChild(img);
}

function buildVoiceBubble(bubble, msg, showAsSent) {
  const voice = document.createElement('div');
  voice.className = 'msg-voice ' + (showAsSent ? 'sent' : 'received');
  const dur = msg.extra?.duration || parseInt(msg.content) || 0;
  const audioText = msg.extra?.audioText || '';
  voice.innerHTML = `<span class="voice-icon">🔊</span><span class="voice-dur">${dur}"</span>`;
  if (audioText) {
    const textDiv = document.createElement('div');
    textDiv.className = 'voice-text';
    textDiv.textContent = audioText;
    voice.appendChild(textDiv);
  }
  bubble.appendChild(voice);
}

function buildCardBubble(bubble, extra) {
  const card = document.createElement('div');
  card.className = 'msg-card';
  const nickname = extra.cardNickname || '未知';
  const wxid = extra.cardWxid || '';
  card.innerHTML = `<div class="card-avatar">👤</div>
    <div class="card-info"><div class="card-name">${escapeHtml(nickname)}</div>
    <div class="card-desc">个人名片</div>
    ${wxid ? `<div class="card-wxid">微信号: ${escapeHtml(wxid)}</div>` : ''}</div>`;
  bubble.appendChild(card);
}

function buildVideoBubble(bubble, msg) {
  const video = document.createElement('div');
  video.className = 'msg-video';
  video.innerHTML = '<span class="video-play-icon">▶</span>';
  if (msg.extra?.duration) {
    const dur = msg.extra.duration;
    const durLabel = document.createElement('span');
    durLabel.className = 'video-duration';
    durLabel.textContent = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`;
    video.appendChild(durLabel);
  }
  video.addEventListener('click', () => {
    if (msg.extra?.resourceId) {
      state.dl.getMediaUrl(msg.extra.resourceId).then(url => openVideoPreview(url));
    }
  });
  bubble.appendChild(video);
}

function buildEmojiBubble(bubble, content) {
  const emoji = document.createElement('span');
  emoji.className = 'msg-emoji';
  emoji.textContent = (content || '😊').substring(0, 4);
  bubble.appendChild(emoji);
}

function buildPositionBubble(bubble, extra) {
  const pos = document.createElement('div');
  pos.className = 'msg-position';
  pos.innerHTML = `<div class="position-header"><span class="position-icon">📍</span>
    <span class="position-name">${escapeHtml(extra.poiname || '未知位置')}</span></div>
    ${extra.label ? `<div class="position-label">${escapeHtml(extra.label)}</div>` : ''}
    <div class="position-map-preview">🗺️ 查看地图</div>`;
  bubble.appendChild(pos);
}

function buildVoipBubble(bubble, content, extra) {
  const voip = document.createElement('div');
  voip.className = 'msg-voip';
  const icon = (extra.inviteType || 1) === 0 ? '📹' : '📞';
  voip.innerHTML = `<span class="voip-icon">${icon}</span> <span class="voip-text">${escapeHtml(content || '通话')}</span>`;
  bubble.appendChild(voip);
}

function buildAppMessageBubble(bubble, msg, extra, content, query) {
  const lower = (content || '').toLowerCase();

  if (extra.quoteText) {
    const quote = document.createElement('div');
    quote.className = 'msg-quote';
    quote.innerHTML = `<div class="quote-reference">${escapeHtml(extra.quoteText).substring(0, 120)}</div>
      <div class="quote-content">${highlightText(content, query)}</div>`;
    bubble.appendChild(quote);
    return;
  }

  if (extra.mergedTitle) {
    const merged = document.createElement('div');
    merged.className = 'msg-merged';
    merged.innerHTML = `<div class="merged-icon">📋</div>
      <div class="merged-title">${escapeHtml(extra.mergedTitle)}</div>
      <div class="merged-count">${extra.mergedCount || '?'} 条聊天记录</div>`;
    bubble.appendChild(merged);
    return;
  }

  if (extra.fileName) {
    const fileDiv = document.createElement('div');
    fileDiv.className = 'msg-file';
    const ext = extra.fileName.split('.').pop().toLowerCase();
    const icons = { pdf: '📄', doc: '📃', docx: '📃', xls: '📈', xlsx: '📈', ppt: '📅', pptx: '📅', zip: '📦', rar: '📦', jpg: '🖼', png: '🖼', mp4: '🎬', mp3: '🎵', txt: '📝', md: '📝' };
    fileDiv.innerHTML = `<span class="file-icon">${icons[ext] || '📎'}</span>
      <div class="file-info"><div class="file-name">${escapeHtml(extra.fileName)}</div>
      ${extra.fileSize ? `<div class="file-size">${(extra.fileSize / 1024).toFixed(1)}KB</div>` : ''}</div>`;
    bubble.appendChild(fileDiv);
    return;
  }

  if (lower.includes('红包') || (content && content.includes('🧧'))) {
    const rp = document.createElement('div');
    rp.className = 'msg-redpacket';
    rp.textContent = content || '🧧 恭喜发财';
    bubble.appendChild(rp);
    return;
  }

  if (lower.includes('小程序') || extra.appName) {
    const mp = document.createElement('div');
    mp.className = 'msg-miniprogram';
    mp.innerHTML = `<span class="mp-icon">📱</span>
      <div class="mp-info"><div class="mp-title">${escapeHtml(extra.appName || extra.title || '小程序')}</div>
      <div class="mp-desc">小程序</div></div>`;
    bubble.appendChild(mp);
    return;
  }

  bubble.appendChild(buildText(content, query));
}

function updateLoadMore() {
  if (state.hasMore) {
    dom.loadMore.hidden = false;
    dom.btnLoadMore.textContent = '加载更多...';
    dom.btnLoadMore.disabled = false;
  } else {
    dom.loadMore.hidden = true;
  }
}

/* ── Search Panel ──────────────────────────────── */
function renderSearchPanel() {
  if (!state.searchQuery) { hideSearchPanel(); return; }
  dom.searchPanel.hidden = false;
  dom.searchResultTitle.textContent = `"${state.searchQuery}" (${state.searchResults.length}条)`;

  if (state.searchResults.length === 0) {
    dom.searchList.innerHTML = '<div class="search-empty">未找到匹配的消息</div>';
    return;
  }

  let html = '';
  state.searchResults.forEach((r, i) => {
    const id = r.msgId;
    html += `<div class="search-result-item" data-si="${i}">
      <div class="sr-content">消息 #${id}</div></div>`;
  });
  dom.searchList.innerHTML = html;

  dom.searchList.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => jumpToSearchResult(parseInt(item.dataset.si)));
  });
}

function hideSearchPanel() { dom.searchPanel.hidden = true; }

async function jumpToSearchResult(resultIndex) {
  const result = state.searchResults[resultIndex];
  if (!result) return;
  hideSearchPanel();
  state.messages = [];
  state.currentPage = result.pageNum;
  state.dateJumped = null;
  await loadMessages(result.pageNum, false);
}

/* ── Media Preview ──────────────────────────────── */
function openImagePreview(src) {
  dom.imagePreview.src = src;
  dom.imageOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeImagePreview() {
  dom.imageOverlay.hidden = true;
  dom.imagePreview.src = '';
  document.body.style.overflow = '';
}

function openVideoPreview(src) {
  dom.videoPreview.src = src;
  dom.videoOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
  dom.videoPreview.play().catch(() => {});
}

function closeVideoPreview() {
  dom.videoOverlay.hidden = true;
  dom.videoPreview.pause();
  dom.videoPreview.src = '';
  document.body.style.overflow = '';
}

/* ── Date Navigation ────────────────────────────── */
async function loadAvailableDates() {
  try {
    const data = await state.dl.getDates();
    state.availableDates = {};
    (data.dates || []).forEach(d => { state.availableDates[d.date] = d; });
  } catch (e) {
    state.availableDates = {};
  }
}

function showDatePanel() {
  dom.datePanel.hidden = false;
  const dateKeys = Object.keys(state.availableDates);
  if (dateKeys.length > 0) {
    const lastDate = dateKeys[dateKeys.length - 1];
    const parts = lastDate.split('-');
    state.datePickerYear = parseInt(parts[0]);
    state.datePickerMonth = parseInt(parts[1]);
  }
  renderDateGrid();
}

function hideDatePanel() { dom.datePanel.hidden = true; }

function renderDateGrid() {
  const year = state.datePickerYear;
  const month = state.datePickerMonth;
  dom.dateYearMonth.textContent = `${year}年 ${month}月`;

  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  let html = '';
  for (let i = 0; i < firstDay; i++) html += '<div class="date-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const info = state.availableDates[dateStr];
    let cls = 'date-cell';
    if (info) cls += ' has-msgs';
    if (dateStr === todayStr) cls += ' today';
    const count = info ? info.count : 0;
    html += `<div class="${cls}" data-date="${dateStr}" ${info ? '' : 'data-empty="1"'}><span class="date-num">${d}</span></div>`;
  }
  dom.dateGrid.innerHTML = html;

  dom.dateGrid.querySelectorAll('.date-cell.has-msgs').forEach(cell => {
    cell.addEventListener('click', () => jumpToDate(cell.dataset.date));
  });
}

async function jumpToDate(dateStr) {
  const info = state.availableDates[dateStr];
  if (!info) return;
  const startPage = info.pageStart || info.firstPage;
  if (!startPage) return;
  hideDatePanel();

  state.messages = [];
  state.currentPage = startPage;
  state.dateJumped = { date: dateStr, startPage };
  state.searchQuery = '';
  state.searchResults = [];
  dom.searchInput.value = '';

  try {
    state.isLoading = true;
    const data = await state.dl.getMessages(startPage);
    const dayStart = new Date(dateStr + 'T00:00:00+08:00').getTime() / 1000;
    const dayEnd = dayStart + 86400;
    state.messages = data.messages.filter(m => m.timestamp >= dayStart && m.timestamp < dayEnd);
    state.hasMore = startPage > 1;
    state.totalMessages = data.total;
    renderMessages();
    updateLoadMore();
  } finally {
    state.isLoading = false;
  }
  dom.chatArea.scrollTop = 0;
}

function changeDateMonth(delta) {
  let newMonth = state.datePickerMonth + delta;
  let newYear = state.datePickerYear;
  if (newMonth > 12) { newMonth = 1; newYear++; }
  else if (newMonth < 1) { newMonth = 12; newYear--; }
  state.datePickerYear = newYear;
  state.datePickerMonth = newMonth;
  renderDateGrid();
}

/* ── Search bar ──────────────────────────────────── */
function clearSearch() {
  state.searchQuery = '';
  state.searchResults = [];
  dom.searchInput.value = '';
  hideSearchPanel();
  renderMessages();
}

/* ── Init ────────────────────────────────────────── */
export async function initViewer(session) {
  state.dl = new Wcv3DataLayer(session);

  // Bind DOM
  dom = {
    topbarName: $('#topbar-name'),
    btnMenu: $('#btn-menu'),
    menuDropdown: $('#menu-dropdown'),
    menuDate: $('#menu-date'),
    menuSearch: $('#menu-search'),
    searchBar: $('#search-bar'),
    searchInput: $('#search-input'),
    searchClear: $('#btn-search-clear'),
    searchClose: $('#btn-search-close'),
    searchPanel: $('#search-panel'),
    searchList: $('#search-list'),
    searchPanelClose: $('#search-panel-close'),
    searchResultTitle: $('#search-result-title'),
    chatArea: $('#chat-area'),
    messagesList: $('#messages-list'),
    loadMore: $('#load-more'),
    btnLoadMore: $('#btn-load-more'),
    emptyHint: $('#empty-hint'),
    imageOverlay: $('#image-overlay'),
    imagePreview: $('#image-preview'),
    imageClose: $('#image-close'),
    videoOverlay: $('#video-overlay'),
    videoPreview: $('#video-preview'),
    videoClose: $('#video-close'),
    datePanel: $('#date-panel'),
    dateYearMonth: $('#date-year-month'),
    dateGrid: $('#date-grid'),
    datePrevMonth: $('#date-prev-month'),
    dateNextMonth: $('#date-next-month'),
    dateCloseBtn: $('#date-close-btn'),
    dateJumpLatest: $('#date-jump-latest'),
  };

  // Menu
  dom.btnMenu.addEventListener('click', () => {
    dom.menuDropdown.hidden = !dom.menuDropdown.hidden;
  });
  dom.menuDate.addEventListener('click', () => { dom.menuDropdown.hidden = true; showDatePanel(); });
  dom.menuSearch.addEventListener('click', () => { dom.menuDropdown.hidden = true; dom.searchBar.hidden = false; dom.searchInput.focus(); });
  document.addEventListener('click', (e) => {
    if (!dom.btnMenu.contains(e.target) && !dom.menuDropdown.contains(e.target)) dom.menuDropdown.hidden = true;
  });

  // Search
  if (dom.searchClose) dom.searchClose.addEventListener('click', () => { dom.searchBar.hidden = true; clearSearch(); });
  let searchTimeout;
  dom.searchInput.addEventListener('input', () => {
    const query = dom.searchInput.value.trim();
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.searchQuery = query;
      if (!query) { state.searchResults = []; hideSearchPanel(); renderMessages(); }
      else searchMessages(query);
    }, 300);
  });
  dom.searchClear.addEventListener('click', clearSearch);

  // Search panel
  dom.searchPanelClose.addEventListener('click', hideSearchPanel);
  dom.searchPanel.addEventListener('click', (e) => { if (e.target === dom.searchPanel) hideSearchPanel(); });

  // Date panel
  dom.dateCloseBtn.addEventListener('click', hideDatePanel);
  dom.datePanel.addEventListener('click', (e) => { if (e.target === dom.datePanel) hideDatePanel(); });
  dom.datePrevMonth.addEventListener('click', () => changeDateMonth(-1));
  dom.dateNextMonth.addEventListener('click', () => changeDateMonth(1));
  dom.dateJumpLatest.addEventListener('click', () => {
    hideDatePanel();
    state.dateJumped = null;
    state.messages = [];
    state.currentPage = 1;
    clearSearch();
    loadMessages(1, false);
  });

  // Load more
  dom.btnLoadMore.addEventListener('click', () => {
    if (state.hasMore) loadMessages(state.currentPage + 1, true);
  });

  // Infinite scroll
  let scrollDebounce = false;
  dom.chatArea.addEventListener('scroll', () => {
    if (dom.chatArea.scrollTop < 120 && state.hasMore && !state.isLoading && !scrollDebounce) {
      scrollDebounce = true;
      setTimeout(() => { scrollDebounce = false; }, 500);
      loadMessages(state.currentPage + 1, true);
    }
  });

  // Image/video preview
  dom.imageClose.addEventListener('click', closeImagePreview);
  dom.imageOverlay.addEventListener('click', (e) => { if (e.target === dom.imageOverlay) closeImagePreview(); });
  dom.videoClose.addEventListener('click', closeVideoPreview);
  dom.videoOverlay.addEventListener('click', (e) => { if (e.target === dom.videoOverlay) closeVideoPreview(); });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!dom.imageOverlay.hidden) closeImagePreview();
      if (!dom.videoOverlay.hidden) closeVideoPreview();
      if (!dom.datePanel.hidden) hideDatePanel();
      if (!dom.searchPanel.hidden) hideSearchPanel();
      if (state.searchQuery) clearSearch();
    }
  });

  // Load data
  await loadContacts();
  await loadAvailableDates();
  if (state.contacts.length > 0) {
    state.currentContact = state.contacts[0];
    dom.topbarName.textContent = state.currentContact.name || '聊天记录';
    await loadMessages(1, false);
  }
}

export function cleanupViewerPresentation(presentation) {
  if (!presentation) return;
  const { body, elements, playableVoices, viewerState } = presentation;
  if (elements) {
    for (const name of ['searchPanel', 'datePanel', 'imageOverlay', 'videoOverlay', 'menuDropdown', 'searchBar', 'loadMore']) {
      const el = elements[name];
      if (el) el.hidden = true;
    }
    if (elements.imagePreview) elements.imagePreview.removeAttribute('src');
    if (elements.videoPreview) {
      if (!elements.videoPreview.paused) elements.videoPreview.pause();
      elements.videoPreview.removeAttribute('src');
    }
  }
  if (playableVoices) {
    for (const voice of playableVoices) {
      if (!voice.paused) voice.pause();
      voice.classList.remove('playing');
    }
  }
  if (body && body.style) body.style.removeProperty('overflow');
  if (viewerState) {
    if (Object.hasOwn(viewerState, 'searchQuery')) viewerState.searchQuery = '';
    if (Object.hasOwn(viewerState, 'searchResults')) viewerState.searchResults = [];
    if (Object.hasOwn(viewerState, 'searchIndexCache')) viewerState.searchIndexCache = null;
    if (Object.hasOwn(viewerState, 'dateJumped')) viewerState.dateJumped = null;
    if (Object.hasOwn(viewerState, 'isLoading')) viewerState.isLoading = false;
  }
}

export function destroyViewer() {
  state.dl?.destroy();
  state.dl = null;
  const body = document?.body;
  const voices = document?.querySelectorAll?.('.playing, audio') || [];
  cleanupViewerPresentation({
    body,
    elements: dom,
    playableVoices: voices,
    viewerState: state,
  });
}
