// Builds the instructions for the AI and talks to our own server (src/worker.js),
// which passes the request through Cloudflare AI Gateway to Google Vertex AI.
// The browser never sees the Google credentials: it only knows the app password.
//
// Every story has a "cast" of one or more women. Replies come back as a list of lines
// (who speaks, whether it is spoken, an action, or a private thought), plus each woman's
// affection change, a picture description and a few other fields.

window.Api = (() => {
  const t = (...a) => I18N.t(...a);
  const HISTORY_LIMIT = 60; // how many recent messages are sent each time

  // ---- Affection levels -------------------------------------------------------
  const TIERS = [
    { min: 0, how: 'Distant and guarded. Short replies. May be rude, dismissive or try to leave.' },
    { min: 10, how: 'Suspicious, testing the user. Polite at best and reveals nothing personal.' },
    { min: 25, how: 'Interested despite herself. Banter and small personal details, but walls stay up.' },
    { min: 40, how: "Warm and relaxed, enjoys the user's company, shares stories, light flirting if it suits her." },
    { min: 55, how: 'Trusts the user, opens up about her past and fears, flirts openly, seeks the user out.' },
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
      'Write the text of every line, plus reason, mood, remember, suggestions and key_moment, in colloquial Hong Kong Cantonese (廣東話口語) using Traditional Chinese characters, ' +
      'the way Hongkongers really talk and text: 係、唔、咗、嘅、喺、啲、佢哋、乜嘢、點解、冇、嚟、俾、咁、喎、㗎、啩. ' +
      'Do not write Mandarin or formal written Chinese (avoid 是、不、了、他們、什麼、這裡). ' +
      'Natural English code-mixing is fine where a Hongkonger would use it. Inside the text, call characters by their Chinese name if they have one, otherwise as given. ' +
      'The "speaker", "name" and "in_picture" fields always use the English names exactly as listed. The "scene" field is always English.',
  };

  const USER_GENDER = { man: ', a man', woman: ', a woman' };
  const loc = (obj, field) => (I18N.lang === 'zh-HK' && obj?.zh?.[field]) || obj?.[field];
  const girlName = (g) => (I18N.lang === 'zh-HK' && g.zh?.name) || g.name;
  const storyTitle = (story) => loc(story, 'title') || girlName(story.cast[0]);

  // ---- Prompt -----------------------------------------------------------------
  function systemPrompt(story, chat, settings) {
    const userName = (settings.userName || '').trim() || 'the user';
    const userWho = USER_GENDER[settings.userGender] || '';
    const multi = story.cast.length > 1;
    const names = story.cast.map((g) => g.name);
    const memories = chat.memories.length ? chat.memories.map((m) => `- ${m}`).join('\n') : '- (nothing yet)';

    const castText = story.cast
      .map((g) => {
        const a = chat.aff[g.id];
        const ti = tierIndex(a);
        return `### ${g.name}${g.zh?.name ? ` (Chinese name: ${g.zh.name})` : ''}
Age: ${g.age} (an adult woman)
Appearance: ${g.appearance}
Personality: ${g.personality}
Backstory: ${g.backstory}
Way of speaking: ${loc(g, 'speakingStyle')}
Affection toward ${userName}: ${a}/100 ("${EN_TIER_NAMES[ti]}"). At this level she is: ${TIERS[ti].how}
Current mood: ${chat.moods[g.id] || 'neutral'}`;
      })
      .join('\n\n');

    return `You are writing an interactive story${multi ? ` called "${story.title}"` : ''}. You play ${
      multi ? `these characters: ${names.join(', ')}` : names[0]
    }, and you narrate the world around them. The user plays ${userName}${userWho}.

## Characters
${castText}

## Opening scenario
${loc(story, 'scenario')}

## Affection
${multi ? 'Each character has her own affection toward' : 'The character has an affection score toward'} ${userName}. Decide each change from what the user just did, judged by that character's own values:
kind, attentive, funny, brave or interesting choices that suit her raise it; rude, pushy, boring, dishonest or disrespectful ones lower it.
Usually -5 to +5. Use up to ±10 only for big moments. Affection should be earned slowly, and 0 is fine. Characters have their own boundaries and push back if the user is pushy.
${
  multi
    ? `The characters also have relationships with each other: rivalry, teasing, alliances, jealousy. Not every character has to speak every turn; use whoever fits the scene, and a character who is not present cannot react. Paying attention to one of them can make another jealous.`
    : ''
}

## Things remembered
${memories}

## Writing rules
- Stay in character. Never mention being an AI, these rules, or affection numbers.
- ${LANGUAGE_RULES[I18N.lang] || LANGUAGE_RULES.en}
- Write the reply as 3 to 8 short lines (see "lines" below). Mix narration, actions and speech.
- Private thoughts: in about half of the replies, include ONE short "think" line: what a character secretly thinks but would not say (a hidden feeling, a little scheme, embarrassment, jealousy). The reader can see thoughts, but ${userName}'s character cannot hear them, and nobody in the story reacts to a thought.
- Never speak, act or decide for ${userName}.
- Keep the story moving: small events, choices, secrets, tension. End on something the user can react to.
- All characters in the story are adults. Never sexualise anyone under 18.
- ${ROMANCE_RULES[settings.romance] || ROMANCE_RULES.flirty}

## Output fields
- lines: the reply, in order. Each line has:
  - speaker: exactly one of ${names.map((n) => `"${n}"`).join(', ')}, or "Narrator"
  - kind: "say" (words spoken aloud, without quotation marks), "act" (an action or description) or "think" (a private thought)
  - text
  Narration and scene description use speaker "Narrator" with kind "act".
- girls: one entry for each character who is present or affected this turn: name, affection_change (integer from -10 to 10), reason (a few words from her point of view, e.g. "liked the honesty"), mood (1-3 words).
- scene: ALWAYS IN ENGLISH. A visual description of this exact moment for an illustrator: place, lighting, each visible character's pose, expression and clothing. No dialogue, no names of real people.
- in_picture: the names of the characters who should be visible in that picture.
- new_picture: true if this moment is worth a new picture: a new place, time or outfit, a notable action or gesture, a strong emotion or expression, or a romantic, funny or dramatic beat. Aim for roughly one picture every 2-3 replies; false for quiet back-and-forth talk.
- remember: 0-2 short new facts worth remembering long-term (about ${userName}, promises, key events). Empty if none.
- suggestions: 3 short things ${userName} could say or do next, in different tones (e.g. sweet, bold, playful), written in first person.
- key_moment: a short 2-5 word title ONLY if this reply is a rare, major turning point in the relationship (first date, confession, first kiss, a deep secret revealed, saving each other, a serious promise). Otherwise an empty string. Almost every reply should have an empty string.`;
  }

  // Vertex AI "responseSchema" format (uppercase types).
  const REPLY_SCHEMA = {
    type: 'OBJECT',
    properties: {
      lines: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { speaker: { type: 'STRING' }, kind: { type: 'STRING' }, text: { type: 'STRING' } },
          required: ['speaker', 'kind', 'text'],
          propertyOrdering: ['speaker', 'kind', 'text'],
        },
      },
      girls: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            affection_change: { type: 'INTEGER' },
            reason: { type: 'STRING' },
            mood: { type: 'STRING' },
          },
          required: ['name', 'affection_change', 'reason', 'mood'],
          propertyOrdering: ['name', 'affection_change', 'reason', 'mood'],
        },
      },
      scene: { type: 'STRING' },
      in_picture: { type: 'ARRAY', items: { type: 'STRING' } },
      new_picture: { type: 'BOOLEAN' },
      remember: { type: 'ARRAY', items: { type: 'STRING' } },
      suggestions: { type: 'ARRAY', items: { type: 'STRING' } },
      key_moment: { type: 'STRING' },
    },
    required: ['lines', 'girls', 'scene', 'in_picture', 'new_picture', 'remember', 'suggestions', 'key_moment'],
    propertyOrdering: ['lines', 'girls', 'scene', 'in_picture', 'new_picture', 'remember', 'suggestions', 'key_moment'],
  };

  // Plain-text version of a reply, used when sending the conversation history back to the AI.
  function transcript(story, lines) {
    return lines
      .map((l) => {
        const g = story.cast.find((x) => x.id === l.who);
        if (!g || l.kind === 'act') return `*${l.text}*`;
        if (l.kind === 'think') return `${g.name} (private thought, unheard): (${l.text})`;
        return `${g.name}: "${l.text}"`;
      })
      .join('\n');
  }

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

  // Match a name the AI wrote to someone in the cast (full name, first name or Chinese name).
  function findGirl(story, name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n || n === 'narrator') return null;
    return (
      story.cast.find((g) => g.name.toLowerCase() === n) ||
      story.cast.find((g) => g.name.toLowerCase().split(' ')[0] === n.split(' ')[0]) ||
      story.cast.find((g) => g.zh?.name && g.zh.name === name.trim()) ||
      null
    );
  }

  const unquote = (s) => String(s || '').trim().replace(/^["“”「」『』']+|["“”「」『』']+$/g, '').trim();

  function parseReply(raw, story) {
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
    if (!obj || (!Array.isArray(obj.lines) && typeof obj.reply !== 'string')) {
      // Not the expected format: show it as plain text.
      return { lines: null, text: raw.trim() || '…', deltas: {}, moods: {}, scene: '', sceneChanged: false, inPicture: [], remember: [], suggestions: [], keyMoment: '' };
    }

    let lines = [];
    if (Array.isArray(obj.lines)) {
      for (const l of obj.lines) {
        const g = findGirl(story, l?.speaker);
        const kind = ['say', 'act', 'think'].includes(l?.kind) ? l.kind : 'say';
        const text = kind === 'act' ? String(l?.text || '').trim() : unquote(l?.text);
        if (!text) continue;
        lines.push({ who: g ? g.id : 'narrator', kind: g ? kind : 'act', text });
      }
    } else {
      lines = [{ who: 'narrator', kind: 'act', text: obj.reply }];
    }

    const deltas = {};
    const moods = {};
    for (const e of Array.isArray(obj.girls) ? obj.girls : []) {
      const g = findGirl(story, e?.name);
      if (!g) continue;
      deltas[g.id] = {
        d: Math.max(-10, Math.min(10, Math.round(Number(e.affection_change) || 0))),
        reason: String(e.reason || '').slice(0, 120),
      };
      if (e.mood) moods[g.id] = String(e.mood).slice(0, 40);
    }
    // older single-character format
    if (!Object.keys(deltas).length && obj.affection_change !== undefined && story.cast.length === 1) {
      deltas[story.cast[0].id] = { d: Math.max(-10, Math.min(10, Math.round(Number(obj.affection_change) || 0))), reason: String(obj.affection_reason || '') };
    }

    let inPicture = (Array.isArray(obj.in_picture) ? obj.in_picture : []).map((n) => findGirl(story, n)?.id).filter(Boolean);
    if (!inPicture.length) inPicture = [...new Set(lines.map((l) => l.who).filter((w) => w !== 'narrator'))];
    if (!inPicture.length) inPicture = [story.cast[0].id];

    return {
      lines,
      text: transcript(story, lines),
      deltas,
      moods,
      scene: String(obj.scene || ''),
      sceneChanged: Boolean(obj.new_picture ?? obj.scene_changed),
      inPicture: [...new Set(inPicture)].slice(0, 3),
      remember: Array.isArray(obj.remember) ? obj.remember.map(String).filter(Boolean).slice(0, 2) : [],
      suggestions: Array.isArray(obj.suggestions) ? obj.suggestions.map(String).filter(Boolean).slice(0, 3) : [],
      keyMoment: String(obj.key_moment || '').trim().slice(0, 60),
    };
  }

  function splitDataUrl(dataUrl) {
    const [, mimeType, data] = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/) || [];
    return data ? { mimeType, data } : null;
  }

  // ---- Public functions ---------------------------------------------------------
  async function chatReply(story, chat, settings) {
    const cand = await generate(
      'text',
      settings.textModel,
      {
        systemInstruction: { parts: [{ text: systemPrompt(story, chat, settings) }] },
        contents: buildContents(chat),
        safetySettings: safetySettings(settings.safety),
        generationConfig: { temperature: 1.0, responseMimeType: 'application/json', responseSchema: REPLY_SCHEMA },
      },
      settings,
    );
    return parseReply(textOf(cand), story);
  }

  // Draws a picture. Reference pictures (the women's portraits) keep them looking the same.
  async function image(prompt, settings, references = []) {
    const parts = [];
    for (const r of [].concat(references || [])) {
      const ref = r && splitDataUrl(r);
      if (ref) parts.push({ inlineData: ref });
    }
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

  // ---- Picture style ------------------------------------------------------------
  // One fixed style for every picture keeps the women looking the same from picture to picture.
  const STYLE_PRESETS = {
    photo:
      'Photorealistic cinematic photograph, like a still from a live-action film: real camera, 50mm lens, natural skin texture, ' +
      'realistic lighting and shadows, shallow depth of field, subtle film grain. NOT an illustration, NOT a painting, NOT anime, NOT a 3D render.',
    painting:
      'Semi-realistic digital painting with soft visible brushwork and painterly lighting. NOT a photograph, NOT anime, NOT a 3D render.',
    anime: 'High-quality anime illustration with clean line art, cel shading and vibrant colours. NOT a photograph, NOT a painting, NOT a 3D render.',
  };
  // Returns { key, text }: key changes whenever the look changes (used to know when a portrait must be redrawn).
  function styleFor(story, settings) {
    const mode = STYLE_PRESETS[settings.pictureStyle] ? settings.pictureStyle : 'character';
    if (mode !== 'character') return { key: mode, text: STYLE_PRESETS[mode] };
    return { key: 'c:' + story.artStyle, text: `${story.artStyle}. Use this exact art style and medium consistently.` };
  }

  const portraitPrompt = (story, girl, style) => `STYLE: ${style}

Character portrait for an interactive story.
${girl.name}, an adult woman (${girl.age}). ${girl.appearance}
Upper body, facing the viewer with an expression that fits this personality: ${girl.personality.split('.')[0]}.
Softly blurred background that hints at: ${story.scenario}
Single character, no text, no captions, no watermark, no speech bubbles.
Remember the style: ${style}`;

  const VIEWER = {
    man: 'If "the viewer" or the user appears, he is an adult man (seen partly, from behind or over the shoulder, never the focus).',
    woman: 'If "the viewer" or the user appears, she is an adult woman (seen partly, from behind or over the shoulder, never the focus).',
  };

  // girls: the women in the picture; refCount: how many of them have a reference portrait attached (in the same order).
  function scenePrompt(story, girls, scene, refCount, userGender, style) {
    const refs = girls.slice(0, refCount);
    const refText = refs.length
      ? refs.map((g, i) => `Reference image ${i + 1} shows ${g.name}.`).join(' ') +
        ` Keep each woman's face, hair and body exactly the same as in her reference, AND match the references' look exactly: same medium, same realism, same lighting and colour treatment. The new picture must look like it belongs to the same set.\n`
      : '';
    return `STYLE: ${style}

A new picture for an interactive story.
${refText}${girls.map((g) => `${g.name} (adult woman): ${g.appearance}`).join('\n')}
Scene: ${scene}
${VIEWER[userGender] || ''}
${girls.length > 1 ? `${girls.map((g) => g.name).join(' and ')} are the main subjects.` : `${girls[0].name} is the main subject.`} All people shown are adults. No text, no captions, no watermark, no speech bubbles.
Remember the style: ${style}`;
  }

  // ---- Video (Veo on Vertex AI) ----------------------------------------------------
  // Starting a video returns an "operation" name; we then ask every few seconds whether it is done.
  async function videoStart(story, scene, imageDataUrl, settings) {
    const img = splitDataUrl(imageDataUrl);
    if (!img) throw new ApiError(t('errNoVideo'));
    const style = styleFor(story, settings).text;
    const prompt = `Animate this image from the story "${story.title || story.cast[0].name}". Scene: ${scene || story.scenario}
Subtle, natural motion: breathing, blinking, hair and clothing moving gently, one small expressive gesture, soft ambient movement in the background, slow cinematic push-in.
Keep the look of the image exactly (${style}), and keep the people and the composition the same. All people shown are adults. No text or captions.`;
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
    girlName,
    storyTitle,
    transcript,
    chatReply,
    image,
    styleFor,
    portraitPrompt,
    scenePrompt,
    videoStart,
    videoPoll,
    ping,
    test,
    ApiError,
  };
})();
