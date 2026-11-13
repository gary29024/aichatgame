# Kindred: AI story chat

A personal web app for interactive stories with AI characters. You chat with a character, Google's Gemini writes their replies, and the app draws pictures of the scene and can turn them into short videos. An **affection meter** tracks how the character feels about you, and a **gallery** collects pictures and special scenes you unlock along the way.

It runs on **Cloudflare**. The AI requests go through **Cloudflare AI Gateway** to **Google Vertex AI**, so your Google credentials never reach the browser. The site is locked with a password you choose.

## What's in it

- **6 starter characters** (fantasy, mystery, romance, sci-fi, gothic, romcom), all adults. You can also **create your own** or edit them.
- **English or Traditional Chinese.** In Chinese mode, menus are in Chinese and characters talk in **Hong Kong Cantonese (廣東話)**.
- **Affection meter**, from *Cold / 冷淡* to *Devoted / 死心塌地*. Characters act differently at each level. Every reply shows its effect, e.g. `+3 ♥ liked the honesty`.
- **Pictures.** The app draws the character's portrait first and uses it as a reference, so later scene pictures look like the same person.
- **Motion effect.** Pictures gently drift and shimmer, like a "live photo". It is free and can be turned off in Settings.
- **Videos.** Tap **🎬 Animate** on any picture to make a short real video of it with Google's Veo.
- **Gallery (🖼️)**:
  - *Special memories*: four scenes per character, locked 🔒 until affection reaches Friendly (40), Close (55), Smitten (70) and Devoted (85). Once unlocked they stay unlocked, even if you restart the story.
  - *Story moments*: every picture and video from your chats.
- **Memory.** The AI notes important facts as you play (⋯ menu → memories).
- **Quick replies**, **↻ Another reply**, and **🎨 Picture** for any moment.
- Chats, pictures and videos are saved in your browser on your device.

## How it fits together

```
Your phone ──(password)──▶ Cloudflare Worker ──▶ Cloudflare AI Gateway ──▶ Google Vertex AI
 (the app)                 (this repo, src/)      (holds your Google key)     (Gemini, Nano Banana, Veo)
```

## One-time setup (about 30 minutes)

### Part A: Google Cloud (Vertex AI)

1. Go to <https://console.cloud.google.com>, create a project (or pick one), and note its **Project ID**.
2. Make sure **billing** is turned on for the project. Vertex AI is pay-as-you-go.
3. Search for **"Vertex AI API"** in the top search bar and click **Enable**. Google is renaming Vertex AI to *Gemini Enterprise Agent Platform*, so you may see either name.
4. Create a key for the app to use:
   **IAM & Admin → Service Accounts → Create service account**. Name it e.g. `kindred`, give it the role **Vertex AI User**, then **Done**.
   Open the new account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads. Keep it private.
5. Recommended: **Billing → Budgets & alerts** → set a monthly budget so you get an email if spending gets high.

### Part B: Cloudflare AI Gateway

1. Go to <https://dash.cloudflare.com> → **AI → AI Gateway → Create gateway**. Name it e.g. `kindred`. This name is your **Gateway ID**.
2. In the gateway's **Settings**, keep **Authenticated Gateway** on. Click **Create authentication token** and copy it; it's shown only once. This is your **CF_AIG_TOKEN**.
3. **Provider Keys → Add API Key → Google Vertex AI**. Paste the whole content of the JSON file from Part A, choose region **us-central1**, and save.
4. Your **Account ID** is the long letters-and-numbers part of the dashboard address: `dash.cloudflare.com/<ACCOUNT_ID>/...`.

### Part C: Put the app on Cloudflare

1. In Cloudflare: **Workers & Pages → Create application → Import a repository (GitHub)**. Pick `aichatgame`, keep the name **`aichatgame`** (it must match `wrangler.jsonc`), and click **Save and Deploy**.
   Cloudflare deploys the branch set in **Settings → Build → Git branch** (default `main`). Every push to that branch updates the site automatically.
2. Open the Worker → **Settings → Variables and Secrets** and add:

   | Name | Type | Value |
   |---|---|---|
   | `APP_PASSWORD` | Secret | A long password you'll type into the app |
   | `CF_AIG_TOKEN` | Secret | The token from Part B, step 2 |
   | `GCP_PROJECT_ID` | Text | Your Google Project ID (Part A, step 1) |
   | `CF_ACCOUNT_ID` | Text | Your Cloudflare Account ID (Part B, step 4) |
   | `AI_GATEWAY_ID` | Text | Your gateway name, e.g. `kindred` |

