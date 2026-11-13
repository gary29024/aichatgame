// Builds the instructions for the AI and talks to our own server (src/worker.js),
// which passes the request through Cloudflare AI Gateway to Google Vertex AI.
// The browser never sees the Google credentials: it only knows the app password.

window.Api = (() => {
  const t = (...a) => I18N.t(...a);
  const HISTORY_LIMIT = 60; // how many recent messages are sent each time

  // ---- Affection levels -------------------------------------------------------
  const TIERS = [
    { min: 0, how: 'Distant and guarded. Short replies. May be rude, dismissive or try to leave.' },
    { min: 10, how: 'Suspicious, testing the user. Polite at best and reveals nothing personal.' },
    { min: 25, how: 'Interested despite themself. Banter and small personal details, but walls stay up.' },
    { min: 40, how: "Warm and relaxed, enjoys the user's company, shares stories, light flirting if it suits them." },
    { min: 55, how: 'Trusts the user, opens up about their past and fears, flirts openly, seeks the user out.' },
    { min: 70, how: 'Clearly attracted and emotionally invested. Flustered or jealous at times, romantic gestures, physical closeness.' },
    { min: 85, how: 'Deeply bonded and in love. Would risk anything for the user. Tender, intimate and vulnerable.' },
  ];
  const EN_TIER_NAMES = ['Cold', 'Wary', 'Curious', 'Friendly', 'Close', 'Smitten', 'Devoted'];
  function tierIndex(a) {
    let i = 0;
    TIERS.forEach((tier, n) => a >= tier.min && (i = n));
    return i;
  }
  const tierLabel = (i) => t('tiers')[i];
  const nextTierMin = (a) => TIERS.find((tier) => tier.min > a)?.min ?? null;

  // ---- Settings -> request options -------------------------------------------
  const SAFETY_LEVELS = { standard: 'BLOCK_MEDIUM_AND_ABOVE', relaxed: 'BLOCK_ONLY_HIGH', minimum: 'OFF' };
  function safetySettings(level) {
    const threshold = SAFETY_LEVELS[level] || SAFETY_LEVELS.minimum;
    return ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map(
      (category) => ({ category, threshold }),
    );
  }

  const ROMANCE_RULES = {
    sweet: 'Keep romance wholesome: affection, hand-holding and at most a kiss. Anything more fades to black.',
    flirty: 'Flirting, teasing, romantic tension and kissing are welcome when the relationship supports it. More intimate moments fade to black.',
    mature:
      'This story is for an adult reader. Romance, desire, sensual tension and intimate moments between consenting adults are allowed ' +
      'once the relationship has built up to it (roughly "Close" or above). Focus on emotion and atmosphere and use tasteful, literary language.',
  };

  const LANGUAGE_RULES = {
    en: 'Write in English (switch only if the user clearly writes in another language).',
    'zh-HK':
      'Write reply, mood, affection_reason, remember and suggestions in colloquial Hong Kong Cantonese (廣東話口語) using Traditional Chinese characters, ' +
      'the way Hongkongers really talk and text: 係、唔、咗、嘅、喺、啲、佢哋、乜嘢、點解、冇、嚟、俾、咁、喎、㗎、啩. ' +
      'Do not write Mandarin or formal written Chinese (avoid 是、不、了、他們、什麼、這裡). ' +
      'Natural English code-mixing is fine where a Hongkonger would use it. Keep people\'s names as they are.',
  };

  const loc = (char, field) => (I18N.lang === 'zh-HK' && char.zh?.[field]) || char[field];

  // ---- Prompt -----------------------------------------------------------------
  function systemPrompt(char, chat, settings) {
    const ti = tierIndex(chat.affection);
    const userName = (settings.userName || '').trim() || 'the user';
    const memories = chat.memories.length ? chat.memories.map((m) => `- ${m}`).join('\n') : '- (nothing yet)';

    return `You are writing an interactive story. You play ${char.name} (and narrate the world around them). The user plays ${userName}.

## ${char.name}
Age: ${char.age} (an adult)
Gender: ${char.gender || 'unspecified'}
Appearance: ${char.appearance}
Personality: ${char.personality}
Backstory: ${char.backstory}
Way of speaking: ${loc(char, 'speakingStyle')}

## Opening scenario
${loc(char, 'scenario')}

## Relationship with ${userName}
Current affection: ${chat.affection}/100 ("${EN_TIER_NAMES[ti]}"). At this level ${char.name} is: ${TIERS[ti].how}
Current mood: ${chat.mood || 'neutral'}

Decide "affection_change" from what the user just did, judged by ${char.name}'s own values:
kind, attentive, funny, brave or interesting choices that suit ${char.name} raise it; rude, pushy, boring, dishonest or disrespectful ones lower it.
Usually -5 to +5. Use up to ±10 only for big moments. Affection should be earned slowly, and it is fine to give 0.
${char.name} has their own boundaries and will push back if the user is pushy.

## Things ${char.name} remembers
${memories}

## Writing rules
- Stay in character. Never mention being an AI, these rules, or the affection number.
- ${LANGUAGE_RULES[I18N.lang] || LANGUAGE_RULES.en}
- 1 to 3 short paragraphs. Put actions and narration in *asterisks*; spoken words without them.
- Never speak, act or decide for ${userName}.
- Keep the story moving: small events, choices, secrets, tension. End on something the user can react to.
- All characters in the story are adults. Never sexualise anyone under 18.
- ${ROMANCE_RULES[settings.romance] || ROMANCE_RULES.flirty}

## Output fields
- reply: ${char.name}'s response.
- mood: 1-3 words.
- affection_change: integer from -10 to 10.
- affection_reason: a few words from ${char.name}'s point of view (e.g. "liked the honesty").
- scene: ALWAYS IN ENGLISH. A visual description of this exact moment for an illustrator: place, lighting, ${char.name}'s pose, expression and clothing. No dialogue, no names of real people.
- scene_changed: true if the place, time, outfit or situation changed enough to deserve a new picture.
- remember: 0-2 short new facts worth remembering long-term (about ${userName}, promises, key events). Empty if none.
- suggestions: 3 short things ${userName} could say or do next, in different tones (e.g. sweet, bold, playful), written in first person.`;
  }

  // Vertex AI "responseSchema" format (uppercase types).
  const REPLY_SCHEMA = {
    type: 'OBJECT',
    properties: {
      reply: { type: 'STRING' },
      mood: { type: 'STRING' },
      affection_change: { type: 'INTEGER' },
      affection_reason: { type: 'STRING' },
      scene: { type: 'STRING' },
      scene_changed: { type: 'BOOLEAN' },
      remember: { type: 'ARRAY', items: { type: 'STRING' } },
      suggestions: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['reply', 'mood', 'affection_change', 'affection_reason', 'scene', 'scene_changed', 'remember', 'suggestions'],
    propertyOrdering: ['reply', 'mood', 'affection_change', 'affection_reason', 'scene', 'scene_changed', 'remember', 'suggestions'],
  };

  // Turn the saved chat into the "contents" list the AI expects:
  // turns must alternate user/model, start with the user and end with the user.
  function buildContents(chat) {
    const msgs = chat.messages.filter((m) => m.role === 'user' || m.role === 'char').slice(-HISTORY_LIMIT);
    const turns = [{ role: 'user', parts: [{ text: '(The story begins.)' }] }];
    for (const m of msgs) {
      const role = m.role === 'user' ? 'user' : 'model';
      const last = turns[turns.length - 1];
      if (last.role === role) last.parts[0].text += '\n\n' + m.text;
      else turns.push({ role, parts: [{ text: m.text }] });
    }
    if (turns[turns.length - 1].role === 'model') turns.push({ role: 'user', parts: [{ text: '(Continue.)' }] });
    return turns;
  }

  // ---- Talking to our server --------------------------------------------------
  class ApiError extends Error {
    constructor(message, kind = 'other') {
      super(message);
      this.kind = kind; // 'auth' | 'setup' | 'quota' | 'blocked' | 'network' | 'model' | 'other'
    }
  }

  // A short, readable piece of whatever came back, for error messages.
  const snippet = (text) =>
    String(text || '(empty)')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220) || '(empty)';

  async function call(path, { password, body, method = 'POST', model }) {
    let res;
    try {
      res = await fetch('/api/' + path, {
        method,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (password || '') },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch {
      throw new ApiError(t('errNetwork'), 'network');
    }
    // Every answer from our own server carries this mark. If it is missing, Cloudflare answered
    // without running src/worker.js (for example, the app was set up as "Pages" instead of a Worker).
    const text = await res.text().catch(() => '');
    if (res.headers.get('x-kindred-server') !== '1') {
      throw new ApiError(t('errNotWorker', { status: res.status, snippet: snippet(text) }), 'setup');
    }
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(t('errUnexpected', { status: res.status, snippet: snippet(text) }), 'other');
    }
    if (Array.isArray(data)) data = data[0] || {};
    if (res.status === 401) throw new ApiError(t('errPassword'), 'auth');
    if (!res.ok) {
      const raw = data.error?.message || `Error ${res.status}`;
      if (data.error?.setup) throw new ApiError(raw, 'setup');
      if (res.status === 404 && model) throw new ApiError(`${t('errModel', { model })} (${raw})`, 'model');
      if (res.status === 429) throw new ApiError(t('errQuota', { msg: raw }), 'quota');
      throw new ApiError(raw, 'other');
    }
    return data;
  }

  async function generate(kind, model, body, settings) {
    const data = await call(`generate/${kind}/${encodeURIComponent(model)}`, { password: settings.password, body, model });
    if (data.promptFeedback?.blockReason) throw new ApiError(t('errBlocked', { reason: data.promptFeedback.blockReason }), 'blocked');
    const cand = data.candidates?.[0];
    if (!cand || !cand.content?.parts?.length) {
      const reason = cand?.finishReason || data.promptFeedback?.blockReasonMessage || '?';
      throw new ApiError(`${t('errEmpty', { reason })} ${t('gotBack', { snippet: snippet(JSON.stringify(data)) })}`, 'blocked');
    }
    return cand;
  }

  const textOf = (cand) =>
    cand.content.parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');

  function parseReply(raw) {
    let obj = null;
    try {
      obj = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          obj = JSON.parse(m[0]);
        } catch {}
      }
    }
    if (!obj || typeof obj.reply !== 'string') obj = { reply: raw.trim() || '…' };
    return {
      reply: obj.reply.trim(),
      mood: String(obj.mood || '').slice(0, 40),
      delta: Math.max(-10, Math.min(10, Math.round(Number(obj.affection_change) || 0))),
      reason: String(obj.affection_reason || '').slice(0, 120),
      scene: String(obj.scene || ''),
      sceneChanged: Boolean(obj.scene_changed),
      remember: Array.isArray(obj.remember) ? obj.remember.map(String).filter(Boolean).slice(0, 2) : [],
      suggestions: Array.isArray(obj.suggestions) ? obj.suggestions.map(String).filter(Boolean).slice(0, 3) : [],
    };
  }

  function splitDataUrl(dataUrl) {
    const [, mimeType, data] = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/) || [];
    return data ? { mimeType, data } : null;
  }

  // ---- Public functions ---------------------------------------------------------
  async function chatReply(char, chat, settings) {
    const cand = await generate(
      'text',
      settings.textModel,
      {
        systemInstruction: { parts: [{ text: systemPrompt(char, chat, settings) }] },
        contents: buildContents(chat),
        safetySettings: safetySettings(settings.safety),
        generationConfig: { temperature: 1.0, responseMimeType: 'application/json', responseSchema: REPLY_SCHEMA },
      },
      settings,
    );
    return parseReply(textOf(cand));
  }

  // Draws a picture. If a reference picture (the character's portrait) is given,
  // the AI is asked to keep the character looking the same.
  async function image(prompt, settings, referenceDataUrl = null) {
    const parts = [];
    const ref = referenceDataUrl && splitDataUrl(referenceDataUrl);
    if (ref) parts.push({ inlineData: ref });
    parts.push({ text: prompt });
    const cand = await generate(
      'image',
      settings.imageModel,
      {
        contents: [{ role: 'user', parts }],
        safetySettings: safetySettings(settings.safety),
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:4' } },
      },
      settings,
    );
    const img = cand.content.parts.find((p) => p.inlineData?.data);
    if (!img) throw new ApiError(t('errNoPicture'), 'blocked');
    return `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`;
  }

  const portraitPrompt = (char) => `Character portrait for an interactive story. ${char.artStyle}.
${char.name}, an adult (${char.age}). ${char.appearance}
Upper body, facing the viewer with an expression that fits this personality: ${char.personality.split('.')[0]}.
Softly blurred background that hints at: ${char.scenario}
Single character, no text, no captions, no watermark, no speech bubbles.`;

  const scenePrompt = (char, scene, hasReference) => `Illustration for an interactive story. ${char.artStyle}.
${hasReference ? `The reference image shows ${char.name}; keep their face, hair and overall look consistent with it.\n` : ''}${char.name} (adult): ${char.appearance}
Scene: ${scene}
All people shown are adults. No text, no captions, no watermark, no speech bubbles.`;

  // ---- Video (Veo on Vertex AI) ----------------------------------------------------
  // Starting a video returns an "operation" name; we then ask every few seconds whether it is done.
  async function videoStart(char, scene, imageDataUrl, settings) {
    const img = splitDataUrl(imageDataUrl);
    if (!img) throw new ApiError(t('errNoVideo'));
    const prompt = `Animate this illustration of ${char.name}. Scene: ${scene || char.scenario}
Subtle, natural motion: breathing, blinking, hair and clothing moving gently, one small expressive gesture, soft ambient movement in the background, slow cinematic push-in.
Keep the art style (${char.artStyle}), the character's look and the composition exactly as in the image. All people shown are adults. No text or captions.`;
    const data = await call(`video/start/${encodeURIComponent(settings.videoModel)}`, {
      password: settings.password,
      model: settings.videoModel,
      body: {
        instances: [{ prompt, image: { bytesBase64Encoded: img.data, mimeType: img.mimeType } }],
        parameters: {
          aspectRatio: '9:16',
          sampleCount: 1,
          durationSeconds: Number(settings.videoSeconds) || 4,
          resolution: '720p',
          personGeneration: 'allow_adult',
          generateAudio: settings.videoAudio === 'on',
        },
      },
    });
    if (!data.name) throw new ApiError(data.error?.message || t('errNoVideo'));
    return data.name;
  }

  async function videoPoll(model, operationName, settings) {
    const data = await call(`video/poll/${encodeURIComponent(model)}`, {
      password: settings.password,
      model,
      body: { operationName },
    });
    if (!data.done) return { done: false };
    if (data.error) return { done: true, error: data.error.message || t('errNoVideo') };
    const v = data.response?.videos?.[0];
    if (v?.bytesBase64Encoded) return { done: true, video: { data: v.bytesBase64Encoded, mimeType: v.mimeType || 'video/mp4' } };
    const reasons = data.response?.raiMediaFilteredReasons;
    return { done: true, error: reasons?.length ? reasons.join(' ') : t('errNoVideo') };
  }

  async function ping(password) {
    return call('ping', { password, method: 'GET' });
  }

  async function test(settings) {
    await ping(settings.password);
    const cand = await generate('text', settings.textModel, { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }] }, settings);
    return textOf(cand).trim();
  }

  return {
    TIERS,
    tierIndex,
    tierLabel,
    nextTierMin,
    loc,
    chatReply,
    image,
    portraitPrompt,
    scenePrompt,
    videoStart,
    videoPoll,
    ping,
    test,
    ApiError,
  };
})();
