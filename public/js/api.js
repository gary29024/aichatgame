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

  // ---- Relationship levels ----------------------------------------------------
  // Each woman has relationship points. Every 100 points is one level, and a good reply
  // usually adds only 1-4, so each level takes a while to build up.
  const POINTS_PER_LEVEL = 100;
  const LEVELS = [
    { name: 'Stranger', how: 'Guarded and a little distant. Polite or prickly, keeps personal things to herself. No flirting.' },
    { name: 'Acquaintance', how: 'Curious about the user. Small talk, light teasing, reveals only small harmless details.' },
    { name: 'Friend', how: "Warm and relaxed, enjoys the user's company, jokes, shares stories, a little playful flirting if it suits her." },
    { name: 'Close friend', how: 'Trusts the user and opens up about her past and fears. Small touches; notices the user romantically but hides it.' },
    { name: 'Crush', how: 'Flirts openly, blushes, gets jealous, wants time alone with the user. A first kiss can happen if the moment is right.' },
    { name: 'Lover', how: 'In a romantic relationship with the user. Affectionate, kisses freely; intimacy is possible within the romance rules.' },
    { name: 'Soulmate', how: 'Deeply in love and devoted. Tender, vulnerable, would risk anything for the user.' },
  ];
  const MAX_POINTS = LEVELS.length * POINTS_PER_LEVEL;
  function levelOf(points) {
    const p = Math.max(0, Math.min(MAX_POINTS, Math.round(points || 0)));
    const i = Math.min(LEVELS.length - 1, Math.floor(p / POINTS_PER_LEVEL));
    return { i, lv: i + 1, into: p - i * POINTS_PER_LEVEL, floor: i * POINTS_PER_LEVEL };
  }
  const levelName = (i) => t('levels')[i] || LEVELS[i].name;

  // ---- Settings -> request options -------------------------------------------
  const SAFETY_LEVELS = { standard: 'BLOCK_MEDIUM_AND_ABOVE', relaxed: 'BLOCK_ONLY_HIGH', minimum: 'OFF' };
  function safetySettings(level) {
    const threshold = SAFETY_LEVELS[level] || SAFETY_LEVELS.minimum;
    return ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map(
      (category) => ({ category, threshold }),
    );
  }

  const ROMANCE_RULES = {
    sweet: 'Keep romance wholesome: affection, hand-holding and at most a kiss (from "Lover" level). Anything more fades to black.',
    flirty: 'Flirting, teasing and romantic tension are welcome; kissing from "Crush" level. Anything more intimate fades to black.',
    mature:
      'This story is for an adult reader. It can be steamy but never graphic: flirting, desire, tension, kissing, touching and implied intimacy between consenting adults ' +
      'are fine once the character\'s level allows it (kissing from "Crush", intimacy from "Lover"). When a scene would become sexually explicit, cut away ' +
      '(fade to black) and continue afterwards, for example the next morning. Never describe sex acts or genitals in detail.',
  };

  const LANGUAGE_RULES = {
    en: 'Write in English (switch only if the user clearly writes in another language).',
    'zh-HK':
      'Write the text of every line, plus reason, mood, remember, suggestions and key_moment, in colloquial Hong Kong Cantonese (廣東話口語) using Traditional Chinese characters, ' +
      'the way Hongkongers really talk and text: 係、唔、咗、嘅、喺、啲、佢哋、乜嘢、點解、冇、嚟、俾、咁、喎、㗎、啩. ' +
      'Do not write Mandarin or formal written Chinese (avoid 是、不、了、他們、什麼、這裡). ' +
      'Natural English code-mixing is fine where a Hongkonger would use it. Inside the text, call characters by their Chinese name if they have one, otherwise as given. ' +
      'The "speaker", "name" and "in_picture" fields always use the English names exactly as listed. The "scene", "location" and "outfit" fields are always English.',
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

    const state = chat.state || {};
    const castText = story.cast
      .map((g) => {
        const L = levelOf(chat.aff[g.id]);
        return `### ${g.name}${g.zh?.name ? ` (Chinese name: ${g.zh.name})` : ''}
Age: ${g.age} (an adult woman)
Appearance: ${g.appearance}
Personality: ${g.personality}
Backstory: ${g.backstory}
Way of speaking: ${loc(g, 'speakingStyle')}
Relationship with ${userName}: level ${L.lv} of ${LEVELS.length}, "${LEVELS[L.i].name}" (${L.into}% of the way to the next level). At this level she is: ${LEVELS[L.i].how}
Current mood: ${chat.moods[g.id] || 'neutral'}
Currently wearing: ${state.outfits?.[g.id] || 'the clothes in her appearance'}`;
      })
      .join('\n\n');

    return `You are writing an interactive story${multi ? ` called "${story.title}"` : ''}. You play ${
      multi ? `these characters: ${names.join(', ')}` : names[0]
    }, and you narrate the world around them. The user plays ${userName}${userWho}.

## Characters
${castText}

## Opening scenario
${loc(story, 'scenario')}

## Current place
${state.location || 'as in the opening scenario'}

## Relationship pace
Relationships grow slowly, one level at a time. Stay true to each character's current level: do not skip ahead (no confessions, kisses or intimacy before her level allows it), even if the user pushes.
For each character present, decide "affection_change" from what the user just did, judged by her own values:
usually +1 to +4 for a good moment, 0 for ordinary talk, negative for rude, pushy, dishonest, boring or disrespectful behaviour. Use +6 to +10 only for rare, big moments. Characters have their own boundaries and push back if the user is pushy.
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
- scene: ALWAYS IN ENGLISH. A picture of exactly the moment this reply ends on, so the picture matches the text: the same place, time of day and lighting, who is there, what each person is doing, their poses and expressions, and what each is wearing (everyone is always clothed; lingerie or sleepwear is fine for intimate moments, never nudity). Show the women looking their most beautiful. Concrete visual details only; no dialogue, no names of real people.
- in_picture: the names of the characters visible in that picture.
- location: ALWAYS IN ENGLISH. Where the story is now, in a few words (e.g. "Jade's bar, 2 a.m., heavy rain").
- outfits: ALWAYS IN ENGLISH. For each character present, what she is wearing right now. Keep outfits the same as before unless the story changes them.
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
      location: { type: 'STRING' },
      outfits: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { name: { type: 'STRING' }, outfit: { type: 'STRING' } },
          required: ['name', 'outfit'],
          propertyOrdering: ['name', 'outfit'],
        },
      },
    },
    required: ['lines', 'girls', 'scene', 'in_picture', 'new_picture', 'remember', 'suggestions', 'key_moment', 'location', 'outfits'],
    propertyOrdering: ['lines', 'girls', 'location', 'outfits', 'scene', 'in_picture', 'new_picture', 'remember', 'suggestions', 'key_moment'],
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
      return { lines: null, text: raw.trim() || '…', deltas: {}, moods: {}, scene: '', sceneChanged: false, inPicture: [], remember: [], suggestions: [], keyMoment: '', location: '', outfits: {} };
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
      location: String(obj.location || '').trim().slice(0, 160),
      outfits: Object.fromEntries(
        (Array.isArray(obj.outfits) ? obj.outfits : [])
          .map((o) => [findGirl(story, o?.name)?.id, String(o?.outfit || '').trim().slice(0, 240)])
          .filter(([id, outfit]) => id && outfit),
      ),
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
  // Every woman is drawn as very beautiful, in every picture.
  const BEAUTY =
    'Every woman shown is strikingly beautiful in the style of Hong Kong, Japanese and Korean film stars and idols: ' +
    'a delicate, harmonious face, clear luminous skin, bright expressive eyes, glossy hair, a slim, elegant and attractive figure, ' +
    'and soft natural makeup. Flattering light and angles. ' +
    'Keep any distinctive features from her description (scars, tattoos, freckles); they only add to her beauty.';
  const LOOK_VERSION = 'b3'; // bump to redraw every portrait once when the look instructions change

  // Returns { key, text }: key changes whenever the look changes (used to know when a portrait must be redrawn).
  function styleFor(story, settings) {
    const mode = STYLE_PRESETS[settings.pictureStyle] ? settings.pictureStyle : 'character';
    const maker = `${LOOK_VERSION}:` + (settings.imageProvider === 'fal' ? `fal:${falModelOf(settings)}:` : '');
    if (mode !== 'character') return { key: maker + mode, text: STYLE_PRESETS[mode] };
    return { key: maker + 'c:' + story.artStyle, text: `${story.artStyle}. Use this exact art style and medium consistently.` };
  }

  const portraitPrompt = (story, girl, style) => `STYLE: ${style}

Character portrait for an interactive story.
${girl.name}, an adult woman (${girl.age}). ${girl.appearance}
${BEAUTY}
Upper body, facing the viewer with an expression that fits this personality: ${girl.personality.split('.')[0]}.
Softly blurred background that hints at: ${story.scenario}
Single character, no text, no captions, no watermark, no speech bubbles.
Remember the style: ${style}`;

  const VIEWER = {
    man: 'If "the viewer" or the user appears, he is an adult man (seen partly, from behind or over the shoulder, never the focus).',
    woman: 'If "the viewer" or the user appears, she is an adult woman (seen partly, from behind or over the shoulder, never the focus).',
  };

  // girls: the women in the picture; refCount: how many of them have a reference portrait attached (in the same order).
  // ctx: { outfits: {id: outfit}, location, text } so the picture matches the reply.
  function scenePrompt(story, girls, scene, refCount, userGender, style, ctx = {}) {
    const refs = girls.slice(0, refCount);
    const refText = refs.length
      ? refs.map((g, i) => `Reference image ${i + 1} shows ${g.name}.`).join(' ') +
        ` Use the references ONLY for each woman's face, hair and body type, and for the overall look (same medium, realism, lighting and colour treatment, so the picture belongs to the same set). ` +
        `Clothing, pose, place and action come from the description below, not from the references.\n`
      : '';
    const who = girls
      .map((g) => {
        const outfit = ctx.outfits?.[g.id];
        return `${g.name} (adult woman): ${g.appearance}${outfit ? `\nRight now ${g.name} is wearing: ${outfit} (this replaces the clothes described above).` : ''}`;
      })
      .join('\n');
    return `STYLE: ${style}

A new picture for an interactive story. It must show exactly this moment of the story.
${refText}${who}
Scene: ${scene}${ctx.location ? `\nPlace: ${ctx.location}` : ''}${ctx.text ? `\nWhat is happening in the story right now (for context): ${String(ctx.text).slice(0, 700)}` : ''}
${VIEWER[userGender] || ''}
${BEAUTY}
Everyone is clothed. Lingerie or sleepwear is fine for intimate moments; no nudity.
${girls.length > 1 ? `${girls.map((g) => g.name).join(' and ')} are the main subjects.` : `${girls[0].name} is the main subject.`} All people shown are adults. No text, no captions, no watermark, no speech bubbles.
Remember the style: ${style}`;
  }

  // ---- Open-source pictures (SDXL models on fal.ai) ---------------------------------
  // SDXL models like short, descriptive prompts. A face reference (IP-Adapter) keeps a woman's face the same.
  const FAL_MODELS = {
    dreamshaper: 'Lykon/dreamshaper-xl-1-0',
    animagine: 'cagliostrolab/animagine-xl-4.0',
    realvis: 'SG161222/RealVisXL_V5.0',
  };
  const falModelOf = (settings) =>
    settings.falModel === 'custom' ? String(settings.falCustomModel || '').trim() || FAL_MODELS.dreamshaper : FAL_MODELS[settings.falModel] || FAL_MODELS.dreamshaper;
  const SD_STYLE = {
    photo: 'photorealistic, cinematic film still, 35mm photograph, natural skin texture, soft natural light',
    painting: 'semi-realistic digital painting, soft brushwork, painterly lighting',
    anime: 'anime illustration, clean lineart, cel shading, vibrant colors',
  };
  // Things the picture must never contain, plus common quality problems.
  const SD_NEGATIVE =
    'nude, naked, nipples, topless, nsfw, explicit, sex, genitals, child, kid, teen, underage, loli, ' +
    'lowres, worst quality, low quality, bad anatomy, bad hands, extra fingers, missing fingers, deformed face, blurry, text, watermark, signature, logo, ' +
    'ugly, plain, unattractive, asymmetrical face, bad skin, old, aged';
  const SD_VIEWER = { man: 'the viewer is an adult man, seen from behind or partly out of frame', woman: 'the viewer is an adult woman, seen from behind or partly out of frame' };

  function sdPrompt(story, girls, scene, settings, ctx = {}) {
    const style = SD_STYLE[settings.pictureStyle] || story.artStyle;
    const count = girls.length === 1 ? '1girl, solo, adult woman' : `${girls.length}girls, adult women`;
    // (text:1.3) gives the current outfit more weight than the clothes in the base description
    const who = girls
      .map((g) => `${g.appearance.replace(/\s+/g, ' ')}${ctx.outfits?.[g.id] ? `, (wearing ${ctx.outfits[g.id]}:1.3)` : ''}`)
      .join(' | ');
    const viewer = /viewer/i.test(scene) ? SD_VIEWER[settings.userGender] || '' : '';
    const beauty =
      'very beautiful east asian woman, looks like a hong kong actress, japanese actress or korean idol, delicate face, clear luminous skin, ' +
      'bright expressive eyes, glossy hair, slim attractive figure, soft natural makeup, flattering light';
    return [style, count, beauty, who, scene, ctx.location, viewer, 'masterpiece, best quality, highly detailed, beautiful detailed eyes'].filter(Boolean).join(', ');
  }

  async function falImage(prompt, settings, reference = null) {
    const input = {
      model_name: falModelOf(settings),
      prompt,
      negative_prompt: SD_NEGATIVE,
      image_size: 'portrait_4_3',
      num_inference_steps: 30,
      guidance_scale: 6.5,
      prompt_weighting: true, // allows prompts longer than 77 tokens
      enable_safety_checker: true, // fal blocks nudity
      num_images: 1,
      image_format: 'jpeg',
    };
    if (reference) {
      input.ip_adapter = [
        {
          ip_adapter_image_url: reference,
          path: 'h94/IP-Adapter',
          model_subfolder: 'sdxl_models',
          weight_name: 'ip-adapter-plus-face_sdxl_vit-h.safetensors',
          scale: 0.7,
        },
      ];
      input.image_encoder_path = 'h94/IP-Adapter';
      input.image_encoder_subfolder = 'models/image_encoder';
    }
    let res;
    try {
      res = await fetch('/api/fal/fal-ai/lora', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (settings.password || '') },
        body: JSON.stringify(input),
      });
    } catch {
      throw new ApiError(t('errNetwork'), 'network');
    }
    if (res.headers.get('x-kindred-server') !== '1') {
      throw new ApiError(t('errNotWorker', { status: res.status, snippet: snippet(await res.text().catch(() => '')) }), 'setup');
    }
    if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new ApiError(t('errPassword'), 'auth');
      throw new ApiError(data.error?.message || `fal.ai error ${res.status}`, data.error?.setup ? 'setup' : 'other');
    }
    if (res.headers.get('x-fal-flagged') === '1') throw new ApiError(t('errNoPicture'), 'blocked');
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new ApiError(t('errNoPicture')));
      reader.readAsDataURL(blob);
    });
  }

  // ---- Drawing, with whichever picture maker is chosen in Settings -------------------
  async function drawPortrait(story, girl, settings) {
    const style = styleFor(story, settings);
    if (settings.imageProvider === 'fal') {
      const scene = `upper body portrait, facing the viewer, ${girl.personality.split('.')[0].toLowerCase()} expression, softly blurred background`;
      return falImage(sdPrompt(story, [girl], scene, settings), settings);
    }
    return image(portraitPrompt(story, girl, style.text), settings);
  }

  // girls: the women in the picture; refs: portraits of the first refs.length of them, in the same order.
  async function drawScene(story, girls, scene, refs, settings, ctx = {}) {
    if (settings.imageProvider === 'fal') {
      // One face reference: the main woman. More would blend their faces together.
      return falImage(sdPrompt(story, girls, scene, settings, ctx), settings, refs[0] || null);
    }
    const list = /lite/i.test(settings.imageModel) ? refs.slice(0, 1) : refs; // the Lite model takes one reference only
    return image(scenePrompt(story, girls, scene, list.length, settings.userGender, styleFor(story, settings).text, ctx), settings, list);
  }

  // ---- Video (Veo on Vertex AI) ----------------------------------------------------
  // Starting a video returns an "operation" name; we then ask every few seconds whether it is done.
  async function videoStart(story, scene, imageDataUrl, settings) {
    const img = splitDataUrl(imageDataUrl);
    if (!img) throw new ApiError(t('errNoVideo'));
    const style = styleFor(story, settings).text;
    const prompt = `Animate this image from the story "${story.title || story.cast[0].name}". Scene: ${scene || story.scenario}
Subtle, natural motion: breathing, blinking, hair and clothing moving gently, one small expressive gesture, soft ambient movement in the background, slow cinematic push-in.
Keep the look of the image exactly (${style}), and keep the people, their clothes and the composition the same. Everyone stays clothed. All people shown are adults. No text or captions.`;
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
    LEVELS,
    POINTS_PER_LEVEL,
    MAX_POINTS,
    levelOf,
    levelName,
    loc,
    girlName,
    storyTitle,
    transcript,
    chatReply,
    image,
    styleFor,
    drawPortrait,
    drawScene,
    FAL_MODELS,
    videoStart,
    videoPoll,
    ping,
    test,
    ApiError,
  };
})();