3. Open `https://aichatgame.<your-name>.workers.dev`, type your password, then go to **Settings → Test connection**. You should see ✓.
4. On iPhone, open the link in Safari → **Share → Add to Home Screen**.

### If something doesn't work

| Message | What to do |
|---|---|
| *Server setup is incomplete. Missing: …* | Add the variable it names (Part C, step 2). |
| *Wrong or missing app password* | Re-enter the password in Settings. |
| *Model … was not found*, or a "location" / "region" error | Some models only run in certain Google regions. Try another model in **Settings → Advanced**, or add these Worker variables: `GCP_LOCATION_TEXT` and `GCP_LOCATION_IMAGE` (the default `global` usually works for the newest models; `us-central1` works for e.g. `gemini-2.5-flash` and `gemini-2.5-flash-image`). Videos use `GCP_LOCATION_VIDEO` (default `us-central1`). |
| Requests fail even though the password is right | **Plan B:** add the whole JSON key file as a Worker secret named `GOOGLE_SERVICE_ACCOUNT_JSON`. The Worker then sends the key with each request instead of relying on the copy stored in AI Gateway. |
| A reply, picture or video says it was blocked | Google filtered it. Reword the message, or tap **↻ Another reply**. |

## Costs

You pay Google directly for what you use:
- Text replies are very cheap.
- Pictures cost a few cents each.
- **Videos cost the most**, priced per second of video.

To spend less:
- **Settings → Pictures → "Only when I tap 🎨"**.
- Keep **Video length** at 4 seconds and the cheaper **Veo 3.1 Fast** model.

Cloudflare's free plan is enough for personal use.

**Privacy:** AI Gateway keeps a log of requests (your chats and pictures) by default, so you can see usage. You can turn logging off in the gateway's settings.

## Settings explained

| Setting | What it does |
|---|---|
| Language | English, or Traditional Chinese with Cantonese characters. |
| Your name | What characters call you. |
| Pictures | *When the scene changes* (default), *every reply*, or *only when I tap 🎨*. |
| Picture motion | Gentle movement on still pictures (free). |
| Video length | 4, 6 or 8 seconds for 🎬 videos. |
| Romance level | *Mature* allows adult romance and intimate moments once the relationship has built up. *Flirty* stops at kissing. *Sweet* keeps it wholesome. |
| Google safety filter | How strict Google's adjustable filters are. Google always applies its own fixed rules on top, so very explicit requests, pictures or videos may still be blocked. |
| App password | The `APP_PASSWORD` from Part C. |
| Advanced: AI models | Which models write, draw and animate. |

## How the code works

| File | What it does |
|---|---|
| `public/index.html` | The page skeleton: home, chat and gallery screens, plus the pop-up window. |
| `public/style.css` | The look: dark theme, chat bubbles, cards, affection bar, gallery, motion effect. |
| `public/js/characters.js` | The starter characters: English description, Cantonese text, and their 4 special scenes. |
| `public/js/i18n.js` | Every word on screen in English and Chinese. |
| `public/js/api.js` | Writes the instructions for the AI (character, affection level, memories, language rules) and sends requests to our server. |
| `public/js/app.js` | Runs the app: buttons, messages, affection, unlocking scenes, pictures, videos, gallery, settings. |
| `public/js/store.js` | Saves everything in the browser's built-in storage (IndexedDB). |
| `src/worker.js` | The small server on Cloudflare. It checks the password and forwards requests through AI Gateway to Vertex AI. |
| `wrangler.jsonc` | Tells Cloudflare how to run the server and where the web files are. |
| `public/_headers` | Security settings so the page can only load its own files. |

**What happens when you send a message:**

1. The app builds a set of instructions: who the character is, the current affection level and how to act at it, the memories, and the language and writing rules. With them go your last 60 messages.
2. These go to the Cloudflare server, which checks your password and passes them through AI Gateway to Gemini on Vertex AI.
3. Gemini answers in a fixed format: the reply, a mood, an affection change from −10 to +10 with a reason, an English picture description, new facts to remember, and three suggestions.
4. The app shows the reply and moves the affection bar. It unlocks a special scene if a new level is reached, and draws a picture if the scene changed.

**Making a video:** the app sends the picture to Veo, which starts working and hands back a job number. The app asks every 8 seconds whether the job is done. When the video arrives, it is saved on your device. If you close the app while a video is being made, it picks up the job next time you open it.

## Running it on your own computer (optional)

```
npx wrangler dev --var APP_PASSWORD:test --var GCP_PROJECT_ID:... --var CF_ACCOUNT_ID:... --var AI_GATEWAY_ID:... --var CF_AIG_TOKEN:...
```

Then open <http://localhost:8787>.
