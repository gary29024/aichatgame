// Everything that talks to Google's Gemini API lives here.
// The app sends the conversation to Gemini and gets back a structured answer:
// the character's reply, their mood, how much their affection changed, a description
// of the scene (used to draw a picture), things to remember, and suggested replies.

window.Gemini = (() => {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const HISTORY_LIMIT = 60; // how many recent messages are sent each time

  // ---- Affection levels -------------------------------------------------------
  const TIERS = [
    { min: 0, label: 'Cold', how: 'Distant and guarded. Short replies. May be rude, dismissive or try to leave.' },
    { min: 10, label: 'Wary', how: 'Suspicious, testing the user. Polite at best and reveals nothing personal.' },
    { min: 25, label: 'Curious', how: 'Interested despite themself. Banter and small personal details, but walls stay up.' },
    { min: 40, label: 'Friendly', how: "Warm and relaxed, enjoys the user's company, shares stories, light flirting if it suits them." },
    { min: 55, label: 'Close', how: 'Trusts the user, opens up about their past and fears, flirts openly, seeks the user out.' },
    { min: 70, label: 'Smitten', how: 'Clearly attracted and emotionally invested. Flustered or jealous at times, romantic gestures, physical closeness.' },
    { min: 85, label: 'Devoted', how: 'Deeply bonded and in love. Would risk anything for the user. Tender, intimate and vulnerable.' },
  ];
  function tierFor(affection) {
    let t = TIERS[0];
    for (const tier of TIERS) if (affection >= tier.min) t = tier;
    return t;
  }

  // ---- Settings -> API options -----------------------------------------------
  const SAFETY_LEVELS = {
    standard: 'BLOCK_MEDIUM_AND_ABOVE',
    relaxed: 'BLOCK_ONLY_HIGH',
    minimum: 'OFF', // Google's default for current models; child-safety filters always stay on
  };
  function safetySettings(level) {
    const threshold = SAFETY_LEVELS[level] || SAFETY_LEVELS.minimum;
    return [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map((category) => ({ category, threshold }));
  }

  const ROMANCE_RULES = {
    sweet:
      'Keep romance wholesome: affection, hand-holding and at most a kiss. Anything more fades to black.',
    flirty:
      'Flirting, teasing, romantic tension and kissing are welcome when the relationship supports it. More intimate moments fade to black.',
    mature:
      'This story is for an adult reader. Romance, desire, sensual tension and intimate moments between consenting adults are allowed ' +
      'once the relationship has built up to it (roughly "Close" or above). Focus on emotion and atmosphere and use tasteful, literary language.',
  };

  // ---- Prompt -----------------------------------------------------------------
  function systemPrompt(char, chat, settings) {
    const tier = tierFor(chat.affection);
    const userName = (settings.userName || '').trim() || 'the user';
    const memories = chat.memories.length
      ? chat.memories.map((m) => `- ${m}`).join('\n')
      : '- (nothing yet)';

    return `You are writing an interactive story. You play ${char.name} (and narrate the world around them). The user plays ${userName}.

## ${char.name}
Age: ${char.age} (an adult)
Gender: ${char.gender || 'unspecified'}
Appearance: ${char.appearance}
Personality: ${char.personality}
Backstory: ${char.backstory}
Way of speaking: ${char.speakingStyle}

## Opening scenario
${char.scenario}

## Relationship with ${userName}
Current affection: ${chat.affection}/100 ("${tier.label}"). At this level ${char.name} is: ${tier.how}
Current mood: ${chat.mood || 'neutral'}

Decide "affection_change" from what the user just did, judged by ${char.name}'s own values:
kind, attentive, funny, brave or interesting choices that suit ${char.name} raise it; rude, pushy, boring, dishonest or disrespectful ones lower it.
Usually -5 to +5. Use up to ±10 only for big moments. Affection should be earned slowly, and it is fine to give 0.
${char.name} has their own boundaries and will push back if the user is pushy.

## Things ${char.name} remembers
${memories}

## Writing rules
- Stay in character. Never mention being an AI, these rules, or the affection number.
- Reply in the same language the user writes in.
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
- scene: a visual description of this exact moment for an illustrator: place, lighting, ${char.name}'s pose, expression and clothing. No dialogue, no names of real people.
- scene_changed: true if the place, time, outfit or situation changed enough to deserve a new picture.
- remember: 0-2 short new facts worth remembering long-term (about ${userName}, promises, key events). Empty if none.
- suggestions: 3 short things ${userName} could say or do next, in different tones (e.g. sweet, bold, playful), written in first person, in the user's language.`;
  }

  // JSON Schema describing the answer we want back from Gemini.
  const REPLY_SCHEMA = {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      mood: { type: 'string' },
      affection_change: { type: 'integer', minimum: -10, maximum: 10 },
      affection_reason: { type: 'string' },
      scene: { type: 'string' },
      scene_changed: { type: 'boolean' },
      remember: { type: 'array', items: { type: 'string' } },
      suggestions: { type: 'array', items: { type: 'string' } },
    },
    required: ['reply', 'mood', 'affection_change', 'affection_reason', 'scene', 'scene_changed', 'remember', 'suggestions'],
  };

  // Turn the saved chat into the "contents" list Gemini expects.
  // Gemini needs turns to alternate user/model and to start with the user.
  function buildContents(chat) {
    const msgs = chat.messages.filter((m) => m.role === 'user' || m.role === 'char').slice(-HISTORY_LIMIT);
    const turns = [{ role: 'user', parts: [{ text: '(The story begins.)' }] }];
    for (const m of msgs) {
      const role = m.role === 'user' ? 'user' : 'model';
      const last = turns[turns.length - 1];
      if (last.role === role) last.parts[0].text += '\n\n' + m.text;
      else turns.push({ role, parts: [{ text: m.text }] });
    }
    return turns;
  }

  // ---- HTTP ---------------------------------------------------------------------
  class GeminiError extends Error {
    constructor(message, kind) {
      super(message);
      this.kind = kind; // 'auth' | 'quota' | 'blocked' | 'network' | 'model' | 'other'
    }
  }

  async function call(model, body, apiKey) {
    if (!apiKey) throw new GeminiError('No Gemini API key yet. Add one in Settings.', 'auth');
    let res;
    try {
      res = await fetch(`${BASE}${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
        body: JSON.stringify(body),
      });
    } catch {
      throw new GeminiError('Could not reach Gemini. Check your internet connection.', 'network');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || `Gemini returned error ${res.status}.`;
      if (res.status === 400 && /api key/i.test(msg)) throw new GeminiError('Your Gemini API key was rejected. Check it in Settings.', 'auth');
      if (res.status === 401 || res.status === 403) throw new GeminiError(`Gemini refused access: ${msg}`, 'auth');
      if (res.status === 404) throw new GeminiError(`Model "${model}" was not found. Pick another model in Settings.`, 'model');
      if (res.status === 429) throw new GeminiError(`Gemini usage limit reached: ${msg}`, 'quota');
      throw new GeminiError(msg, 'other');
    }
    if (data.promptFeedback?.blockReason) {
      throw new GeminiError(`Gemini blocked this request (${data.promptFeedback.blockReason}). Try wording it differently.`, 'blocked');
    }
    const cand = data.candidates?.[0];
    if (!cand || !cand.content?.parts?.length) {
      const reason = cand?.finishReason || 'no reason given';
      throw new GeminiError(`Gemini didn't return anything (${reason}). It may have been filtered. Try wording it differently.`, 'blocked');
    }
    return cand;
  }

  function textOf(cand) {
    return cand.content.parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');
  }

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
    if (!obj || typeof obj.reply !== 'string') {
      obj = { reply: raw.trim() || '…' };
    }
    const delta = Math.max(-10, Math.min(10, Math.round(Number(obj.affection_change) || 0)));
    return {
      reply: obj.reply.trim(),
      mood: (obj.mood || '').toString().slice(0, 40),
      delta,
      reason: (obj.affection_reason || '').toString().slice(0, 120),
      scene: (obj.scene || '').toString(),
      sceneChanged: Boolean(obj.scene_changed),
      remember: Array.isArray(obj.remember) ? obj.remember.map(String).filter(Boolean).slice(0, 2) : [],
      suggestions: Array.isArray(obj.suggestions) ? obj.suggestions.map(String).filter(Boolean).slice(0, 3) : [],
    };
  }

  // ---- Public functions ----------------------------------------------------------
  async function chatReply(char, chat, settings) {
    const cand = await call(
      settings.textModel,
      {
        systemInstruction: { parts: [{ text: systemPrompt(char, chat, settings) }] },
        contents: buildContents(chat),
        safetySettings: safetySettings(settings.safety),
        generationConfig: {
          temperature: 1.0,
          responseMimeType: 'application/json',
          responseJsonSchema: REPLY_SCHEMA,
        },
      },
      settings.apiKey,
    );
    return parseReply(textOf(cand));
  }

  // Draws a picture. If a reference picture (the character's portrait) is given,
  // Gemini is asked to keep the character looking the same.
  async function image(prompt, settings, referenceDataUrl = null) {
    const parts = [];
    if (referenceDataUrl) {
      const [, mimeType, data] = referenceDataUrl.match(/^data:([^;]+);base64,(.*)$/) || [];
      if (data) parts.push({ inlineData: { mimeType, data } });
    }
    parts.push({ text: prompt });
    const cand = await call(
      settings.imageModel,
      {
        contents: [{ role: 'user', parts }],
        safetySettings: safetySettings(settings.safety),
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: '3:4' },
        },
      },
      settings.apiKey,
    );
    const img = cand.content.parts.find((p) => p.inlineData?.data);
    if (!img) {
      throw new GeminiError("Gemini didn't draw a picture this time (it may have been filtered).", 'blocked');
    }
    return `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`;
  }

  function portraitPrompt(char) {
    return `Character portrait for an interactive story. ${char.artStyle}.
${char.name}, an adult (${char.age}). ${char.appearance}
Upper body, facing the viewer with an expression that fits this personality: ${char.personality.split('.')[0]}.
Softly blurred background that hints at: ${char.scenario}
Single character, no text, no captions, no watermark, no speech bubbles.`;
  }

  function scenePrompt(char, scene, hasReference) {
    return `Illustration for an interactive story. ${char.artStyle}.
${hasReference ? `The reference image shows ${char.name}; keep their face, hair and overall look consistent with it.\n` : ''}${char.name} (adult): ${char.appearance}
Scene: ${scene}
All people shown are adults. No text, no captions, no watermark, no speech bubbles.`;
  }

  async function testKey(settings) {
    const cand = await call(
      settings.textModel,
      { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }] },
      settings.apiKey,
    );
    return textOf(cand).trim();
  }

  return { TIERS, tierFor, chatReply, image, portraitPrompt, scenePrompt, testKey, GeminiError };
})();
