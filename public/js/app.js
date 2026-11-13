// The app itself: screens, buttons, sending messages, affection, pictures, videos and the gallery.
//
// Every story has a "cast" of one or more women. Each woman has her own affection,
// portrait and special scenes. Older one-woman characters are turned into stories
// with a cast of one (see toStory).
(() => {
  'use strict';
  const t = (...a) => I18N.t(...a);

  // ---------- Defaults you can change in Settings (kept on each device) ----------
  const DEFAULT_SETTINGS = {
    password: '',
    language: I18N.guess(),
    userName: '',
    userGender: 'man',
    pictureStyle: 'photo', // 'photo' | 'painting' | 'anime' | 'character'
    textModel: 'gemini-3.8-flash',
    imageModel: 'gemini-nano-banana-2.1',
    imageProvider: 'google', // 'google' | 'fal' (open-source models)
    falModel: 'dreamshaper', // 'dreamshaper' | 'animagine' | 'realvis' | 'custom'
    falCustomModel: '',
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
    ['veo-3.1-lite-generate-001', 'Veo 3.1 Lite'],
  ];
  const MAX_MEMORIES = 40;
  const PICTURE_GAP = 3; // in "scene" mode, draw at least every N replies even if the AI doesn't ask for one
  const MOMENT_GAP = 4; // at least N replies between two key moments
  const VIDEO_POLL_MS = 8000;
  const VIDEO_TIMEOUT_MS = 15 * 60 * 1000;
  const LOCALIZED = ['genre', 'tagline', 'speakingStyle', 'scenario', 'greeting']; // fields with a Cantonese version

  // ---------- State ----------
  const S = {
    settings: { ...DEFAULT_SETTINGS },
    ready: false, // connected to cloud storage
    index: emptyIndex(), // small summary saved in the cloud (affection, unlocks, portraits, videos)
    custom: {}, // characters you created or edited
    stories: [],
    portraits: {}, // woman id -> picture (data URL)
    chats: new Map(), // story id -> chat
    galleries: new Map(), // story id -> gallery
    images: new Map(), // picture id -> data URL
    videoUrls: new Map(), // picture id -> playable video URL
    videoJobs: {}, // picture id -> video being made
    view: 'home',
    story: null,
    chat: null,
    viewer: null, // what the picture viewer is showing
    banner: null, // home screen notice
    busy: new Set(), // story ids waiting for a reply
    drawing: new Set(), // things being drawn
    animating: new Set(), // pictures being turned into videos
    portraitJobs: new Map(),
    saveWarned: false,
  };

  function emptyIndex() {
    return { v: 3, progress: {}, unlocks: {}, portraits: {}, portraitStyles: {}, videos: {} };
  }

  // ---------- Small helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#8b5cf6');
  const loc = Api.loc;
  const plain = (text) => String(text || '').replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
  const imgIdOf = (m) => (m.image === true ? m.id : m.image || null); // older saves used `true`
  const zh = () => I18N.lang === 'zh-HK';

  // Story & cast helpers
  const isMulti = (story) => story.cast.length > 1;
  const girlById = (story, id) => story.cast.find((g) => g.id === id) || null;
  const titleOf = (story) => Api.storyTitle(story);
  const shortName = (g) => (zh() && g.zh?.name) || g.name.replace(/^(Captain|Lord|Lady|Dr\.?|Sir|Princess)\s+/i, '').split(' ')[0];
  const girlColor = (story, g) => safeColor(g.color || story.color);

  // Turns *actions* into italics and keeps everything else as plain text (safe from code injection).
  function inlineFormat(text) {
    return esc(text)
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+?)\*/g, '<em class="act">$1</em>');
  }
  function formatText(text) {
    return inlineFormat(text)
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }
  // A reply made of lines: narration, someone speaking, or someone's private thought.
  function renderLines(story, lines) {
    const sep = zh() ? '：' : ': ';
    return lines
      .map((l) => {
        const g = girlById(story, l.who);
        if (!g || l.kind === 'act') return `<p class="line act">${inlineFormat(l.text)}</p>`;
        const who = `<b class="who" style="color:${girlColor(story, g)}">${esc(shortName(g))}</b>${sep}`;
        if (l.kind === 'think') return `<p class="line think">${who}💭 ${esc(zh() ? `『${l.text}』` : `(${l.text})`)}</p>`;
        return `<p class="line say">${who}${esc(zh() ? `「${l.text}」` : `“${l.text}”`)}</p>`;
      })
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

  // =====================================================================================
  // Saving & loading
  //
  // Everything is saved in your Cloudflare R2 storage (the master copy, shared by all
  // devices) and also kept on this device (faster, and a backup if the upload fails).
  // =====================================================================================
  Store.cloud.password = () => S.settings.password;

  // Upload to the cloud; if that fails, remember it and try again later.
  async function cloudPut(key, value) {
    try {
      await Store.cloud.put(key, value);
    } catch (e) {
      const pending = new Set(await Store.get('pending', []));
      pending.add(key);
      await Store.set('pending', [...pending]);
      if (!S.saveWarned) {
        S.saveWarned = true;
        toast(t('errSave', { msg: e.message }), 'error');
      }
    }
  }

  async function flushPending() {
    const pending = await Store.get('pending', []);
    if (!pending.length) return;
    const left = [];
    for (const key of pending) {
      const value = await Store.get(key);
      if (value == null) continue;
      try {
        await Store.cloud.put(key, value);
      } catch {
        left.push(key);
      }
    }
    await Store.set('pending', left);
    if (!left.length) S.saveWarned = false;
  }

  // Small documents (chats, galleries…): read from the cloud, fall back to this device.
  async function getDoc(key, fallback) {
    try {
      const value = await Store.cloud.getJSON(key);
      if (value !== null) {
        Store.set(key, value);
        return value;
      }
    } catch {}
    return (await Store.get(key)) ?? fallback;
  }

  // Writes for the same document happen one after another, newest last.
  const writeQueues = new Map();
  function putDoc(key, value) {
    const snapshot = JSON.parse(JSON.stringify(value));
    const prev = writeQueues.get(key) || Promise.resolve();
    const next = prev.then(async () => {
      await Store.set(key, snapshot);
      await cloudPut(key, snapshot);
    });
    writeQueues.set(key, next.catch(() => {}));
    return next;
  }
  async function delDoc(key) {
    await Store.del(key);
    await Store.cloud.del(key).catch(() => {});
  }

  const saveIndex = () => putDoc('index', S.index);
  const saveCustom = () => putDoc('custom', S.custom);
  const saveJobs = () => putDoc('jobs', S.videoJobs);
  const saveSettings = () => Store.set('settings', S.settings); // settings stay on this device

  // ---- Relationship points: 7 levels of 100 points each ----
  // Older saves used one 0-100 bar; those numbers are scaled up once so progress is kept.
  const OLD_SCALE = Api.MAX_POINTS / 100;
  const startPoints = (g) => clamp(Math.round((Number(g.startAffection) || 15) * 3), 0, Api.POINTS_PER_LEVEL - 1);
  const atPoints = (m) => Math.round((m.at / 100) * Api.MAX_POINTS); // when a special scene unlocks
  const levelText = (points) => {
    const L = Api.levelOf(points);
    return t('levelShort', { lv: L.lv, level: Api.levelName(L.i) });
  };

  // Points per woman, as saved in the summary.
  function progressOf(story) {
    const p = S.index.progress[story.id];
    if (p == null) return null;
    if (typeof p === 'number') return { [story.cast[0].id]: Math.round(p * OLD_SCALE) };
    if (!p.$lv) return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Math.round(v * OLD_SCALE)]));
    const { $lv, ...points } = p;
    return points;
  }

  async function saveChat(story, chat) {
    S.index.progress[story.id] = { ...chat.aff, $lv: 1 };
    await Promise.all([putDoc('chat:' + story.id, chat), saveIndex()]);
  }

  // Bring older saves up to date: one number -> one per woman; 0-100 bar -> level points.
  function normalizeChat(story, chat) {
    if (!chat.aff) {
      const g0 = story.cast[0];
      chat.aff = typeof chat.affection === 'number' ? { [g0.id]: chat.affection } : {};
      chat.moods = { [g0.id]: chat.mood || '' };
      delete chat.affection;
      delete chat.mood;
    }
    if (!chat.lv) {
      for (const k of Object.keys(chat.aff)) chat.aff[k] = Math.round(chat.aff[k] * OLD_SCALE);
      chat.lv = 1;
    }
    chat.moods = chat.moods || {};
    for (const g of story.cast) {
      if (typeof chat.aff[g.id] !== 'number') chat.aff[g.id] = startPoints(g);
    }
    chat.state = chat.state || { location: '', outfits: {} };
    chat.state.outfits = chat.state.outfits || {};
    chat.memories = chat.memories || [];
    chat.suggestions = chat.suggestions || [];
    return chat;
  }

  async function loadChat(story) {
    if (S.chats.has(story.id)) return S.chats.get(story.id);
    const chat = await getDoc('chat:' + story.id, null);
    if (chat) S.chats.set(story.id, normalizeChat(story, chat));
    return S.chats.get(story.id) || null;
  }

  const normalizeGallery = (g) => ({ items: g?.items || [], unlocked: g?.unlocked || {}, moments: g?.moments || [] });
  async function getGallery(id) {
    if (!S.galleries.has(id)) S.galleries.set(id, normalizeGallery(await getDoc('gallery:' + id, null)));
    return S.galleries.get(id);
  }
  async function saveGallery(story, g) {
    S.index.unlocks[story.id] = allMilestones(story).filter((x) => g.unlocked[x.key]).length;
    await Promise.all([putDoc('gallery:' + story.id, g), saveIndex()]);
  }

  // Pictures and videos never change once made, so this device's copy is used first.
  async function getImage(id) {
    if (!id) return null;
    if (S.images.has(id)) return S.images.get(id);
    let url = await Store.get('img:' + id);
    if (!url) {
      url = await Store.cloud.getText('img:' + id).catch(() => null);
      if (url) Store.set('img:' + id, url);
    }
    if (url) S.images.set(id, url);
    return url || null;
  }
  async function putImage(id, url) {
    S.images.set(id, url);
    await Store.set('img:' + id, url);
    await cloudPut('img:' + id, url);
  }
  const hasVideo = (id) => Boolean(id && S.index.videos[id]);
  async function getVideoUrl(id) {
    if (!hasVideo(id)) return null;
    if (!S.videoUrls.has(id)) {
      let blob = await Store.get('vid:' + id);
      if (!blob) {
        blob = await Store.cloud.getBlob('vid:' + id).catch(() => null);
        if (blob) Store.set('vid:' + id, blob);
      }
      if (!blob) return null;
      S.videoUrls.set(id, URL.createObjectURL(blob));
    }
    return S.videoUrls.get(id);
  }
  async function putVideo(id, blob) {
    await Store.set('vid:' + id, blob);
    await cloudPut('vid:' + id, blob);
    S.index.videos[id] = 1;
    await saveIndex();
  }
  async function deleteMedia(id) {
    if (!id) return;
    for (const key of ['img:' + id, 'vid:' + id]) {
      await Store.del(key);
      await Store.cloud.del(key).catch(() => {});
    }
    S.images.delete(id);
    if (S.videoUrls.has(id)) URL.revokeObjectURL(S.videoUrls.get(id));
    S.videoUrls.delete(id);
    if (S.index.videos[id]) {
      delete S.index.videos[id];
      await saveIndex();
    }
  }

  // Connect to the cloud storage and load the summary. Runs at start and after the password changes.
  async function initCloud() {
    S.ready = false;
    if (!S.settings.password) {
      S.banner = { html: t('welcome'), button: true };
      refreshHome();
      return false;
    }
    try {
      const info = await Api.ping(S.settings.password);
      if (!info.storage) throw new Error('Cloud storage is not set up on the server (R2 bucket "kindred-data", see README).');
    } catch (e) {
      S.banner = e.kind === 'auth' ? { html: esc(t('passwordWrong')), button: true } : { html: esc(e.message), button: false };
      refreshHome();
      return false;
    }
    try {
      S.index = await loadIndexOrMigrate();
      S.custom = await getDoc('custom', {});
      rebuildStories();
      S.videoJobs = await getDoc('jobs', {});
      S.galleries.clear();
      S.chats.clear();
      await Promise.all(
        S.stories.flatMap((s) =>
          s.cast.map(async (g) => {
            const pid = S.index.portraits[g.id];
            const url = pid && (await getImage(pid));
            if (url) S.portraits[g.id] = url;
          }),
        ),
      );
      S.banner = null;
      S.ready = true;
      flushPending();
      for (const id of Object.keys(S.videoJobs)) pollVideo(id); // finish videos started earlier
    } catch (e) {
      S.banner = { html: esc(e.message), button: false };
    }
    refreshHome();
    return S.ready;
  }

  async function loadIndexOrMigrate() {
    const existing = await Store.cloud.getJSON('index');
    if (existing) {
      Store.set('index', existing);
      const merged = { ...emptyIndex(), ...existing };
      merged.portraitStyles = merged.portraitStyles || {};
      return merged;
    }
    // First time with cloud storage: move anything saved on this device by the earlier version.
    const index = emptyIndex();
    const oldChats = await Store.keys('chat:');
    if ((await Store.get('progress')) || oldChats.length) {
      toast(t('migrating'));
      S.custom = await Store.get('characters:custom', {});
      await putDoc('custom', S.custom);
      rebuildStories();
      for (const key of await Store.keys('img:')) await cloudPut(key, await Store.get(key));
      for (const key of await Store.keys('vid:')) {
        const blob = await Store.get(key);
        if (blob) {
          await cloudPut(key, blob);
          index.videos[key.slice(4)] = 1;
        }
      }
      for (const s of S.stories) {
        const chat = await Store.get('chat:' + s.id);
        if (chat) {
          normalizeChat(s, chat);
          await putDoc('chat:' + s.id, chat);
          index.progress[s.id] = { ...chat.aff, $lv: 1 };
        }
        const g = await Store.get('gallery:' + s.id);
        if (g) {
          const ng = normalizeGallery(g);
          await putDoc('gallery:' + s.id, ng);
          index.unlocks[s.id] = Object.keys(ng.unlocked).length;
        }
        const portrait = await Store.get('portrait:' + s.id);
        if (portrait) {
          const pid = uid();
          await putImage(pid, portrait);
          index.portraits[s.cast[0].id] = pid;
        }
      }
      const jobs = await Store.get('videoJobs');
      if (jobs) await putDoc('jobs', jobs);
      for (const key of ['progress', 'characters:custom', 'videoJobs', ...(await Store.keys('portrait:'))]) await Store.del(key);
      toast(t('migrated'), 'good');
    }
    await putDoc('index', index);
    return index;
  }

  // One-woman characters (the older format, and the ones you create) become stories with a cast of one.
  function toStory(c) {
    if (c.cast?.length) return c;
    return {
      ...c,
      cast: [
        {
          id: c.id,
          name: c.name,
          age: c.age,
          gender: c.gender,
          appearance: c.appearance,
          personality: c.personality,
          backstory: c.backstory,
          speakingStyle: c.speakingStyle,
          startAffection: c.startAffection,
          milestones: c.milestones,
          color: c.color,
          zh: { name: c.zh?.name, speakingStyle: c.zh?.speakingStyle },
        },
      ],
    };
  }

  function rebuildStories() {
    const builtIn = [...MULTI_STORIES, ...STARTER_CHARACTERS];
    const builtInIds = new Set(builtIn.map((c) => c.id));
    const starters = builtIn.map((c) => {
      const o = !c.cast && S.custom[c.id];
      return toStory(o ? { ...c, ...o, zh: { ...(c.zh || {}), ...(o.zh || {}) }, starter: true, edited: true } : { ...c, starter: true });
    });
    const mine = Object.values(S.custom)
      .filter((c) => !builtInIds.has(c.id))
      .map(toStory);
    S.stories = [...mine, ...starters];
    if (S.story) S.story = S.stories.find((s) => s.id === S.story.id) || null;
  }

  const findStory = (id) => S.stories.find((s) => s.id === id);

  function newChat(story) {
    const aff = {};
    const moods = {};
    for (const g of story.cast) {
      aff[g.id] = startPoints(g);
      moods[g.id] = '';
    }
    const greeting = loc(story, 'greeting');
    let first;
    if (Array.isArray(greeting)) {
      const lines = greeting.map((l) => ({ ...l }));
      const inPicture = [...new Set(lines.map((l) => l.who).filter((w) => girlById(story, w)))].slice(0, 3);
      first = { id: uid(), role: 'char', lines, text: Api.transcript(story, lines), scene: story.scenario, inPicture };
    } else {
      first = { id: uid(), role: 'char', text: greeting, scene: story.scenario, inPicture: [story.cast[0].id] };
    }
    return { lv: 1, aff, moods, state: { location: '', outfits: {} }, memories: [], suggestions: [], messages: [first] };
  }

  // Special scenes per woman. Keys stay as plain numbers for one-woman stories (older saves).
  function milestonesOf(story, girl) {
    const list = girl.milestones?.length ? girl.milestones : isMulti(story) ? DEFAULT_MILESTONES_MULTI : DEFAULT_MILESTONES;
    return list.map((m) => ({ ...m, scene: m.scene.replace(/\{name\}/g, girl.name) }));
  }
  const msKeyOf = (story, girl, at) => (isMulti(story) ? `${girl.id}:${at}` : String(at));
  const allMilestones = (story) => story.cast.flatMap((g) => milestonesOf(story, g).map((m) => ({ girl: g, m, key: msKeyOf(story, g, m.at) })));
  const msTitle = (m) => (zh() && m.zh) || m.title;
  const msDrawKey = (story, key) => `ms:${story.id}:${key}`;

  const isCurrent = (story, chat) => S.story && S.story.id === story.id && S.chat === chat;
  const picturesOn = () => S.settings.pictureMode !== 'off';
  const styleOf = (story) => Api.styleFor(story, S.settings);
  // The portrait is the reference for every picture, so it must match the current style and her current description.
  const hashText = (text) => {
    let h = 5381;
    for (const ch of String(text || '')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
    return h.toString(36);
  };
  const portraitKey = (story, girl) => `${styleOf(story).key}|${hashText(girl.appearance)}`;
  const portraitOk = (story, girl) => Boolean(S.portraits[girl.id]) && S.index.portraitStyles[girl.id] === portraitKey(story, girl);

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

  function refreshHome() {
    if (S.view === 'home') renderHome();
  }

  function refreshViews(story) {
    if (S.view === 'home') renderHome();
    else if (S.story && story && S.story.id === story.id) {
      if (S.view === 'chat') renderChat();
      if (S.view === 'gallery') renderGallery();
    }
  }

  // Not connected to storage yet: go back home and explain.
  function needReady() {
    if (S.ready) return true;
    goHome();
    if (!S.settings.password) openPassword();
    else if (S.banner) toast(plain(S.banner.html.replace(/<[^>]+>/g, '')), 'error');
    else toast(t('notReady'));
    return false;
  }

  // Words that are written directly in index.html
  function applyStaticText() {
    document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  }

  // ---------- Home screen ----------
  function showHome() {
    S.story = null;
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

    const cards = S.stories.map((s) => {
      const covers = s.cast.map((g) => S.portraits[g.id]).filter(Boolean).slice(0, 3);
      const cover = covers.length
        ? `<span class="cover n${covers.length}">${covers.map((p) => `<img src="${esc(p)}" alt="">`).join('')}</span>`
        : `<span class="initial">${esc(titleOf(s).trim()[0] || '?')}</span>`;
      const prog = progressOf(s);
      const unlocked = S.index.unlocks[s.id] || 0;
      let progressHtml = '';
      if (prog) {
        const levels = s.cast.map((g) => Api.levelOf(prog[g.id] ?? 0));
        const avg = Math.round(levels.reduce((a, L) => a + L.into, 0) / levels.length);
        const label = isMulti(s) ? s.cast.map((g, i) => `${shortName(g)} Lv${levels[i].lv}`).join(' · ') : levelText(prog[s.cast[0].id] ?? 0);
        progressHtml = `<span class="mini-bar"><span style="width:${avg}%"></span></span>
          <span class="mini-label">♥ ${esc(label)}${unlocked ? ` · 🔓 ${unlocked}/${allMilestones(s).length}` : ''}</span>`;
      }
      return `<button class="card" data-id="${esc(s.id)}" style="--c:${safeColor(s.color)}">
        ${cover}
        ${isMulti(s) ? `<span class="cast-badge">👥 ${s.cast.length}</span>` : ''}
        <span class="card-info">
          <span class="genre">${esc(loc(s, 'genre') || 'Story')}</span>
          <strong>${esc(titleOf(s))}</strong>
          <span class="tag">${esc(loc(s, 'tagline') || '')}</span>
          ${progressHtml}
        </span>
      </button>`;
    });
    cards.push(`<button class="card add" data-act="new-char">
        <span class="plus">+</span>
        <span class="card-info"><strong>${esc(t('createCharacter'))}</strong><span class="tag">${esc(t('createCharacterSub'))}</span></span>
      </button>`);
    $('#char-grid').innerHTML = cards.join('');
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
    const story = findStory(id);
    if (!story) return goHome();
    if (!needReady()) return;
    let chat = await loadChat(story);
    const fresh = !chat;
    if (fresh) {
      chat = newChat(story);
      S.chats.set(story.id, chat);
      await saveChat(story, chat);
    }
    S.story = story;
    S.chat = chat;
    showScreen('chat');
    $('#chat').style.setProperty('--c', safeColor(story.color));
    renderChat(true);
    if (picturesOn()) {
      if (fresh) drawScene(story, chat, chat.messages[0]);
      for (const g of story.cast) if (!portraitOk(story, g)) ensurePortrait(story, g);
    }
    checkMilestones(story, chat);
  }

  function renderChatHeader() {
    const { story, chat } = S;
    if (!story || !chat) return;
    const multi = isMulti(story);
    $('#chat-name').textContent = titleOf(story);
    const g0 = story.cast[0];
    $('#chat-mood').textContent = !multi && chat.moods[g0.id] ? t('feeling', { mood: chat.moods[g0.id] }) : loc(story, 'genre') || '';

    const av = $('#chat-avatar');
    const pics = story.cast.map((g) => S.portraits[g.id]);
    av.classList.toggle('stack', multi);
    av.innerHTML = multi
      ? story.cast.map((g, i) => (pics[i] ? `<img src="${esc(pics[i])}" alt="">` : `<span style="background:${girlColor(story, g)}">${esc(shortName(g)[0])}</span>`)).join('')
      : pics[0]
        ? `<img src="${esc(pics[0])}" alt="">`
        : esc(titleOf(story).trim()[0] || '?');
    av.classList.toggle('loading', story.cast.some((g) => S.portraitJobs.has(g.id)));

    $('#affection').innerHTML = story.cast
      .map((g) => {
        const L = Api.levelOf(chat.aff[g.id]);
        const maxed = L.lv === Api.LEVELS.length && L.into >= Api.POINTS_PER_LEVEL;
        const num = maxed ? 'MAX' : `${L.into}/${Api.POINTS_PER_LEVEL}`;
        return `<div class="aff-row" data-girl="${esc(g.id)}" style="--gc:${girlColor(story, g)}">
          ${multi ? `<span class="aff-who">${esc(shortName(g))}</span>` : '<span class="heart">♥</span>'}
          <div class="bar"><div class="fill" style="width:${L.into}%"></div></div>
          <span class="aff-label">${esc(levelText(chat.aff[g.id]))}</span>
          <span class="aff-num">${esc(num)}</span>
        </div>`;
      })
      .join('');
    $('#affection').classList.toggle('multi', multi);
  }

  function renderMessage(story, m, canReroll) {
    if (m.role === 'system') {
      return `<div class="msg system"><span>${esc(m.text)}</span>${
        m.retry ? ` <button class="link" data-act="retry" data-id="${m.id}">${esc(t('tryAgain'))}</button>` : ''
      }</div>`;
    }
    if (m.role === 'user') return `<div class="msg user"><div class="bubble">${formatText(m.text)}</div></div>`;

    const imageId = imgIdOf(m);
    const drawing = S.drawing.has(m.id);
    const badge = m.momentTitle ? `<div class="moment-badge">✨ ${esc(m.momentTitle)}</div>` : '';
    const pic = imageId ? mediaBox(imageId, 'view', `data-msg="${m.id}"`) : drawing ? loadingBox(t('drawing')) : '';
    const tools = [];
    const deltas = m.deltas || (m.delta ? { [story.cast[0].id]: { d: m.delta, reason: m.reason } } : {});
    for (const [gid, v] of Object.entries(deltas)) {
      if (!v.d) continue;
      const g = girlById(story, gid);
      tools.push(
        `<span class="delta ${v.d > 0 ? 'up' : 'down'}">${v.d > 0 ? '+' : ''}${v.d} ♥${isMulti(story) && g ? ` ${esc(shortName(g))}` : ''}${
          v.reason ? ` <span class="why">${esc(v.reason)}</span>` : ''
        }</span>`,
      );
    }
    if (!imageId && !drawing) tools.push(`<button data-act="draw" data-id="${m.id}">${esc(t('picture'))}</button>`);
    if (imageId && !hasVideo(imageId)) {
      tools.push(
        S.animating.has(imageId)
          ? `<span class="status">${esc(t('animating'))}</span>`
          : `<button data-act="animate" data-id="${m.id}">${esc(t('animate'))}</button>`,
      );
    }
    if (canReroll) tools.push(`<button data-act="reroll" data-id="${m.id}">${esc(t('anotherReply'))}</button>`);
    const body = m.lines?.length ? renderLines(story, m.lines) : formatText(m.text);
    return `<div class="msg char">${badge}${pic}<div class="bubble">${body}</div><div class="tools">${tools.join('')}</div></div>`;
  }

  function renderChat(forceScroll = false) {
    const { story, chat } = S;
    if (!story || !chat || S.view !== 'chat') return;
    renderChatHeader();
    const box = $('#messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    const busy = S.busy.has(story.id);
    let lastChar = -1;
    chat.messages.forEach((m, i) => m.role === 'char' && (lastChar = i));
    const html = chat.messages.map((m, i) => renderMessage(story, m, !busy && i === lastChar && i > 0)).join('');
    const typing = busy ? `<div class="msg char"><div class="bubble typing"><span></span><span></span><span></span></div></div>` : '';
    box.innerHTML = html + typing;
    hydrateMedia(box);

    const sugg = busy ? [] : chat.suggestions || [];
    $('#suggestions').innerHTML = sugg.map((s, i) => `<button data-i="${i}">${esc(s)}</button>`).join('');
    $('#send').disabled = busy;
    if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
  }

  // ---------- Talking to the characters ----------
  async function send(text) {
    const { story, chat } = S;
    text = (text || '').trim();
    if (!text || !story || S.busy.has(story.id)) return;
    if (!needReady()) return;
    chat.messages = chat.messages.filter((m) => m.role !== 'system');
    chat.messages.push({ id: uid(), role: 'user', text });
    $('#input').value = '';
    autosize();
    await requestReply(story, chat);
  }

  async function requestReply(story, chat) {
    S.busy.add(story.id);
    chat.suggestions = [];
    if (S.view === 'chat') renderChat(true);
    let result = null;
    try {
      const r = await Api.chatReply(story, chat, S.settings);
      const before = { ...chat.aff };
      const applied = {};
      for (const [gid, v] of Object.entries(r.deltas)) {
        const prev = chat.aff[gid] ?? 0;
        chat.aff[gid] = clamp(prev + v.d, Api.levelOf(prev).floor, Api.MAX_POINTS); // levels once reached are kept
        applied[gid] = { d: chat.aff[gid] - before[gid], reason: v.reason };
      }
      const msg = {
        id: uid(),
        role: 'char',
        text: r.text,
        lines: r.lines,
        scene: r.scene,
        inPicture: r.inPicture,
        deltas: applied,
        prevMoods: { ...chat.moods },
        memAdded: 0,
      };
      Object.assign(chat.moods, r.moods);
      // Remember where we are and what everyone wears, so pictures match the story
      if (r.location) chat.state.location = r.location;
      Object.assign(chat.state.outfits, r.outfits);
      msg.location = chat.state.location;
      msg.outfits = { ...chat.state.outfits };
      for (const fact of r.remember) {
        if (!chat.memories.some((x) => x.toLowerCase() === fact.toLowerCase())) {
          chat.memories.push(fact);
          msg.memAdded++;
        }
      }
      while (chat.memories.length > MAX_MEMORIES) chat.memories.shift();
      chat.suggestions = r.suggestions;
      let moment = null;
      if (r.keyMoment && momentAllowed(chat)) {
        moment = {
          id: uid(),
          title: r.keyMoment,
          scene: r.scene,
          inPicture: r.inPicture,
          outfits: msg.outfits,
          location: msg.location,
          text: plain(r.lines ? r.lines.map((l) => l.text).join(' ') : r.text).slice(0, 700),
          at: Date.now(),
          image: null,
        };
        msg.momentTitle = moment.title;
        msg.momentId = moment.id;
      }
      chat.messages.push(msg);
      result = { msg, before, sceneChanged: r.sceneChanged, moment };
    } catch (e) {
      const settingsProblem = ['auth', 'model', 'setup'].includes(e.kind);
      chat.messages.push({ id: uid(), role: 'system', text: e.message, retry: !settingsProblem || e.kind === 'model' });
      if (e.kind === 'auth' && isCurrent(story, chat)) openPassword(t('passwordWrong'));
    } finally {
      S.busy.delete(story.id);
      await saveChat(story, chat);
      if (isCurrent(story, chat) && S.view === 'chat') renderChat(true);
    }
    if (!result) return;
    if (isCurrent(story, chat)) {
      for (const g of story.cast) announceAffection(story, g, result.before[g.id], chat.aff[g.id]);
    }
    if (result.moment) await addMoment(story, chat, result.msg, result.moment);
    else if (shouldDraw(chat, result.sceneChanged)) drawScene(story, chat, result.msg);
    checkMilestones(story, chat);
  }

  function shouldDraw(chat, sceneChanged) {
    if (!picturesOn()) return false;
    if (S.settings.pictureMode === 'every' || sceneChanged) return true;
    const replies = chat.messages.filter((m) => m.role === 'char');
    const lastPic = replies.map((m) => Boolean(imgIdOf(m))).lastIndexOf(true);
    return replies.length - 1 - lastPic >= PICTURE_GAP;
  }

  function momentAllowed(chat) {
    const replies = chat.messages.filter((m) => m.role === 'char');
    const last = replies.map((m) => Boolean(m.momentId)).lastIndexOf(true);
    return last === -1 || replies.length - last >= MOMENT_GAP;
  }

  function announceAffection(story, girl, before, after) {
    if (before === undefined || after === before) return;
    const row = document.querySelector(`.aff-row[data-girl="${CSS.escape(girl.id)}"]`);
    if (row) {
      row.classList.remove('pulse-up', 'pulse-down');
      void row.offsetWidth; // restart the animation
      row.classList.add(after > before ? 'pulse-up' : 'pulse-down');
    }
    const L1 = Api.levelOf(before);
    const L2 = Api.levelOf(after);
    if (L1.i !== L2.i) {
      const up = L2.i > L1.i;
      toast(t(up ? 'nowLevelUp' : 'nowLevelDown', { name: shortName(girl), lv: L2.lv, level: Api.levelName(L2.i) }), up ? 'good' : 'bad');
    }
  }

  async function reroll(msgId) {
    const { story, chat } = S;
    if (!story || S.busy.has(story.id)) return;
    const i = chat.messages.findIndex((m) => m.id === msgId);
    if (i <= 0) return;
    const m = chat.messages[i];
    if (m.deltas) {
      for (const [gid, v] of Object.entries(m.deltas)) chat.aff[gid] = clamp((chat.aff[gid] ?? 0) - (v.d || 0), 0, Api.MAX_POINTS);
    } else if (m.delta) {
      const g0 = story.cast[0].id;
      chat.aff[g0] = clamp(chat.aff[g0] - m.delta, 0, Api.MAX_POINTS);
    }
    if (m.memAdded) chat.memories.splice(-m.memAdded, m.memAdded);
    if (m.prevMoods) chat.moods = { ...m.prevMoods };
    else if ('prevMood' in m) chat.moods[story.cast[0].id] = m.prevMood || '';
    chat.messages.splice(i); // its picture and key moment (if any) stay in the gallery
    await requestReply(story, chat);
  }

  async function retry(msgId) {
    const { story, chat } = S;
    if (!story || S.busy.has(story.id)) return;
    chat.messages = chat.messages.filter((m) => m.id !== msgId);
    if (chat.messages[chat.messages.length - 1]?.role !== 'user') return renderChat();
    await requestReply(story, chat);
  }

  // ---------- Pictures ----------
  function ensurePortrait(story, girl, force = false) {
    if (!force && portraitOk(story, girl)) return Promise.resolve(S.portraits[girl.id]);
    if (S.portraitJobs.has(girl.id)) return S.portraitJobs.get(girl.id);
    const job = (async () => {
      try {
        const key = portraitKey(story, girl);
        const url = await Api.drawPortrait(story, girl, S.settings);
        const oldId = S.index.portraits[girl.id];
        const pid = uid();
        await putImage(pid, url);
        S.index.portraits[girl.id] = pid;
        S.index.portraitStyles[girl.id] = key;
        S.portraits[girl.id] = url;
        await saveIndex();
        if (oldId) deleteMedia(oldId);
        return url;
      } catch (e) {
        toast(t('portraitFailed', { msg: e.message }), 'error');
        return S.portraits[girl.id] || null;
      } finally {
        S.portraitJobs.delete(girl.id);
        refreshViews(story);
      }
    })();
    S.portraitJobs.set(girl.id, job);
    refreshViews(story);
    return job;
  }

  // Draws a picture of some of the women and saves it. Returns the new picture id.
  async function drawPicture(story, girlIds, scene, ctx = {}) {
    let girls = (girlIds || []).map((id) => girlById(story, id)).filter(Boolean);
    if (!girls.length) girls = [story.cast[0]];
    const refs = await Promise.all(girls.map((g) => ensurePortrait(story, g)));
    // women with a portrait first, so "reference image N" matches the Nth woman
    const ordered = girls.map((g, i) => ({ g, r: refs[i] })).sort((a, b) => Number(Boolean(b.r)) - Number(Boolean(a.r)));
    const refList = ordered.filter((x) => x.r).map((x) => x.r);
    const url = await Api.drawScene(story, ordered.map((x) => x.g), scene, refList, S.settings, ctx);
    const id = uid();
    await putImage(id, url);
    return id;
  }

  async function drawScene(story, chat, msg) {
    if (S.drawing.has(msg.id) || imgIdOf(msg)) return;
    S.drawing.add(msg.id);
    refreshViews(story);
    try {
      const scene = msg.scene || story.scenario;
      const inPicture = msg.inPicture?.length ? msg.inPicture : [story.cast[0].id];
      const text = plain(msg.lines ? msg.lines.map((l) => l.text).join(' ') : msg.text);
      const id = await drawPicture(story, inPicture, scene, { outfits: msg.outfits, location: msg.location, text });
      const g = await getGallery(story.id);
      g.items.push({ id, at: Date.now(), caption: plain(msg.lines ? msg.lines.map((l) => l.text).join(' ') : msg.text).slice(0, 140), scene, inPicture });
      await saveGallery(story, g);
      if (chat.messages.includes(msg)) {
        msg.image = id;
        await saveChat(story, chat);
      }
    } catch (e) {
      toast(t('pictureFailed', { msg: e.message }), 'error');
      if (e.kind === 'auth') openPassword(t('passwordWrong'));
    } finally {
      S.drawing.delete(msg.id);
      refreshViews(story);
    }
  }

  // ---------- Key moments (big turning points the AI spots in your story) ----------
  async function addMoment(story, chat, msg, moment) {
    const g = await getGallery(story.id);
    g.moments.push(moment);
    await saveGallery(story, g);
    toast(t('newMoment', { title: moment.title }), 'good');
    if (picturesOn()) drawMoment(story, moment, chat, msg);
  }

  async function drawMoment(story, moment, chat = null, msg = null) {
    const key = 'mo:' + moment.id;
    if (S.drawing.has(key)) return;
    S.drawing.add(key);
    if (msg) S.drawing.add(msg.id);
    refreshViews(story);
    try {
      const id = await drawPicture(story, moment.inPicture, moment.scene || story.scenario, {
        outfits: moment.outfits,
        location: moment.location,
        text: moment.text,
      });
      const g = await getGallery(story.id);
      const stored = g.moments.find((x) => x.id === moment.id);
      if (stored) stored.image = id;
      await saveGallery(story, g);
      if (chat && msg && chat.messages.includes(msg) && !imgIdOf(msg)) {
        msg.image = id;
        await saveChat(story, chat);
      }
    } catch (e) {
      toast(t('pictureFailed', { msg: e.message }), 'error');
    } finally {
      S.drawing.delete(key);
      if (msg) S.drawing.delete(msg.id);
      refreshViews(story);
    }
  }

  // ---------- Milestones (special scenes unlocked by each woman's affection) ----------
  async function checkMilestones(story, chat) {
    const g = await getGallery(story.id);
    const newly = allMilestones(story).filter((x) => chat.aff[x.girl.id] >= atPoints(x.m) && !g.unlocked[x.key]);
    if (!newly.length) return;
    for (const x of newly) g.unlocked[x.key] = { at: Date.now(), image: null };
    await saveGallery(story, g);
    for (const x of newly) {
      toast(t('unlocked', { title: msTitle(x.m) }), 'good');
      if (picturesOn()) drawMilestone(story, x);
    }
    refreshViews(story);
  }

  async function drawMilestone(story, x) {
    const key = msDrawKey(story, x.key);
    if (S.drawing.has(key)) return;
    S.drawing.add(key);
    refreshViews(story);
    try {
      const id = await drawPicture(story, [x.girl.id], x.m.scene);
      const g = await getGallery(story.id);
      g.unlocked[x.key] = { ...(g.unlocked[x.key] || { at: Date.now() }), image: id };
      await saveGallery(story, g);
    } catch (e) {
      toast(t('pictureFailed', { msg: e.message }), 'error');
    } finally {
      S.drawing.delete(key);
      refreshViews(story);
    }
  }

  // ---------- Videos ----------
  async function animate(imageId, story, scene) {
    if (!imageId || S.animating.has(imageId) || hasVideo(imageId)) return;
    if (!confirm(t('videoConfirm', { n: S.settings.videoSeconds }))) return;
    const img = await getImage(imageId);
    if (!img) return;
    S.animating.add(imageId);
    refreshViews(story);
    refreshViewer(imageId);
    try {
      const op = await Api.videoStart(story, scene, img, S.settings);
      S.videoJobs[imageId] = { charId: story.id, model: S.settings.videoModel, op, at: Date.now() };
      await saveJobs();
    } catch (e) {
      S.animating.delete(imageId);
      toast(t('videoFailed', { msg: e.message }), 'error');
      refreshViews(story);
      refreshViewer(imageId);
      return;
    }
    pollVideo(imageId);
  }

  // Asks every few seconds whether the video is ready. Also resumes after the app was closed.
  async function pollVideo(imageId) {
    const job = S.videoJobs[imageId];
    if (!job || (S.animating.has(imageId) && job.polling)) return;
    job.polling = true;
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
        await putVideo(imageId, b64ToBlob(r.video.data, r.video.mimeType));
        toast(t('videoDone'), 'good');
        break;
      }
    } catch (e) {
      error = e.message;
    }
    if (error) toast(t('videoFailed', { msg: error }), 'error');
    delete S.videoJobs[imageId];
    await saveJobs();
    S.animating.delete(imageId);
    const story = findStory(job.charId);
    if (story) refreshViews(story);
    refreshViewer(imageId);
  }

  // ---------- Gallery ----------
  async function openGallery(id) {
    const story = findStory(id);
    if (!story) return goHome();
    if (!needReady()) return;
    S.story = story;
    S.chat = await loadChat(story);
    showScreen('gallery');
    $('#gallery').style.setProperty('--c', safeColor(story.color));
    renderGallery();
  }

  function milestoneTile(story, x, g) {
    const u = g.unlocked[x.key];
    const title = `<span class="tile-title">${esc(msTitle(x.m))}</span>`;
    const data = `data-girl="${esc(x.girl.id)}" data-at="${x.m.at}"`;
    if (u?.image) return `<div class="tile">${mediaBox(u.image, 'view-ms', data)}${title}</div>`;
    if (u) {
      return S.drawing.has(msDrawKey(story, x.key))
        ? `<div class="tile">${loadingBox(t('drawing'))}${title}</div>`
        : `<div class="tile"><button class="pic empty" data-act="draw-ms" ${data}>🖼️<br>${esc(t('tapToDraw'))}</button>${title}</div>`;
    }
    const portrait = S.portraits[x.girl.id];
    const L = Api.levelOf(atPoints(x.m));
    const lockText = t('lockedAt', { lv: L.lv, level: Api.levelName(L.i), pct: L.into });
    return `<div class="tile locked"><div class="pic">${portrait ? `<img class="blur" src="${esc(portrait)}" alt="">` : ''}<span class="lock">🔒</span></div>
      ${title}<span class="tile-sub">${esc(lockText)}</span></div>`;
  }

  async function renderGallery() {
    const story = S.story;
    if (!story || S.view !== 'gallery') return;
    const g = await getGallery(story.id);
    const all = allMilestones(story);
    const unlockedCount = all.filter((x) => g.unlocked[x.key]).length;
    $('#gallery-name').textContent = `${titleOf(story)} · ${t('gallery')}`;
    $('#gallery-count').textContent = t('galleryCount', { n: unlockedCount, total: all.length, m: g.moments.length });

    let milestonesHtml;
    if (isMulti(story)) {
      milestonesHtml = story.cast
        .map((girl) => {
          const mine = all.filter((x) => x.girl.id === girl.id);
          const n = mine.filter((x) => g.unlocked[x.key]).length;
          return `<h4 style="color:${girlColor(story, girl)}">${esc(shortName(girl))} · ${n}/${mine.length}</h4>
            <div class="tiles">${mine.map((x) => milestoneTile(story, x, g)).join('')}</div>`;
        })
        .join('');
    } else {
      milestonesHtml = `<div class="tiles">${all.map((x) => milestoneTile(story, x, g)).join('')}</div>`;
    }

    const moments = [...g.moments].reverse().map((mo) => {
      const title = `<span class="tile-title">✨ ${esc(mo.title)}</span>`;
      if (mo.image) return `<div class="tile">${mediaBox(mo.image, 'view-moment', `data-id="${esc(mo.id)}"`)}${title}</div>`;
      return S.drawing.has('mo:' + mo.id)
        ? `<div class="tile">${loadingBox(t('drawing'))}${title}</div>`
        : `<div class="tile"><button class="pic empty" data-act="draw-moment" data-id="${esc(mo.id)}">🖼️<br>${esc(t('tapToDraw'))}</button>${title}</div>`;
    });

    const items = [...g.items].reverse();
    const storyTiles = items.length
      ? `<div class="tiles">${items.map((it) => `<div class="tile">${mediaBox(it.id, 'view-item', `data-id="${esc(it.id)}"`)}</div>`).join('')}</div>`
      : `<p class="hint">${esc(t('noStory'))}</p>`;

    const body = $('#gallery-body');
    body.innerHTML = `<h3>${esc(t('milestones'))}</h3>${milestonesHtml}
      <h3>${esc(t('keyMoments'))}</h3>${moments.length ? `<div class="tiles">${moments.join('')}</div>` : `<p class="hint">${esc(t('noMoments'))}</p>`}
      <h3>${esc(t('story'))}</h3>${storyTiles}`;
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
    const base = titleOf(view.story).replace(/[^\p{L}\p{N}]+/gu, '-');
    if (vurl) {
      holder.replaceChildren(makeVideo(vurl, true));
      dl.href = vurl;
      dl.download = `${base}-${imageId}.mp4`;
    } else if (iurl) {
      const img = new Image();
      img.src = iurl;
      img.alt = '';
      holder.replaceChildren(img);
      dl.href = iurl;
      dl.download = `${base}-${imageId}.png`;
    }
  }

  function refreshViewer(imageId) {
    if (modal.open && modal.classList.contains('viewer') && S.viewer?.imageId === imageId) openViewer(S.viewer);
  }

  async function removeGalleryItem(view) {
    if (!confirm(t('removeConfirm'))) return;
    const { story, imageId } = view;
    const g = await getGallery(story.id);
    g.items = g.items.filter((it) => it.id !== imageId);
    await saveGallery(story, g);
    const chat = await loadChat(story);
    if (chat) {
      let changed = false;
      for (const m of chat.messages) {
        if (imgIdOf(m) === imageId) {
          m.image = null;
          changed = true;
        }
      }
      if (changed) await saveChat(story, chat);
    }
    await deleteMedia(imageId);
    closeModal();
    refreshViews(story);
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
        initCloud();
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
      <label>${esc(t('yourGender'))}${selectHtml('userGender', s.userGender, [
        ['man', t('genderMan')],
        ['woman', t('genderWoman')],
        ['any', t('genderAny')],
      ])}</label>
      <label>${esc(t('pictures'))}${selectHtml('pictureMode', s.pictureMode, [
        ['scene', t('picScene')],
        ['every', t('picEvery')],
        ['off', t('picOff')],
      ])}</label>
      <label>${esc(t('picMaker'))}${selectHtml('imageProvider', s.imageProvider, [
        ['google', t('picMakerGoogle')],
        ['fal', t('picMakerFal')],
      ])}</label>
      <label>${esc(t('falModel'))}${selectHtml('falModel', s.falModel, [
        ['dreamshaper', t('falDreamshaper')],
        ['animagine', t('falAnimagine')],
        ['realvis', t('falRealvis')],
        ['custom', t('falCustom')],
      ])}</label>
      <input name="falCustomModel" value="${esc(s.falCustomModel)}" placeholder="${esc(t('falCustomPh'))}">
      <p class="hint">${esc(t('falHint'))}</p>
      <label>${esc(t('pictureStyle'))}${selectHtml('pictureStyle', s.pictureStyle, [
        ['photo', t('styPhoto')],
        ['painting', t('styPainting')],
        ['anime', t('styAnime')],
        ['character', t('styCharacter')],
      ])}</label>
      <p class="hint">${esc(t('styleHint'))}</p>
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
        const passwordChanged = String(f.get('password') || '') !== S.settings.password;
        S.settings = {
          ...S.settings,
          language: String(f.get('language')),
          userName: String(f.get('userName') || '').trim(),
          userGender: String(f.get('userGender')),
          pictureMode: String(f.get('pictureMode')),
          pictureStyle: String(f.get('pictureStyle')),
          imageProvider: String(f.get('imageProvider')),
          falModel: String(f.get('falModel')),
          falCustomModel: String(f.get('falCustomModel') || '').trim(),
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
        if (passwordChanged || !S.ready) await initCloud();
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

  // ---------- Creating / editing a one-woman character ----------
  const CHAR_FIELDS = [
    ['name', 'input', 'Aria Blackwood'],
    ['age', 'number', ''],
    ['gender', 'input', 'female'],
    ['genre', 'input', 'Fantasy / 奇幻'],
    ['tagline', 'input', ''],
    ['appearance', 'textarea', 'Korean / Japanese / Hong Kong woman, 25, hair, eyes, build, clothes, distinctive features…'],
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
    if (!needReady()) return;
    const zhMode = zh();
    const c = char || {
      age: 25,
      gender: 'female',
      startAffection: 15,
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
        if (looksChanged) await forgetPortrait(id);
        rebuildStories();
        toast(t(char ? 'charUpdated' : 'charCreated'), 'good');
        if (!char) goChat(id);
        else refreshViews(S.story);
      },
    );
  }

  async function forgetPortrait(girlId) {
    const pid = S.index.portraits[girlId];
    delete S.index.portraits[girlId];
    delete S.index.portraitStyles[girlId];
    delete S.portraits[girlId];
    await saveIndex();
    if (pid) await deleteMedia(pid);
  }

  async function deleteCharacter(story) {
    if (!confirm(t('deleteConfirm', { name: titleOf(story) }))) return;
    const id = story.id;
    const chat = await loadChat(story);
    const g = await getGallery(id);
    const ids = new Set([
      ...g.items.map((it) => it.id),
      ...g.moments.map((mo) => mo.image),
      ...Object.values(g.unlocked).map((u) => u.image),
      ...story.cast.map((girl) => S.index.portraits[girl.id]),
    ]);
    for (const m of chat?.messages || []) ids.add(imgIdOf(m));
    for (const imageId of ids) if (imageId) await deleteMedia(imageId);
    await Promise.all([delDoc('chat:' + id), delDoc('gallery:' + id)]);
    S.chats.delete(id);
    S.galleries.delete(id);
    for (const girl of story.cast) {
      delete S.portraits[girl.id];
      delete S.index.portraits[girl.id];
      delete S.index.portraitStyles[girl.id];
    }
    delete S.index.progress[id];
    delete S.index.unlocks[id];
    await saveIndex();
    delete S.custom[id];
    await saveCustom();
    rebuildStories();
    closeModal();
    goHome();
  }

  async function restoreCharacter(story) {
    if (!confirm(t('restoreConfirm'))) return;
    delete S.custom[story.id];
    await saveCustom();
    await forgetPortrait(story.cast[0].id);
    rebuildStories();
    closeModal();
    refreshViews(S.story);
  }

  const memoriesName = (story) => (isMulti(story) ? titleOf(story) : shortName(story.cast[0]));

  function openMenu() {
    const { story } = S;
    openModal(
      `<h2>${esc(titleOf(story))}</h2>
      <div class="menu">
        <button type="button" data-act="gallery">${esc(t('menuGallery'))}</button>
        <button type="button" data-act="memories">${esc(t('menuMemories', { name: memoriesName(story) }))}</button>
        <button type="button" data-act="new-portrait">${esc(t('menuPortrait'))}</button>
        ${isMulti(story) ? '' : `<button type="button" data-act="edit-char">${esc(t('menuEdit'))}</button>`}
        <button type="button" data-act="restart" class="danger">${esc(t('menuRestart'))}</button>
        <button type="button" data-act="close">${esc(t('close'))}</button>
      </div>`,
      null,
      'small',
    );
  }

  function openMemories() {
    const { story, chat } = S;
    openModal(
      `<h2>${esc(t('memoriesTitle', { name: memoriesName(story) }))}</h2>
      <p class="hint">${esc(t('memoriesHint'))}</p>
      <textarea name="memories" rows="12">${esc(chat.memories.join('\n'))}</textarea>
      <div class="actions"><button type="button" data-act="close">${esc(t('cancel'))}</button><button type="submit" class="primary">${esc(t('save'))}</button></div>`,
      async (form) => {
        chat.memories = String(new FormData(form).get('memories') || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(-MAX_MEMORIES);
        await saveChat(story, chat);
        toast(t('memoriesSaved'), 'good');
      },
    );
  }

  async function restartStory() {
    const { story } = S;
    if (!confirm(t('restartConfirm', { name: titleOf(story) }))) return;
    closeModal();
    // Pictures that are in the gallery are kept; anything else from the old chat is removed.
    const g = await getGallery(story.id);
    const keep = new Set([...g.items.map((it) => it.id), ...g.moments.map((mo) => mo.image)]);
    for (const m of S.chat.messages) {
      const id = imgIdOf(m);
      if (id && !keep.has(id)) await deleteMedia(id);
    }
    const chat = newChat(story);
    S.chats.set(story.id, chat);
    S.chat = chat;
    await saveChat(story, chat);
    renderChat(true);
    if (picturesOn()) drawScene(story, chat, chat.messages[0]);
  }

  // ---------- Wiring up buttons ----------
  function autosize() {
    const el = $('#input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  function bindEvents() {
    window.addEventListener('hashchange', route);
    window.addEventListener('online', flushPending);
    $('#btn-settings').addEventListener('click', openSettings);
    $('#key-banner').addEventListener('click', (e) => e.target.closest('[data-act=password]') && openPassword());
    $('#btn-back').addEventListener('click', goHome);
    $('#btn-gallery').addEventListener('click', () => S.story && goGallery(S.story.id));
    $('#btn-gallery-back').addEventListener('click', () => S.story && goChat(S.story.id));
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
      const { story, chat } = S;
      const m = chat.messages.find((x) => x.id === (el.dataset.id || el.dataset.msg));
      const act = el.dataset.act;
      if (act === 'draw' && m) drawScene(story, chat, m);
      else if (act === 'animate' && m) animate(imgIdOf(m), story, m.scene);
      else if (act === 'reroll') reroll(el.dataset.id);
      else if (act === 'retry') retry(el.dataset.id);
      else if (act === 'view' && m) openViewer({ story, imageId: imgIdOf(m), caption: m.momentTitle || '', scene: m.scene, deletable: false });
    });

    $('#gallery-body').addEventListener('click', async (e) => {
      const el = e.target.closest('[data-act]');
      if (!el || !S.story) return;
      const story = S.story;
      const g = await getGallery(story.id);
      const act = el.dataset.act;
      const x = allMilestones(story).find((y) => y.girl.id === el.dataset.girl && String(y.m.at) === el.dataset.at);
      const mo = g.moments.find((y) => y.id === el.dataset.id);
      if (act === 'draw-ms' && x) drawMilestone(story, x);
      else if (act === 'view-ms' && x) {
        openViewer({ story, imageId: g.unlocked[x.key].image, caption: msTitle(x.m), scene: x.m.scene, deletable: false });
      } else if (act === 'draw-moment' && mo) drawMoment(story, mo);
      else if (act === 'view-moment' && mo) {
        openViewer({ story, imageId: mo.image, caption: `✨ ${mo.title}`, scene: mo.scene, deletable: false });
      } else if (act === 'view-item') {
        const it = g.items.find((y) => y.id === el.dataset.id);
        if (it) openViewer({ story, imageId: it.id, caption: it.caption, scene: it.scene, deletable: true });
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
        goGallery(S.story.id);
      } else if (act === 'memories') openMemories();
      else if (act === 'edit-char') openEditor(S.story);
      else if (act === 'restart') restartStory();
      else if (act === 'delete-char') deleteCharacter(S.story);
      else if (act === 'restore-char') restoreCharacter(S.story);
      else if (act === 'animate-view' && S.viewer) animate(S.viewer.imageId, S.viewer.story, S.viewer.scene);
      else if (act === 'remove-item' && S.viewer) removeGalleryItem(S.viewer);
      else if (act === 'new-portrait') {
        closeModal();
        toast(t('newPortrait'));
        for (const g of S.story.cast) ensurePortrait(S.story, g, true);
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
    S.settings = { ...DEFAULT_SETTINGS, ...(await Store.get('settings', {})) };
    I18N.set(S.settings.language);
    S.custom = (await Store.get('custom')) || {};
    rebuildStories();
    applyStaticText();
    bindEvents();
    showScreen('home');
    renderHome();
    await initCloud();
    route();
  })();
})();
