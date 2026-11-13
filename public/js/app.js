// The app itself: screens, buttons, sending messages, affection, pictures, videos and the gallery.
(() => {
  'use strict';
  const t = (...a) => I18N.t(...a);

  // ---------- Defaults you can change in Settings ----------
  const DEFAULT_SETTINGS = {
    password: '',
    language: I18N.guess(),
    userName: '',
    textModel: 'gemini-3.8-flash',
    imageModel: 'gemini-nano-banana-2.1',
    videoModel: 'veo-3.1-fast-generate-001',
    pictureMode: 'scene', // 'scene' | 'every' | 'off'
    motion: 'on', // gentle movement on still pictures
    romance: 'mature', // 'sweet' | 'flirty' | 'mature'
    safety: 'minimum', // 'minimum' | 'relaxed' | 'standard'
    videoSeconds: '4', // 4 | 6 | 8
    videoAudio: 'off',
  };
  const TEXT_MODELS = [
    ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
    ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'],
    ['gemini-4-hydrogen', 'Gemini 4 Hydrogen'],
    ['gemini-4-argon', 'Gemini 4 Argon'],
    ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
  ];
  const IMAGE_MODELS = [
    ['gemini-nano-banana-2.1', 'Nano Banana 2.1'],
    ['gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite'],
    ['gemini-3.1-flash-image', 'Nano Banana 2'],
    ['gemini-3-pro-image', 'Nano Banana Pro'],
    ['gemini-2.5-flash-image', 'Nano Banana (2.5)'],
  ];
  const VIDEO_MODELS = [
    ['veo-3.1-fast-generate-001', 'Veo 3.1 Fast'],
    ['veo-3.1-generate-001', 'Veo 3.1'],
  ];
  const MAX_MEMORIES = 40;
  const PICTURE_GAP = 5; // in "scene" mode, draw at least every N replies
  const VIDEO_POLL_MS = 8000;
  const VIDEO_TIMEOUT_MS = 15 * 60 * 1000;
  const LOCALIZED = ['genre', 'tagline', 'speakingStyle', 'scenario', 'greeting']; // fields with a Cantonese version

  // ---------- State ----------
  const S = {
    settings: { ...DEFAULT_SETTINGS },
    custom: {}, // characters you created or edited
    characters: [],
    portraits: {}, // character id -> picture
    progress: {}, // character id -> affection (for the home screen)
    chats: new Map(), // character id -> chat
    galleries: new Map(), // character id -> gallery
    images: new Map(), // picture id -> data URL
    videoUrls: new Map(), // picture id -> playable video URL
    videoIds: new Set(), // pictures that have a video
    videoJobs: {}, // picture id -> video being made
    view: 'home',
    char: null,
    chat: null,
    viewer: null, // what the picture viewer is showing
    banner: null, // home screen notice
    busy: new Set(), // character ids waiting for a reply
    drawing: new Set(), // things being drawn
    animating: new Set(), // pictures being turned into videos
    portraitJobs: new Map(),
  };

  // ---------- Small helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#8b5cf6');
  const firstName = (char) => char.name.replace(/^(Captain|Lord|Lady|Dr\.?|Sir)\s+/i, '').split(' ')[0];
  const loc = Api.loc;
  const plain = (text) => String(text || '').replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
  const imgIdOf = (m) => (m.image === true ? m.id : m.image || null); // older saves used `true`

  // Turns *actions* into italics and keeps everything else as plain text (safe from code injection).
  function formatText(text) {
    let h = esc(text);
    h = h.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\*([^*\n]+?)\*/g, '<em class="act">$1</em>');
    return h
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    const box = $('#toasts');
    box.appendChild(el);
    while (box.children.length > 3) box.firstElementChild.remove(); // never cover the whole screen
    const ms = kind === 'error' ? 7000 : 3400;
    setTimeout(() => el.classList.add('hide'), ms);
    setTimeout(() => el.remove(), ms + 600);
  }

  function b64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  // ---------- Saving & loading ----------
  async function loadAll() {
    S.settings = { ...DEFAULT_SETTINGS, ...(await Store.get('settings', {})) };
    I18N.set(S.settings.language);
    S.custom = await Store.get('characters:custom', {});
    S.progress = await Store.get('progress', {});
    S.videoJobs = await Store.get('videoJobs', {});
    S.videoIds = new Set((await Store.keys('vid:')).map((k) => k.slice(4)));
    rebuildCharacters();
    await Promise.all(
      S.characters.map(async (c) => {
        const p = await Store.get('portrait:' + c.id);
        if (p) S.portraits[c.id] = p;
        await getGallery(c.id);
      }),
    );
  }

  function rebuildCharacters() {
    const starterIds = new Set(STARTER_CHARACTERS.map((c) => c.id));
    const starters = STARTER_CHARACTERS.map((c) => {
      const o = S.custom[c.id];
      return o ? { ...c, ...o, zh: { ...(c.zh || {}), ...(o.zh || {}) }, starter: true, edited: true } : { ...c, starter: true };
    });
    const mine = Object.values(S.custom).filter((c) => !starterIds.has(c.id));
    S.characters = [...mine, ...starters];
    if (S.char) S.char = S.characters.find((c) => c.id === S.char.id) || null;
  }

  const findChar = (id) => S.characters.find((c) => c.id === id);
  const saveSettings = () => Store.set('settings', S.settings);
  const saveCustom = () => Store.set('characters:custom', S.custom);

  async function saveChat(id, chat) {
    S.progress[id] = chat.affection;
    await Store.set('chat:' + id, chat);
    await Store.set('progress', S.progress);
  }

  async function getGallery(id) {
    if (!S.galleries.has(id)) S.galleries.set(id, await Store.get('gallery:' + id, { items: [], unlocked: {} }));
    return S.galleries.get(id);
  }
  const saveGallery = (id, g) => Store.set('gallery:' + id, g);

  async function getImage(id) {
    if (!id) return null;
    if (!S.images.has(id)) {
      const url = await Store.get('img:' + id);
      if (url) S.images.set(id, url);
    }
    return S.images.get(id) || null;
  }
  async function putImage(id, url) {
    S.images.set(id, url);
    await Store.set('img:' + id, url);
  }
  async function getVideoUrl(id) {
    if (!S.videoIds.has(id)) return null;
    if (!S.videoUrls.has(id)) {
      const blob = await Store.get('vid:' + id);
      if (!blob) return null;
      S.videoUrls.set(id, URL.createObjectURL(blob));
    }
    return S.videoUrls.get(id);
  }
  async function deleteMedia(id) {
    if (!id) return;
    await Store.del('img:' + id);
    await Store.del('vid:' + id);
    S.images.delete(id);
    S.videoIds.delete(id);
    if (S.videoUrls.has(id)) URL.revokeObjectURL(S.videoUrls.get(id));
    S.videoUrls.delete(id);
  }

  function newChat(char) {
    return {
      affection: clamp(Math.round(Number(char.startAffection) || 20), 0, 100),
      mood: '',
      memories: [],
      suggestions: [],
      messages: [{ id: uid(), role: 'char', text: loc(char, 'greeting'), scene: char.scenario }],
    };
  }

  const milestonesOf = (char) =>
    (char.milestones?.length ? char.milestones : DEFAULT_MILESTONES).map((m) => ({ ...m, scene: m.scene.replace(/\{name\}/g, char.name) }));
  const msTitle = (m) => (I18N.lang === 'zh-HK' && m.zh) || m.title;
  const msKey = (char, at) => `ms:${char.id}:${at}`;
  const isCurrent = (char, chat) => S.char && S.char.id === char.id && S.chat === chat;
  const picturesOn = () => S.settings.pictureMode !== 'off';

  // ---------- Navigation (uses the address bar so the phone's back button works) ----------
  function route() {
    const m = location.hash.match(/^#\/(chat|gallery)\/(.+)$/);
    if (m && m[1] === 'chat') openChat(decodeURIComponent(m[2]));
    else if (m && m[1] === 'gallery') openGallery(decodeURIComponent(m[2]));
    else showHome();
  }
  const goChat = (id) => (location.hash = '#/chat/' + encodeURIComponent(id));
  const goGallery = (id) => (location.hash = '#/gallery/' + encodeURIComponent(id));
  const goHome = () => (location.hash = '');

  function showScreen(name) {
    S.view = name;
    for (const s of ['home', 'chat', 'gallery']) $('#' + s).hidden = s !== name;
  }

  function refreshViews(char) {
    if (S.view === 'home') renderHome();
    else if (S.char && char && S.char.id === char.id) {
      if (S.view === 'chat') renderChat();
      if (S.view === 'gallery') renderGallery();
    }
  }

  // Words that are written directly in index.html
  function applyStaticText() {
    document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  }

  // ---------- Home screen ----------
  function showHome() {
    S.char = null;
    S.chat = null;
    showScreen('home');
    renderHome();
  }

  function renderHome() {
    const banner = $('#key-banner');
    if (S.banner) {
      banner.hidden = false;
      banner.innerHTML = `<p>${S.banner.html}</p>${
        S.banner.button ? `<button class="primary" data-act="password">${esc(t('enterPassword'))}</button>` : ''
      }`;
    } else banner.hidden = true;

    const cards = S.characters.map((c) => {
      const p = S.portraits[c.id];
      const aff = S.progress[c.id];
      const g = S.galleries.get(c.id);
      const unlocked = g ? Object.keys(g.unlocked).length : 0;
      return `<button class="card" data-id="${esc(c.id)}" style="--c:${safeColor(c.color)}">
        ${p ? `<img src="${esc(p)}" alt="">` : `<span class="initial">${esc(c.name.trim()[0] || '?')}</span>`}
        <span class="card-info">
          <span class="genre">${esc(loc(c, 'genre') || 'Story')}</span>
          <strong>${esc(c.name)}</strong>
          <span class="tag">${esc(loc(c, 'tagline') || '')}</span>
          ${
            aff !== undefined
              ? `<span class="mini-bar"><span style="width:${aff}%"></span></span>
                 <span class="mini-label">♥ ${esc(Api.tierLabel(Api.tierIndex(aff)))} · ${aff}${unlocked ? ` · 🔓 ${unlocked}/${milestonesOf(c).length}` : ''}</span>`
              : ''
          }
        </span>
      </button>`;
    });
    cards.push(`<button class="card add" data-act="new-char">
        <span class="plus">+</span>
        <span class="card-info"><strong>${esc(t('createCharacter'))}</strong><span class="tag">${esc(t('createCharacterSub'))}</span></span>
      </button>`);
    $('#char-grid').innerHTML = cards.join('');
  }

  // Checks the password and server setup, and shows a notice on the home screen if needed.
  async function checkServer() {
    if (!S.settings.password) {
      S.banner = { html: t('welcome'), button: true };
    } else {
      try {
        await Api.ping(S.settings.password);
        S.banner = null;
      } catch (e) {
        if (e.kind === 'auth') S.banner = { html: esc(t('passwordWrong')), button: true };
        else S.banner = { html: esc(e.message), button: false };
      }
    }
    if (S.view === 'home') renderHome();
  }

  // ---------- Pictures & videos on screen ----------
  function mediaBox(imageId, act, extra = '') {
    const live = S.settings.motion === 'on' ? ' live' : '';
    return `<div class="pic${live}" data-media="${esc(imageId)}" data-act="${act}" ${extra}></div>`;
  }
  const loadingBox = (label) => `<div class="pic loading"><span>${esc(label)}</span></div>`;

  function hydrateMedia(root) {
    root.querySelectorAll('[data-media]').forEach(async (box) => {
      const id = box.dataset.media;
      const vurl = await getVideoUrl(id);
      if (vurl) {
        box.classList.add('has-video');
        box.replaceChildren(makeVideo(vurl, false));
        return;
      }
      const url = await getImage(id);
      if (url) {
        const img = new Image();
        img.alt = '';
        img.src = url;
        box.replaceChildren(img);
      }
    });
  }

  function makeVideo(url, controls) {
    const v = document.createElement('video');
    v.src = url;
    v.muted = !controls;
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    v.controls = controls;
    v.setAttribute('playsinline', '');
    if (!controls) v.setAttribute('muted', '');
    v.play?.().catch(() => {});
    return v;
  }

  // ---------- Chat screen ----------
  async function openChat(id) {
    const char = findChar(id);
    if (!char) return goHome();
    let chat = S.chats.get(id) || (await Store.get('chat:' + id));
    const fresh = !chat;
    if (fresh) {
      chat = newChat(char);
      await saveChat(id, chat);
    }
    S.chats.set(id, chat);
    S.char = char;
    S.chat = chat;
    showScreen('chat');
    $('#chat').style.setProperty('--c', safeColor(char.color));
    renderChat(true);
    if (!S.settings.password) return openPassword();
    if (fresh && picturesOn()) drawScene(char, chat, chat.messages[0]);
    else if (!S.portraits[id] && picturesOn()) ensurePortrait(char);
    checkMilestones(char, chat);
  }

  function renderChatHeader() {
    const { char, chat } = S;
    if (!char || !chat) return;
    $('#chat-name').textContent = char.name;
    $('#chat-mood').textContent = chat.mood ? t('feeling', { mood: chat.mood }) : loc(char, 'genre') || '';
    const av = $('#chat-avatar');
    const p = S.portraits[char.id];
    av.innerHTML = p ? `<img src="${esc(p)}" alt="">` : esc(char.name.trim()[0] || '?');
    av.classList.toggle('loading', S.portraitJobs.has(char.id));
    const a = chat.affection;
    const next = Api.nextTierMin(a);
    $('#aff-fill').style.width = a + '%';
    $('#aff-label').textContent = Api.tierLabel(Api.tierIndex(a));
    $('#aff-num').textContent = next !== null ? t('nextAt', { a, n: next }) : t('maxed', { a });
  }

  function renderMessage(m, canReroll) {
    if (m.role === 'system') {
      return `<div class="msg system"><span>${esc(m.text)}</span>${
        m.retry ? ` <button class="link" data-act="retry" data-id="${m.id}">${esc(t('tryAgain'))}</button>` : ''
      }</div>`;
    }
    if (m.role === 'user') return `<div class="msg user"><div class="bubble">${formatText(m.text)}</div></div>`;

    const imageId = imgIdOf(m);
    const drawing = S.drawing.has(m.id);
    const pic = imageId ? mediaBox(imageId, 'view', `data-msg="${m.id}"`) : drawing ? loadingBox(t('drawing')) : '';
    const tools = [];
    if (m.delta) {
      tools.push(
        `<span class="delta ${m.delta > 0 ? 'up' : 'down'}">${m.delta > 0 ? '+' : ''}${m.delta} ♥${
          m.reason ? ` <span class="why">${esc(m.reason)}</span>` : ''
        }</span>`,
      );
    }
    if (!imageId && !drawing) tools.push(`<button data-act="draw" data-id="${m.id}">${esc(t('picture'))}</button>`);
    if (imageId && !S.videoIds.has(imageId)) {
      tools.push(
        S.animating.has(imageId)
          ? `<span class="status">${esc(t('animating'))}</span>`
          : `<button data-act="animate" data-id="${m.id}">${esc(t('animate'))}</button>`,
      );
    }
    if (canReroll) tools.push(`<button data-act="reroll" data-id="${m.id}">${esc(t('anotherReply'))}</button>`);
    return `<div class="msg char">${pic}<div class="bubble">${formatText(m.text)}</div><div class="tools">${tools.join('')}</div></div>`;
  }

  function renderChat(forceScroll = false) {
    const { char, chat } = S;
    if (!char || !chat || S.view !== 'chat') return;
    renderChatHeader();
    const box = $('#messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    const busy = S.busy.has(char.id);
    let lastChar = -1;
    chat.messages.forEach((m, i) => m.role === 'char' && (lastChar = i));
    const html = chat.messages.map((m, i) => renderMessage(m, !busy && i === lastChar && i > 0)).join('');
    const typing = busy ? `<div class="msg char"><div class="bubble typing"><span></span><span></span><span></span></div></div>` : '';
    box.innerHTML = html + typing;
    hydrateMedia(box);

    const sugg = busy ? [] : chat.suggestions || [];
    $('#suggestions').innerHTML = sugg.map((s, i) => `<button data-i="${i}">${esc(s)}</button>`).join('');
    $('#send').disabled = busy;
    if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
  }

  // ---------- Talking to the character ----------
  async function send(text) {
    const { char, chat } = S;
    text = (text || '').trim();
    if (!text || !char || S.busy.has(char.id)) return;
    if (!S.settings.password) return openPassword();
    chat.messages = chat.messages.filter((m) => m.role !== 'system');
    chat.messages.push({ id: uid(), role: 'user', text });
    $('#input').value = '';
    autosize();
    await requestReply(char, chat);
  }

  async function requestReply(char, chat) {
    S.busy.add(char.id);
    chat.suggestions = [];
    refreshViews(char);
    if (S.view === 'chat') renderChat(true);
    let result = null;
    try {
      const r = await Api.chatReply(char, chat, S.settings);
      const before = chat.affection;
      chat.affection = clamp(before + r.delta, 0, 100);
      const msg = {
        id: uid(),
        role: 'char',
        text: r.reply,
        scene: r.scene,
        delta: chat.affection - before,
        reason: r.reason,
        prevMood: chat.mood,
        memAdded: 0,
      };
      chat.mood = r.mood || chat.mood;
      for (const fact of r.remember) {
        if (!chat.memories.some((x) => x.toLowerCase() === fact.toLowerCase())) {
          chat.memories.push(fact);
          msg.memAdded++;
        }
      }
      while (chat.memories.length > MAX_MEMORIES) chat.memories.shift();
      chat.suggestions = r.suggestions;
      chat.messages.push(msg);
      result = { msg, before, sceneChanged: r.sceneChanged };
    } catch (e) {
      const settingsProblem = ['auth', 'model', 'setup'].includes(e.kind);
      chat.messages.push({ id: uid(), role: 'system', text: e.message, retry: !settingsProblem || e.kind === 'model' });
      if (e.kind === 'auth' && isCurrent(char, chat)) openPassword(t('passwordWrong'));
    } finally {
      S.busy.delete(char.id);
      await saveChat(char.id, chat);
      if (isCurrent(char, chat) && S.view === 'chat') renderChat(true);
    }
    if (!result) return;
    if (isCurrent(char, chat)) announceAffection(char, result.before, chat.affection);
    if (shouldDraw(chat, result.sceneChanged)) drawScene(char, chat, result.msg);
    checkMilestones(char, chat);
  }

  function shouldDraw(chat, sceneChanged) {
    if (!picturesOn()) return false;
    if (S.settings.pictureMode === 'every' || sceneChanged) return true;
    const replies = chat.messages.filter((m) => m.role === 'char');
    const lastPic = replies.map((m) => Boolean(imgIdOf(m))).lastIndexOf(true);
    return replies.length - 1 - lastPic >= PICTURE_GAP;
  }

  function announceAffection(char, before, after) {
    if (after === before) return;
    const bar = $('#affection');
    bar.classList.remove('pulse-up', 'pulse-down');
    void bar.offsetWidth; // restart the animation
    bar.classList.add(after > before ? 'pulse-up' : 'pulse-down');
    const i1 = Api.tierIndex(before);
    const i2 = Api.tierIndex(after);
    if (i1 !== i2) {
      const up = i2 > i1;
      toast(t(up ? 'nowLevelUp' : 'nowLevelDown', { name: firstName(char), level: Api.tierLabel(i2) }), up ? 'good' : 'bad');
    }
  }

  async function reroll(msgId) {
    const { char, chat } = S;
    if (!char || S.busy.has(char.id)) return;
    const i = chat.messages.findIndex((m) => m.id === msgId);
    if (i <= 0) return;
    const m = chat.messages[i];
    chat.affection = clamp(chat.affection - (m.delta || 0), 0, 100);
    if (m.memAdded) chat.memories.splice(-m.memAdded, m.memAdded);
    chat.mood = m.prevMood || '';
    chat.messages.splice(i); // its picture (if any) stays in the gallery
    await requestReply(char, chat);
  }

  async function retry(msgId) {
    const { char, chat } = S;
    if (!char || S.busy.has(char.id)) return;
    chat.messages = chat.messages.filter((m) => m.id !== msgId);
    if (chat.messages[chat.messages.length - 1]?.role !== 'user') return renderChat();
    await requestReply(char, chat);
  }

  // ---------- Pictures ----------
  function ensurePortrait(char, force = false) {
    if (!force && S.portraits[char.id]) return Promise.resolve(S.portraits[char.id]);
    if (S.portraitJobs.has(char.id)) return S.portraitJobs.get(char.id);
    const job = (async () => {
      try {
        const url = await Api.image(Api.portraitPrompt(char), S.settings);
        S.portraits[char.id] = url;
        await Store.set('portrait:' + char.id, url);
        return url;
      } catch (e) {
        toast(t('portraitFailed', { msg: e.message }), 'error');
        return S.portraits[char.id] || null;
      } finally {
        S.portraitJobs.delete(char.id);
        refreshViews(char);
      }
    })();
    S.portraitJobs.set(char.id, job);
    refreshViews(char);
    return job;
  }

  async function drawScene(char, chat, msg) {
    if (S.drawing.has(msg.id)) return;
    if (!S.settings.password) return openPassword();
    S.drawing.add(msg.id);
    refreshViews(char);
    try {
      const ref = await ensurePortrait(char);
      const scene = msg.scene || char.scenario;
      const url = await Api.image(Api.scenePrompt(char, scene, Boolean(ref)), S.settings, ref);
      const id = uid();
      await putImage(id, url);
      const g = await getGallery(char.id);
      g.items.push({ id, at: Date.now(), caption: plain(msg.text).slice(0, 140), scene });
      await saveGallery(char.id, g);
      if (chat.messages.includes(msg)) {
        msg.image = id;
        await saveChat(char.id, chat);
      }
    } catch (e) {
      toast(t('pictureFailed', { msg: e.message }), 'error');
      if (e.kind === 'auth') openPassword(t('passwordWrong'));
    } finally {
      S.drawing.delete(msg.id);
      refreshViews(char);
    }
  }

  // ---------- Milestones (special scenes unlocked by affection) ----------
  async function checkMilestones(char, chat) {
    const g = await getGallery(char.id);
    const newly = milestonesOf(char).filter((m) => chat.affection >= m.at && !g.unlocked[m.at]);
    if (!newly.length) return;
    for (const m of newly) g.unlocked[m.at] = { at: Date.now(), image: null };
    await saveGallery(char.id, g);
    for (const m of newly) {
      toast(t('unlocked', { title: msTitle(m) }), 'good');
      if (picturesOn() && S.settings.password) drawMilestone(char, m);
    }
    refreshViews(char);
  }

  async function drawMilestone(char, m) {
    const key = msKey(char, m.at);
    if (S.drawing.has(key)) return;
    S.drawing.add(key);
    refreshViews(char);
    try {
      const ref = await ensurePortrait(char);
      const url = await Api.image(Api.scenePrompt(char, m.scene, Boolean(ref)), S.settings, ref);
      const id = uid();
      await putImage(id, url);
      const g = await getGallery(char.id);
      g.unlocked[m.at] = { ...(g.unlocked[m.at] || { at: Date.now() }), image: id };
      await saveGallery(char.id, g);
    } catch (e) {
      toast(t('pictureFailed', { msg: e.message }), 'error');
    } finally {
      S.drawing.delete(key);
      refreshViews(char);
    }
  }

  // ---------- Videos ----------
  async function animate(imageId, char, scene) {
    if (!imageId || S.animating.has(imageId) || S.videoIds.has(imageId)) return;
    if (!confirm(t('videoConfirm', { n: S.settings.videoSeconds }))) return;
    const img = await getImage(imageId);
    if (!img) return;
    S.animating.add(imageId);
    refreshViews(char);
    refreshViewer(imageId);
    try {
      const op = await Api.videoStart(char, scene, img, S.settings);
      S.videoJobs[imageId] = { charId: char.id, model: S.settings.videoModel, op, at: Date.now() };
      await Store.set('videoJobs', S.videoJobs);
    } catch (e) {
      S.animating.delete(imageId);
      toast(t('videoFailed', { msg: e.message }), 'error');
      refreshViews(char);
      refreshViewer(imageId);
      return;
    }
    pollVideo(imageId);
  }

  // Asks every few seconds whether the video is ready. Also resumes after the app was closed.
  async function pollVideo(imageId) {
    const job = S.videoJobs[imageId];
    if (!job) return;
    S.animating.add(imageId);
    let error = null;
    try {
      for (;;) {
        if (Date.now() - job.at > VIDEO_TIMEOUT_MS) {
          error = t('errTimeout');
          break;
        }
        await sleep(VIDEO_POLL_MS);
        let r;
        try {
          r = await Api.videoPoll(job.model, job.op, S.settings);
        } catch (e) {
          if (e.kind === 'network') continue; // phone lost signal for a moment
          throw e;
        }
        if (!r.done) continue;
        if (r.error) {
          error = r.error;
          break;
        }
        await Store.set('vid:' + imageId, b64ToBlob(r.video.data, r.video.mimeType));
        S.videoIds.add(imageId);
        toast(t('videoDone'), 'good');
        break;
      }
    } catch (e) {
      error = e.message;
    }
    if (error) toast(t('videoFailed', { msg: error }), 'error');
    delete S.videoJobs[imageId];
    await Store.set('videoJobs', S.videoJobs);
    S.animating.delete(imageId);
    const char = findChar(job.charId);
    if (char) refreshViews(char);
    refreshViewer(imageId);
  }

  // ---------- Gallery ----------
  async function openGallery(id) {
    const char = findChar(id);
    if (!char) return goHome();
    S.char = char;
    S.chat = S.chats.get(id) || (await Store.get('chat:' + id)) || null;
    showScreen('gallery');
    $('#gallery').style.setProperty('--c', safeColor(char.color));
    renderGallery();
  }

  async function renderGallery() {
    const char = S.char;
    if (!char || S.view !== 'gallery') return;
    const g = await getGallery(char.id);
    const ms = milestonesOf(char);
    const unlockedCount = ms.filter((m) => g.unlocked[m.at]).length;
    $('#gallery-name').textContent = `${char.name} · ${t('gallery')}`;
    $('#gallery-count').textContent = t('galleryCount', { n: unlockedCount, total: ms.length });
    const portrait = S.portraits[char.id];

    const tiles = ms.map((m) => {
      const u = g.unlocked[m.at];
      const title = `<span class="tile-title">${esc(msTitle(m))}</span>`;
      if (u?.image) return `<div class="tile">${mediaBox(u.image, 'view-ms', `data-at="${m.at}"`)}${title}</div>`;
      if (u) {
        return S.drawing.has(msKey(char, m.at))
          ? `<div class="tile">${loadingBox(t('drawing'))}${title}</div>`
          : `<div class="tile"><button class="pic empty" data-act="draw-ms" data-at="${m.at}">🖼️<br>${esc(t('tapToDraw'))}</button>${title}</div>`;
      }
      const tier = Api.tierLabel(Api.tierIndex(m.at));
      return `<div class="tile locked"><div class="pic">${portrait ? `<img class="blur" src="${esc(portrait)}" alt="">` : ''}<span class="lock">🔒</span></div>
        ${title}<span class="tile-sub">${esc(t('lockedAt', { level: tier, n: m.at }))}</span></div>`;
    });

    const items = [...g.items].reverse();
    const story = items.length
      ? items.map((it) => `<div class="tile">${mediaBox(it.id, 'view-item', `data-id="${esc(it.id)}"`)}</div>`).join('')
      : `<p class="hint">${esc(t('noStory'))}</p>`;

    const body = $('#gallery-body');
    body.innerHTML = `<h3>${esc(t('milestones'))}</h3><div class="tiles">${tiles.join('')}</div>
      <h3>${esc(t('story'))}</h3><div class="tiles">${story}</div>`;
    hydrateMedia(body);
  }

  // Full-screen view of one picture or video
  async function openViewer(view) {
    S.viewer = view;
    const { imageId, caption, deletable } = view;
    const vurl = await getVideoUrl(imageId);
    const iurl = await getImage(imageId);
    let animateBtn = '';
    if (!vurl && iurl) {
      animateBtn = S.animating.has(imageId)
        ? `<span class="status">${esc(t('animating'))}</span>`
        : `<button type="button" data-act="animate-view">${esc(t('animate'))}</button>`;
    }
    openModal(
      `<div class="viewer-media" id="viewer-media"></div>
      ${caption ? `<p class="caption">${esc(caption)}</p>` : ''}
      <div class="actions">
        ${animateBtn}
        <a class="btn" id="viewer-download">${esc(t('download'))}</a>
        ${deletable ? `<button type="button" class="danger" data-act="remove-item">${esc(t('remove'))}</button>` : ''}
        <button type="button" data-act="close">${esc(t('close'))}</button>
      </div>`,
      null,
      'viewer',
    );
    const holder = $('#viewer-media');
    const dl = $('#viewer-download');
    if (vurl) {
      holder.replaceChildren(makeVideo(vurl, true));
      dl.href = vurl;
      dl.download = `${view.char.name}-${imageId}.mp4`;
    } else if (iurl) {
      const img = new Image();
      img.src = iurl;
      img.alt = '';
      holder.replaceChildren(img);
      dl.href = iurl;
      dl.download = `${view.char.name}-${imageId}.png`;
    }
  }

  function refreshViewer(imageId) {
    if (modal.open && modal.classList.contains('viewer') && S.viewer?.imageId === imageId) openViewer(S.viewer);
  }

  async function removeGalleryItem(view) {
    if (!confirm(t('removeConfirm'))) return;
    const { char, imageId } = view;
    const g = await getGallery(char.id);
    g.items = g.items.filter((it) => it.id !== imageId);
    await saveGallery(char.id, g);
    const chat = S.chats.get(char.id) || (await Store.get('chat:' + char.id));
    if (chat) {
      let changed = false;
      for (const m of chat.messages) if (imgIdOf(m) === imageId) (m.image = null), (changed = true);
      if (changed) await saveChat(char.id, chat);
    }
    await deleteMedia(imageId);
    closeModal();
    refreshViews(char);
  }

  // ---------- Pop-up windows ----------
  const modal = $('#modal');
  let onModalSubmit = null;

  function openModal(html, onSubmit = null, cls = '') {
    $('#modal-form').innerHTML = html;
    modal.className = cls;
    onModalSubmit = onSubmit;
    if (!modal.open) modal.showModal();
  }
  const closeModal = () => modal.open && modal.close();

  function openPassword(note = '') {
    openModal(
      `<h2>${esc(t('passwordTitle'))}</h2>
      ${note ? `<p class="note">${esc(note)}</p>` : ''}
      <label>${esc(t('passwordTitle'))}<input type="password" name="password" autocomplete="current-password" required></label>
      <p class="hint">${esc(t('passwordHint'))}</p>
      <div class="actions"><button type="button" data-act="close">${esc(t('cancel'))}</button><button type="submit" class="primary">${esc(t('save'))}</button></div>`,
      async (form) => {
        const pw = String(new FormData(form).get('password') || '');
        if (!pw) return false;
        try {
          await Api.ping(pw);
        } catch (e) {
          if (e.kind === 'auth') {
            toast(t('passwordWrong'), 'error');
            return false;
          }
          if (e.kind !== 'setup') {
            toast(e.message, 'error');
            return false;
          }
          toast(e.message, 'error'); // password is right but the server needs more setup
        }
        S.settings.password = pw;
        await saveSettings();
        checkServer();
      },
      'small',
    );
  }

  function selectHtml(name, value, opts) {
    const known = opts.some(([v]) => v === value);
    return `<select name="${name}">${opts
      .map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`)
      .join('')}${known ? '' : `<option value="${esc(value)}" selected>${esc(value)}</option>`}</select>`;
  }

  function openSettings() {
    const s = S.settings;
    openModal(
      `<h2>${esc(t('settings'))}</h2>
      <label>${esc(t('language'))}${selectHtml('language', s.language, I18N.LANGUAGES)}</label>
      <label>${esc(t('yourName'))}<input name="userName" value="${esc(s.userName)}" placeholder="${esc(t('yourNamePh'))}" maxlength="40"></label>
      <label>${esc(t('pictures'))}${selectHtml('pictureMode', s.pictureMode, [
        ['scene', t('picScene')],
        ['every', t('picEvery')],
        ['off', t('picOff')],
      ])}</label>
      <label>${esc(t('motion'))}${selectHtml('motion', s.motion, [
        ['on', t('motionOn')],
        ['off', t('motionOff')],
      ])}</label>
      <label>${esc(t('videoLength'))}${selectHtml('videoSeconds', s.videoSeconds, [
        ['4', t('seconds', { n: 4 })],
        ['6', t('seconds', { n: 6 })],
        ['8', t('seconds', { n: 8 })],
      ])}</label>
      <label>${esc(t('romance'))}${selectHtml('romance', s.romance, [
        ['mature', t('romMature')],
        ['flirty', t('romFlirty')],
        ['sweet', t('romSweet')],
      ])}</label>
      <label>${esc(t('safety'))}${selectHtml('safety', s.safety, [
        ['minimum', t('safMin')],
        ['relaxed', t('safRelaxed')],
        ['standard', t('safStandard')],
      ])}</label>
      <p class="hint">${esc(t('safetyHint'))}</p>
      <label>${esc(t('changePassword'))}<input type="password" name="password" value="${esc(s.password)}" autocomplete="current-password"></label>
      <div class="row"><button type="button" data-act="test">${esc(t('testConnection'))}</button><span id="test-result" class="hint"></span></div>
      <details>
        <summary>${esc(t('advanced'))}</summary>
        <label>${esc(t('textModel'))}${selectHtml('textModel', s.textModel, TEXT_MODELS)}</label>
        <input name="customText" placeholder="${esc(t('textModel'))} ID">
        <label>${esc(t('imageModel'))}${selectHtml('imageModel', s.imageModel, IMAGE_MODELS)}</label>
        <input name="customImage" placeholder="${esc(t('imageModel'))} ID">
        <label>${esc(t('videoModel'))}${selectHtml('videoModel', s.videoModel, VIDEO_MODELS)}</label>
        <input name="customVideo" placeholder="${esc(t('videoModel'))} ID">
      </details>
      <div class="actions">
        <button type="button" data-act="close">${esc(t('cancel'))}</button>
        <button type="submit" class="primary">${esc(t('save'))}</button>
      </div>`,
      async (form) => {
        const f = new FormData(form);
        const pick = (custom, sel) => String(f.get(custom) || '').trim() || String(f.get(sel));
        const langChanged = f.get('language') !== S.settings.language;
        S.settings = {
          ...S.settings,
          language: String(f.get('language')),
          userName: String(f.get('userName') || '').trim(),
          pictureMode: String(f.get('pictureMode')),
          motion: String(f.get('motion')),
          videoSeconds: String(f.get('videoSeconds')),
          romance: String(f.get('romance')),
          safety: String(f.get('safety')),
          password: String(f.get('password') || ''),
          textModel: pick('customText', 'textModel'),
          imageModel: pick('customImage', 'imageModel'),
          videoModel: pick('customVideo', 'videoModel'),
        };
        await saveSettings();
        if (langChanged) {
          I18N.set(S.settings.language);
          applyStaticText();
        }
        toast(t('settingsSaved'), 'good');
        checkServer();
        if (S.view === 'chat') renderChat();
        else if (S.view === 'gallery') renderGallery();
        else renderHome();
      },
    );
  }

  async function testConnection(form) {
    const f = new FormData(form);
    const out = $('#test-result');
    out.textContent = t('testing');
    try {
      const reply = await Api.test({
        ...S.settings,
        password: String(f.get('password') || ''),
        textModel: String(f.get('customText') || '').trim() || String(f.get('textModel')),
      });
      out.textContent = `${t('works')} ("${reply.slice(0, 20)}")`;
    } catch (e) {
      out.textContent = `✗ ${e.message}`;
    }
  }

  const CHAR_FIELDS = [
    ['name', 'input', 'Aria Blackwood'],
    ['age', 'number', ''],
    ['gender', 'input', 'female / male / non-binary'],
    ['genre', 'input', 'Fantasy / 奇幻'],
    ['tagline', 'input', ''],
    ['appearance', 'textarea', 'Hair, eyes, build, clothes, distinctive features…'],
    ['personality', 'textarea', ''],
    ['backstory', 'textarea', ''],
    ['speakingStyle', 'textarea', ''],
    ['scenario', 'textarea', ''],
    ['greeting', 'textarea', '*She looks up.* "Oh. It\'s you."'],
    ['artStyle', 'input', 'anime illustration / oil painting / semi-realistic'],
    ['startAffection', 'number', ''],
    ['color', 'color', ''],
  ];
  const REQUIRED = ['name', 'age', 'appearance', 'personality', 'scenario', 'greeting'];

  function openEditor(char = null) {
    const zhMode = I18N.lang === 'zh-HK';
    const c = char || {
      age: 25,
      startAffection: 20,
      color: '#8b5cf6',
      artStyle: 'detailed anime-style digital illustration, soft cinematic lighting',
    };
    const valueOf = (key) => (zhMode && LOCALIZED.includes(key) && c.zh?.[key]) || c[key] || '';
    const fields = CHAR_FIELDS.map(([key, type, ph]) => {
      const label = esc(t('f_' + key));
      const v = esc(valueOf(key));
      const req = REQUIRED.includes(key) ? 'required' : '';
      if (type === 'textarea') return `<label>${label}<textarea name="${key}" rows="3" placeholder="${esc(ph)}" ${req}>${v}</textarea></label>`;
      if (type === 'number') {
        const range = key === 'age' ? 'min="18" max="10000"' : 'min="0" max="100"';
        return `<label>${label}<input type="number" name="${key}" value="${v}" ${range} ${req}></label>`;
      }
      if (type === 'color') return `<label>${label}<input type="color" name="${key}" value="${esc(safeColor(c[key]))}"></label>`;
      return `<label>${label}<input name="${key}" value="${v}" placeholder="${esc(ph)}" ${req}></label>`;
    }).join('');

    const extra = !char
      ? ''
      : char.starter
        ? char.edited
          ? `<button type="button" class="danger" data-act="restore-char">${esc(t('restoreOriginal'))}</button>`
          : ''
        : `<button type="button" class="danger" data-act="delete-char">${esc(t('deleteCharacter'))}</button>`;

    openModal(
      `<h2>${esc(t(char ? 'editTitle' : 'createTitle'))}</h2>
      <p class="hint">${esc(t('editHint'))}</p>
      ${fields}
      <div class="actions">${extra}<span class="spacer"></span>
        <button type="button" data-act="close">${esc(t('cancel'))}</button>
        <button type="submit" class="primary">${esc(t('save'))}</button>
      </div>`,
      async (form) => {
        const f = new FormData(form);
        const data = {};
        for (const [key] of CHAR_FIELDS) data[key] = String(f.get(key) ?? '').trim();
        for (const key of REQUIRED) {
          if (!data[key]) {
            toast(`${t('f_' + key)} ?`, 'error');
            return false;
          }
        }
        data.age = Math.round(Number(data.age));
        if (!Number.isFinite(data.age) || data.age < 18) {
          toast(t('mustBeAdult'), 'error');
          return false;
        }
        data.startAffection = clamp(Math.round(Number(data.startAffection) || 0), 0, 100);
        data.color = safeColor(data.color);

        const id = char ? char.id : 'c_' + uid();
        const prev = S.custom[id] || {};
        const entry = { ...prev, ...data, id };
        if (zhMode) {
          // Cantonese text goes into the "zh" part; keep the English version for English mode.
          entry.zh = { ...(prev.zh || {}) };
          for (const key of LOCALIZED) {
            entry.zh[key] = data[key];
            entry[key] = char ? prev[key] ?? char[key] : data[key];
          }
        }
        const looksChanged = char && (char.appearance !== data.appearance || char.artStyle !== data.artStyle);
        S.custom[id] = entry;
        await saveCustom();
        if (looksChanged) {
          delete S.portraits[id];
          await Store.del('portrait:' + id);
        }
        rebuildCharacters();
        toast(t(char ? 'charUpdated' : 'charCreated'), 'good');
        if (!char) goChat(id);
        else refreshViews(S.char);
      },
    );
  }

  async function deleteCharacter(char) {
    if (!confirm(t('deleteConfirm', { name: char.name }))) return;
    const id = char.id;
    const chat = S.chats.get(id) || (await Store.get('chat:' + id));
    const g = await getGallery(id);
    const ids = new Set([...g.items.map((it) => it.id), ...Object.values(g.unlocked).map((u) => u.image)]);
    for (const m of chat?.messages || []) ids.add(imgIdOf(m));
    for (const imageId of ids) await deleteMedia(imageId);
    await Promise.all([Store.del('chat:' + id), Store.del('portrait:' + id), Store.del('gallery:' + id)]);
    S.chats.delete(id);
    S.galleries.delete(id);
    delete S.portraits[id];
    delete S.progress[id];
    await Store.set('progress', S.progress);
    delete S.custom[id];
    await saveCustom();
    rebuildCharacters();
    closeModal();
    goHome();
  }

  async function restoreCharacter(char) {
    if (!confirm(t('restoreConfirm'))) return;
    delete S.custom[char.id];
    await saveCustom();
    delete S.portraits[char.id];
    await Store.del('portrait:' + char.id);
    rebuildCharacters();
    closeModal();
    refreshViews(S.char);
  }

  function openMenu() {
    const { char } = S;
    openModal(
      `<h2>${esc(char.name)}</h2>
      <div class="menu">
        <button type="button" data-act="gallery">${esc(t('menuGallery'))}</button>
        <button type="button" data-act="memories">${esc(t('menuMemories', { name: firstName(char) }))}</button>
        <button type="button" data-act="new-portrait">${esc(t('menuPortrait'))}</button>
        <button type="button" data-act="edit-char">${esc(t('menuEdit'))}</button>
        <button type="button" data-act="restart" class="danger">${esc(t('menuRestart'))}</button>
        <button type="button" data-act="close">${esc(t('close'))}</button>
      </div>`,
      null,
      'small',
    );
  }

  function openMemories() {
    const { char, chat } = S;
    openModal(
      `<h2>${esc(t('memoriesTitle', { name: firstName(char) }))}</h2>
      <p class="hint">${esc(t('memoriesHint'))}</p>
      <textarea name="memories" rows="12">${esc(chat.memories.join('\n'))}</textarea>
      <div class="actions"><button type="button" data-act="close">${esc(t('cancel'))}</button><button type="submit" class="primary">${esc(t('save'))}</button></div>`,
      async (form) => {
        chat.memories = String(new FormData(form).get('memories') || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(-MAX_MEMORIES);
        await saveChat(char.id, chat);
        toast(t('memoriesSaved'), 'good');
      },
    );
  }

  async function restartStory() {
    const { char } = S;
    if (!confirm(t('restartConfirm', { name: char.name }))) return;
    closeModal();
    // Pictures that are in the gallery are kept; anything else from the old chat is removed.
    const g = await getGallery(char.id);
    const keep = new Set(g.items.map((it) => it.id));
    for (const m of S.chat.messages) {
      const id = imgIdOf(m);
      if (id && !keep.has(id)) await deleteMedia(id);
    }
    const chat = newChat(char);
    S.chats.set(char.id, chat);
    S.chat = chat;
    await saveChat(char.id, chat);
    renderChat(true);
    if (picturesOn() && S.settings.password) drawScene(char, chat, chat.messages[0]);
  }

  // ---------- Wiring up buttons ----------
  function autosize() {
    const el = $('#input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  function bindEvents() {
    window.addEventListener('hashchange', route);
    $('#btn-settings').addEventListener('click', openSettings);
    $('#key-banner').addEventListener('click', (e) => e.target.closest('[data-act=password]') && openPassword());
    $('#btn-back').addEventListener('click', goHome);
    $('#btn-gallery').addEventListener('click', () => S.char && goGallery(S.char.id));
    $('#btn-gallery-back').addEventListener('click', () => S.char && goChat(S.char.id));
    $('#btn-menu').addEventListener('click', openMenu);

    $('#char-grid').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      if (card.dataset.act === 'new-char') openEditor();
      else goChat(card.dataset.id);
    });

    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      send($('#input').value);
    });
    $('#input').addEventListener('input', autosize);
    $('#input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(hover: hover)').matches) {
        e.preventDefault();
        send($('#input').value);
      }
    });

    $('#suggestions').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && S.chat) send(S.chat.suggestions[Number(b.dataset.i)]);
    });

    $('#messages').addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el || !S.chat) return;
      const { char, chat } = S;
      const m = chat.messages.find((x) => x.id === (el.dataset.id || el.dataset.msg));
      const act = el.dataset.act;
      if (act === 'draw' && m) drawScene(char, chat, m);
      else if (act === 'animate' && m) animate(imgIdOf(m), char, m.scene);
      else if (act === 'reroll') reroll(el.dataset.id);
      else if (act === 'retry') retry(el.dataset.id);
      else if (act === 'view' && m) openViewer({ char, imageId: imgIdOf(m), caption: '', scene: m.scene, deletable: false });
    });

    $('#gallery-body').addEventListener('click', async (e) => {
      const el = e.target.closest('[data-act]');
      if (!el || !S.char) return;
      const char = S.char;
      const g = await getGallery(char.id);
      const m = milestonesOf(char).find((x) => String(x.at) === el.dataset.at);
      if (el.dataset.act === 'draw-ms' && m) drawMilestone(char, m);
      else if (el.dataset.act === 'view-ms' && m) {
        openViewer({ char, imageId: g.unlocked[m.at].image, caption: msTitle(m), scene: m.scene, deletable: false });
      } else if (el.dataset.act === 'view-item') {
        const it = g.items.find((x) => x.id === el.dataset.id);
        if (it) openViewer({ char, imageId: it.id, caption: it.caption, scene: it.scene, deletable: true });
      }
    });

    // Pop-up buttons
    modal.addEventListener('click', (e) => {
      if (e.target === modal) return closeModal(); // tapped outside the box
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      if (act === 'close') closeModal();
      else if (act === 'test') testConnection($('#modal-form'));
      else if (act === 'gallery') {
        closeModal();
        goGallery(S.char.id);
      }
      else if (act === 'memories') openMemories();
      else if (act === 'edit-char') openEditor(S.char);
      else if (act === 'restart') restartStory();
      else if (act === 'delete-char') deleteCharacter(S.char);
      else if (act === 'restore-char') restoreCharacter(S.char);
      else if (act === 'animate-view' && S.viewer) animate(S.viewer.imageId, S.viewer.char, S.viewer.scene);
      else if (act === 'remove-item' && S.viewer) removeGalleryItem(S.viewer);
      else if (act === 'new-portrait') {
        closeModal();
        if (!S.settings.password) return openPassword();
        toast(t('newPortrait'));
        ensurePortrait(S.char, true);
      }
    });
    modal.addEventListener('close', () => {
      modal.querySelectorAll('video').forEach((v) => v.pause());
      S.viewer = null;
    });
    $('#modal-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onModalSubmit) return closeModal();
      const ok = await onModalSubmit(e.target);
      if (ok !== false) closeModal();
    });
  }

  // ---------- Start ----------
  (async () => {
    await loadAll();
    applyStaticText();
    bindEvents();
    route();
    checkServer();
    for (const id of Object.keys(S.videoJobs)) pollVideo(id); // finish videos started before the app was closed
  })();
})();
