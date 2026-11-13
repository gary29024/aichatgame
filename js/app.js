// The app itself: screens, buttons, sending messages, affection, pictures.
(() => {
  'use strict';

  // ---------- Defaults you can change in Settings ----------
  const DEFAULT_SETTINGS = {
    apiKey: '',
    userName: '',
    textModel: 'gemini-3.8-flash',
    imageModel: 'gemini-nano-banana-2.1',
    pictureMode: 'scene', // 'scene' | 'every' | 'off'
    romance: 'mature', // 'sweet' | 'flirty' | 'mature'
    safety: 'minimum', // 'minimum' | 'relaxed' | 'standard'
  };
  const TEXT_MODELS = [
    ['gemini-3.8-flash', 'Gemini 3.8 Flash (good balance)'],
    ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite (fastest, cheapest)'],
    ['gemini-4-hydrogen', 'Gemini 4 Hydrogen (smarter, slower)'],
    ['gemini-4-carbon', 'Gemini 4 Carbon (strongest, slowest)'],
  ];
  const IMAGE_MODELS = [
    ['gemini-nano-banana-2.1', 'Nano Banana 2.1 (recommended)'],
    ['gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite (cheapest)'],
    ['gemini-3.1-flash-image', 'Nano Banana 2'],
    ['gemini-3-pro-image', 'Nano Banana Pro (best, priciest)'],
  ];
  const MAX_MEMORIES = 40;
  const PICTURE_GAP = 5; // in "scene" mode, draw at least every N replies

  // ---------- State ----------
  const S = {
    settings: { ...DEFAULT_SETTINGS },
    custom: {}, // characters you created or edited
    characters: [],
    portraits: {}, // character id -> picture
    progress: {}, // character id -> affection (for the home screen)
    chats: new Map(), // character id -> chat (kept in memory once opened)
    images: new Map(), // message id -> picture
    char: null,
    chat: null,
    busy: new Set(), // character ids waiting for a reply
    drawing: new Set(), // message ids being drawn
    portraitJobs: new Map(),
  };

  // ---------- Small helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#8b5cf6');
  const firstName = (char) => char.name.replace(/^(Captain|Lord|Lady|Dr\.?|Sir)\s+/i, '').split(' ')[0];

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
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => t.classList.add('hide'), kind === 'error' ? 6000 : 3200);
    setTimeout(() => t.remove(), kind === 'error' ? 6600 : 3800);
  }

  // ---------- Saving & loading ----------
  async function loadAll() {
    S.settings = { ...DEFAULT_SETTINGS, ...(await Store.get('settings', {})) };
    S.custom = await Store.get('characters:custom', {});
    S.progress = await Store.get('progress', {});
    rebuildCharacters();
    await Promise.all(
      S.characters.map(async (c) => {
        const p = await Store.get('portrait:' + c.id);
        if (p) S.portraits[c.id] = p;
      }),
    );
  }

  function rebuildCharacters() {
    const starterIds = new Set(STARTER_CHARACTERS.map((c) => c.id));
    const starters = STARTER_CHARACTERS.map((c) =>
      S.custom[c.id] ? { ...c, ...S.custom[c.id], starter: true, edited: true } : { ...c, starter: true },
    );
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
  async function deleteChatImages(chat) {
    for (const m of chat?.messages || []) {
      if (m.image) {
        await Store.del('img:' + m.id);
        S.images.delete(m.id);
      }
    }
  }

  function newChat(char) {
    return {
      affection: clamp(Math.round(Number(char.startAffection) || 20), 0, 100),
      mood: '',
      memories: [],
      suggestions: [],
      messages: [{ id: uid(), role: 'char', text: char.greeting, scene: char.scenario }],
    };
  }

  const isCurrent = (char, chat) => S.char && S.char.id === char.id && S.chat === chat;
  const picturesOn = () => S.settings.apiKey && S.settings.pictureMode !== 'off';

  // ---------- Navigation (uses the address bar so the phone's back button works) ----------
  function route() {
    const m = location.hash.match(/^#\/chat\/(.+)$/);
    if (m) openChat(decodeURIComponent(m[1]));
    else showHome();
  }
  const goChat = (id) => (location.hash = '#/chat/' + encodeURIComponent(id));
  const goHome = () => (location.hash = '');

  // ---------- Home screen ----------
  function showHome() {
    S.char = null;
    S.chat = null;
    $('#chat').hidden = true;
    $('#home').hidden = false;
    renderHome();
  }

  function renderHome() {
    $('#key-banner').hidden = Boolean(S.settings.apiKey);
    const cards = S.characters.map((c) => {
      const p = S.portraits[c.id];
      const aff = S.progress[c.id];
      return `<button class="card" data-id="${esc(c.id)}" style="--c:${safeColor(c.color)}">
        ${p ? `<img src="${esc(p)}" alt="">` : `<span class="initial">${esc(c.name.trim()[0] || '?')}</span>`}
        <span class="card-info">
          <span class="genre">${esc(c.genre || 'Story')}</span>
          <strong>${esc(c.name)}</strong>
          <span class="tag">${esc(c.tagline || '')}</span>
          ${aff !== undefined ? `<span class="mini-bar"><span style="width:${aff}%"></span></span><span class="mini-label">♥ ${esc(Gemini.tierFor(aff).label)} · ${aff}</span>` : ''}
        </span>
      </button>`;
    });
    cards.push(`<button class="card add" data-act="new-char">
        <span class="plus">+</span>
        <span class="card-info"><strong>Create character</strong><span class="tag">Write your own story partner</span></span>
      </button>`);
    $('#char-grid').innerHTML = cards.join('');
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
    $('#home').hidden = true;
    $('#chat').hidden = false;
    $('#chat').style.setProperty('--c', safeColor(char.color));
    renderChat(true);
    if (fresh && picturesOn()) drawScene(char, chat, chat.messages[0]);
    else if (!S.portraits[id] && picturesOn()) ensurePortrait(char);
  }

  function renderChatHeader() {
    const { char, chat } = S;
    if (!char) return;
    $('#chat-name').textContent = char.name;
    $('#chat-mood').textContent = chat.mood ? `feeling ${chat.mood}` : char.genre || '';
    const av = $('#chat-avatar');
    const p = S.portraits[char.id];
    av.innerHTML = p ? `<img src="${esc(p)}" alt="">` : esc(char.name.trim()[0] || '?');
    av.classList.toggle('loading', S.portraitJobs.has(char.id));
    const a = chat.affection;
    const tier = Gemini.tierFor(a);
    const next = Gemini.TIERS.find((t) => t.min > a);
    $('#aff-fill').style.width = a + '%';
    $('#aff-label').textContent = tier.label;
    $('#aff-num').textContent = next ? `${a} / next at ${next.min}` : `${a} / 100`;
  }

  function renderMessage(m, canReroll) {
    if (m.role === 'system') {
      return `<div class="msg system"><span>${esc(m.text)}</span>${
        m.retry ? ` <button class="link" data-act="retry" data-id="${m.id}">Try again</button>` : ''
      }</div>`;
    }
    if (m.role === 'user') {
      return `<div class="msg user"><div class="bubble">${formatText(m.text)}</div></div>`;
    }
    const drawing = S.drawing.has(m.id);
    const pic = m.image
      ? `<div class="pic"><img data-img="${m.id}" data-act="zoom" alt="Picture of the scene"></div>`
      : drawing
        ? `<div class="pic loading"><span>Drawing the scene…</span></div>`
        : '';
    const delta = m.delta
      ? `<span class="delta ${m.delta > 0 ? 'up' : 'down'}">${m.delta > 0 ? '+' : ''}${m.delta} ♥${
          m.reason ? ` <span class="why">${esc(m.reason)}</span>` : ''
        }</span>`
      : '';
    const draw = !m.image && !drawing ? `<button data-act="draw" data-id="${m.id}">🎨 Picture</button>` : '';
    const reroll = canReroll ? `<button data-act="reroll" data-id="${m.id}">↻ Another reply</button>` : '';
    return `<div class="msg char">${pic}<div class="bubble">${formatText(m.text)}</div><div class="tools">${delta}${draw}${reroll}</div></div>`;
  }

  function renderChat(forceScroll = false) {
    const { char, chat } = S;
    if (!char || !chat) return;
    renderChatHeader();
    const box = $('#messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    const busy = S.busy.has(char.id);
    let lastChar = -1;
    chat.messages.forEach((m, i) => m.role === 'char' && (lastChar = i));
    const html = chat.messages.map((m, i) => renderMessage(m, !busy && i === lastChar && i > 0)).join('');
    const typing = busy
      ? `<div class="msg char"><div class="bubble typing"><span></span><span></span><span></span></div></div>`
      : '';
    box.innerHTML = html + typing;

    box.querySelectorAll('img[data-img]').forEach(async (img) => {
      const id = img.dataset.img;
      let url = S.images.get(id);
      if (!url) {
        url = await Store.get('img:' + id);
        if (url) S.images.set(id, url);
      }
      if (url) img.src = url;
    });

    const sugg = busy ? [] : chat.suggestions || [];
    $('#suggestions').innerHTML = sugg.map((s, i) => `<button data-i="${i}">${esc(s)}</button>`).join('');
    $('#send').disabled = busy;

    if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function refresh(char, scroll = false) {
    if (S.char && S.char.id === char.id) renderChat(scroll);
  }

  // ---------- Talking to the character ----------
  async function send(text) {
    const { char, chat } = S;
    text = (text || '').trim();
    if (!text || !char || S.busy.has(char.id)) return;
    if (!S.settings.apiKey) return openSettings('Add your Gemini API key first.');
    chat.messages = chat.messages.filter((m) => m.role !== 'system');
    chat.messages.push({ id: uid(), role: 'user', text });
    $('#input').value = '';
    autosize();
    await requestReply(char, chat);
  }

  async function requestReply(char, chat) {
    S.busy.add(char.id);
    chat.suggestions = [];
    refresh(char, true);
    let result = null;
    try {
      const r = await Gemini.chatReply(char, chat, S.settings);
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
      const settingsProblem = e.kind === 'auth' || e.kind === 'model';
      chat.messages.push({ id: uid(), role: 'system', text: e.message, retry: !settingsProblem });
      if (settingsProblem && isCurrent(char, chat)) openSettings(e.message);
    } finally {
      S.busy.delete(char.id);
      await saveChat(char.id, chat);
      refresh(char, true);
    }
    if (!result) return;
    if (isCurrent(char, chat)) announceAffection(char, result.before, chat.affection);
    if (shouldDraw(chat, result.sceneChanged)) drawScene(char, chat, result.msg);
  }

  function shouldDraw(chat, sceneChanged) {
    if (!picturesOn()) return false;
    if (S.settings.pictureMode === 'every' || sceneChanged) return true;
    const replies = chat.messages.filter((m) => m.role === 'char');
    const lastPic = replies.map((m) => Boolean(m.image)).lastIndexOf(true);
    return replies.length - 1 - lastPic >= PICTURE_GAP;
  }

  function announceAffection(char, before, after) {
    if (after === before) return;
    const bar = $('#affection');
    bar.classList.remove('pulse-up', 'pulse-down');
    void bar.offsetWidth; // restart the animation
    bar.classList.add(after > before ? 'pulse-up' : 'pulse-down');
    const t1 = Gemini.tierFor(before);
    const t2 = Gemini.tierFor(after);
    if (t1 !== t2) {
      const up = after > before;
      toast(`${up ? '💞' : '💔'} ${firstName(char)} is now ${t2.label.toLowerCase()} with you`, up ? 'good' : 'bad');
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
    if (m.image) {
      await Store.del('img:' + m.id);
      S.images.delete(m.id);
    }
    chat.messages.splice(i);
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
        const url = await Gemini.image(Gemini.portraitPrompt(char), S.settings);
        S.portraits[char.id] = url;
        await Store.set('portrait:' + char.id, url);
        return url;
      } catch (e) {
        toast(`Portrait failed: ${e.message}`, 'error');
        return S.portraits[char.id] || null;
      } finally {
        S.portraitJobs.delete(char.id);
        if (S.char && S.char.id === char.id) renderChatHeader();
      }
    })();
    S.portraitJobs.set(char.id, job);
    if (S.char && S.char.id === char.id) renderChatHeader();
    return job;
  }

  async function drawScene(char, chat, msg) {
    if (S.drawing.has(msg.id)) return;
    if (!S.settings.apiKey) return openSettings('Add your Gemini API key to draw pictures.');
    S.drawing.add(msg.id);
    refresh(char);
    try {
      const ref = await ensurePortrait(char);
      const url = await Gemini.image(Gemini.scenePrompt(char, msg.scene || char.scenario, Boolean(ref)), S.settings, ref);
      if (chat.messages.includes(msg)) {
        await Store.set('img:' + msg.id, url);
        S.images.set(msg.id, url);
        msg.image = true;
        await saveChat(char.id, chat);
      }
    } catch (e) {
      toast(`Picture failed: ${e.message}`, 'error');
    } finally {
      S.drawing.delete(msg.id);
      refresh(char);
    }
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

  function openSettings(note = '') {
    const s = S.settings;
    const options = (list, value) => {
      const known = list.some(([id]) => id === value);
      return (
        list.map(([id, label]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(label)}</option>`).join('') +
        (known ? '' : `<option value="${esc(value)}" selected>${esc(value)}</option>`)
      );
    };
    const sel = (name, value, opts) =>
      `<select name="${name}">${opts.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

    openModal(
      `<h2>Settings</h2>
      ${note ? `<p class="note">${esc(note)}</p>` : ''}
      <label>Gemini API key
        <input type="password" name="apiKey" value="${esc(s.apiKey)}" autocomplete="off" placeholder="Paste your key here">
      </label>
      <p class="hint">Get a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>.
        It is stored only in this browser on this device and sent only to Google.</p>
      <div class="row"><button type="button" data-act="test-key">Test key</button><span id="test-result" class="hint"></span></div>

      <label>Your name in the stories
        <input name="userName" value="${esc(s.userName)}" placeholder="e.g. Alex" maxlength="40">
      </label>

      <label>Pictures
        ${sel('pictureMode', s.pictureMode, [
          ['scene', 'When the scene changes'],
          ['every', 'With every reply (costs more)'],
          ['off', 'Only when I tap 🎨'],
        ])}
      </label>
      <label>Romance level
        ${sel('romance', s.romance, [
          ['mature', 'Mature (adult romance)'],
          ['flirty', 'Flirty (kisses, then fade to black)'],
          ['sweet', 'Sweet (wholesome)'],
        ])}
      </label>
      <label>Google safety filter
        ${sel('safety', s.safety, [
          ['minimum', 'Lowest Google allows'],
          ['relaxed', 'Relaxed'],
          ['standard', 'Standard'],
        ])}
      </label>
      <p class="hint">Google always enforces its own rules on top of this, so some replies or pictures may still be blocked.</p>

      <details>
        <summary>Advanced: AI models</summary>
        <label>Text model <select name="textModel">${options(TEXT_MODELS, s.textModel)}</select></label>
        <label>Picture model <select name="imageModel">${options(IMAGE_MODELS, s.imageModel)}</select></label>
        <label>…or type any other model ID <input name="customText" placeholder="text model ID (optional)"></label>
        <input name="customImage" placeholder="picture model ID (optional)">
      </details>

      <div class="actions">
        <button type="button" data-act="close">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>`,
      async (form) => {
        const f = new FormData(form);
        S.settings = {
          ...S.settings,
          apiKey: String(f.get('apiKey') || '').trim(),
          userName: String(f.get('userName') || '').trim(),
          pictureMode: f.get('pictureMode'),
          romance: f.get('romance'),
          safety: f.get('safety'),
          textModel: String(f.get('customText') || '').trim() || f.get('textModel'),
          imageModel: String(f.get('customImage') || '').trim() || f.get('imageModel'),
        };
        await saveSettings();
        toast('Settings saved', 'good');
        if (!S.char) renderHome();
      },
    );
  }

  async function testKey(form) {
    const f = new FormData(form);
    const out = $('#test-result');
    out.textContent = 'Testing…';
    try {
      const reply = await Gemini.testKey({
        apiKey: String(f.get('apiKey') || ''),
        textModel: String(f.get('customText') || '').trim() || f.get('textModel'),
      });
      out.textContent = `✓ Works (Gemini said "${reply.slice(0, 20)}")`;
    } catch (e) {
      out.textContent = `✗ ${e.message}`;
    }
  }

  const CHAR_FIELDS = [
    ['name', 'Name', 'input', 'e.g. Aria Blackwood'],
    ['age', 'Age (must be 18 or older)', 'number', ''],
    ['gender', 'Gender', 'input', 'e.g. female, male, non-binary'],
    ['genre', 'Genre', 'input', 'e.g. Fantasy, Romance, Mystery'],
    ['tagline', 'One-line hook (shown on the card)', 'input', ''],
    ['appearance', 'Looks (used to draw pictures)', 'textarea', 'Hair, eyes, build, clothes, distinctive features…'],
    ['personality', 'Personality', 'textarea', 'What they are like, what they love and hate…'],
    ['backstory', 'Backstory', 'textarea', 'Their past and what they want…'],
    ['speakingStyle', 'Way of speaking', 'textarea', 'Formal? Teasing? Slang?'],
    ['scenario', 'Opening situation', 'textarea', 'Where and how the story begins…'],
    ['greeting', 'Their first message (put actions in *asterisks*)', 'textarea', '*She looks up.* "Oh. It\'s you."'],
    ['artStyle', 'Picture style', 'input', 'e.g. anime illustration, oil painting, semi-realistic'],
    ['startAffection', 'Starting affection (0–100)', 'number', ''],
    ['color', 'Card colour', 'color', ''],
  ];
  const REQUIRED = ['name', 'age', 'appearance', 'personality', 'scenario', 'greeting'];

  function openEditor(char = null) {
    const c = char || {
      age: 25,
      startAffection: 20,
      color: '#8b5cf6',
      artStyle: 'detailed anime-style digital illustration, soft cinematic lighting',
    };
    const fields = CHAR_FIELDS.map(([key, label, type, ph]) => {
      const v = esc(c[key] ?? '');
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
          ? `<button type="button" class="danger" data-act="restore-char" data-id="${esc(char.id)}">Restore original</button>`
          : ''
        : `<button type="button" class="danger" data-act="delete-char" data-id="${esc(char.id)}">Delete character</button>`;

    openModal(
      `<h2>${char ? 'Edit character' : 'Create a character'}</h2>
      <p class="hint">All characters must be adults. Their looks and picture style are used to draw them.</p>
      ${fields}
      <div class="actions">${extra}<span class="spacer"></span>
        <button type="button" data-act="close">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>`,
      async (form) => {
        const f = new FormData(form);
        const data = {};
        for (const [key] of CHAR_FIELDS) data[key] = String(f.get(key) ?? '').trim();
        data.age = Math.round(Number(data.age));
        if (!Number.isFinite(data.age) || data.age < 18) {
          toast('Characters must be 18 or older.', 'error');
          return false;
        }
        data.startAffection = clamp(Math.round(Number(data.startAffection) || 0), 0, 100);
        data.color = safeColor(data.color);
        const id = char ? char.id : 'c_' + uid();
        const looksChanged = char && (char.appearance !== data.appearance || char.artStyle !== data.artStyle);
        S.custom[id] = { ...(S.custom[id] || {}), ...data, id };
        await saveCustom();
        if (looksChanged) {
          delete S.portraits[id];
          await Store.del('portrait:' + id);
        }
        rebuildCharacters();
        toast(char ? 'Character updated' : 'Character created', 'good');
        if (S.char) renderChat();
        else if (!char) goChat(id);
        else renderHome();
      },
    );
  }

  async function deleteCharacter(id) {
    const c = findChar(id);
    if (!c || !confirm(`Delete ${c.name} and your whole story with them?`)) return;
    const chat = S.chats.get(id) || (await Store.get('chat:' + id));
    await deleteChatImages(chat);
    await Promise.all([Store.del('chat:' + id), Store.del('portrait:' + id)]);
    S.chats.delete(id);
    delete S.portraits[id];
    delete S.progress[id];
    await Store.set('progress', S.progress);
    delete S.custom[id];
    await saveCustom();
    rebuildCharacters();
    closeModal();
    goHome();
    renderHome();
  }

  async function restoreCharacter(id) {
    if (!confirm('Undo your edits to this character? Your story with them is kept.')) return;
    delete S.custom[id];
    await saveCustom();
    delete S.portraits[id];
    await Store.del('portrait:' + id);
    rebuildCharacters();
    closeModal();
    if (S.char) renderChat();
    else renderHome();
  }

  function openMenu() {
    const { char } = S;
    openModal(
      `<h2>${esc(char.name)}</h2>
      <div class="menu">
        <button type="button" data-act="memories">📝 What ${esc(firstName(char))} remembers</button>
        <button type="button" data-act="new-portrait">🖼️ Draw a new portrait</button>
        <button type="button" data-act="edit-char">✏️ Edit character</button>
        <button type="button" data-act="restart" class="danger">↺ Restart the story</button>
        <button type="button" data-act="close">Close</button>
      </div>`,
      null,
      'small',
    );
  }

  function openMemories() {
    const { char, chat } = S;
    openModal(
      `<h2>What ${esc(firstName(char))} remembers</h2>
      <p class="hint">The AI adds important facts here as you play. One fact per line. You can edit or delete them.</p>
      <textarea name="memories" rows="12">${esc(chat.memories.join('\n'))}</textarea>
      <div class="actions"><button type="button" data-act="close">Cancel</button><button type="submit" class="primary">Save</button></div>`,
      async (form) => {
        chat.memories = String(new FormData(form).get('memories') || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(-MAX_MEMORIES);
        await saveChat(char.id, chat);
        toast('Memories saved', 'good');
      },
    );
  }

  async function restartStory() {
    const { char } = S;
    if (!confirm(`Restart your story with ${char.name}? The whole conversation and its pictures will be deleted.`)) return;
    closeModal();
    await deleteChatImages(S.chat);
    const chat = newChat(char);
    S.chats.set(char.id, chat);
    S.chat = chat;
    await saveChat(char.id, chat);
    renderChat(true);
    if (picturesOn()) drawScene(char, chat, chat.messages[0]);
  }

  // ---------- Wiring up buttons ----------
  function autosize() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 140) + 'px';
  }

  function bindEvents() {
    window.addEventListener('hashchange', route);
    $('#btn-settings').addEventListener('click', () => openSettings());
    $('#banner-settings').addEventListener('click', () => openSettings());
    $('#btn-back').addEventListener('click', goHome);
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
      const t = e.target.closest('[data-act]');
      if (!t || !S.chat) return;
      const id = t.dataset.id;
      if (t.dataset.act === 'draw') {
        const m = S.chat.messages.find((x) => x.id === id);
        if (m) drawScene(S.char, S.chat, m);
      } else if (t.dataset.act === 'reroll') reroll(id);
      else if (t.dataset.act === 'retry') retry(id);
      else if (t.dataset.act === 'zoom' && t.src) openModal(`<img class="zoomed" src="${esc(t.src)}" alt="" data-act="close">`, null, 'image');
    });

    // Pop-up buttons
    modal.addEventListener('click', (e) => {
      if (e.target === modal) return closeModal(); // tapped outside the box
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'close') closeModal();
      else if (act === 'test-key') testKey($('#modal-form'));
      else if (act === 'memories') openMemories();
      else if (act === 'edit-char') openEditor(S.char);
      else if (act === 'restart') restartStory();
      else if (act === 'delete-char') deleteCharacter(t.dataset.id);
      else if (act === 'restore-char') restoreCharacter(t.dataset.id);
      else if (act === 'new-portrait') {
        closeModal();
        if (!S.settings.apiKey) return openSettings('Add your Gemini API key to draw pictures.');
        toast('Drawing a new portrait…');
        ensurePortrait(S.char, true);
      }
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
    bindEvents();
    route();
  })();
})();
