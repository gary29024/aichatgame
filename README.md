# Kindred: AI story chat

A personal web app for interactive stories with AI characters. You chat with a character, Google's Gemini writes their replies, and the app draws pictures of the scene and can turn them into short videos. An **affection meter** tracks how the character feels about you, and a **gallery** collects pictures and special scenes you unlock along the way.

It runs on **Cloudflare**. The AI requests go through **Cloudflare AI Gateway** to **Google Vertex AI**, so your Google credentials never reach the browser. The site is locked with a password you choose.

## What's in it

- **11 stories, all with adult women:**
  - *One-on-one:* Seraphine (fantasy sorceress), Vivienne (jewel thief), Jade (Hong Kong bar owner), Isolde (smuggler captain), Kohaku (fox spirit), Mina (pop star).
  - *With 2–3 women at once:* Spirit Bureau (Hong Kong ghost office), Double-Booked Flat (rival flatmates), Starlight Karaoke (save a Mong Kok karaoke bar), Beneath the Palace Walls (ancient palace), Castaways of Coral Bay (desert island). Each woman has her own affection bar, portrait and special scenes, and they react to each other.
  - You can also **create your own** one-on-one characters or edit them. By default you play as a man (changeable in Settings).
- **💭 Private thoughts.** Some replies show what a woman is secretly thinking. You can read it; your character can't hear it.
- **English or Traditional Chinese.** In Chinese mode, menus are in Chinese and characters talk in **Hong Kong Cantonese (廣東話)**.
- **Relationship levels.** Each woman goes through 7 levels: Stranger → Acquaintance → Friend → Close friend → Crush → Lover → Soulmate. Each level has its own bar (0–100). A good reply usually adds 1–4 points, so every level takes a while to build. Levels you've reached are never lost, and the women won't skip ahead (no kiss before "Crush", no intimacy before "Lover").
- **Pictures match the reply.** The AI tracks where you are and what each woman is wearing, and every picture shows the exact moment the reply ends on.
- **Pictures.** The app draws the character's portrait first and uses it as a reference, so later scene pictures look like the same person.
- **Motion effect.** Pictures gently drift and shimmer, like a "live photo". It is free and can be turned off in Settings.
- **Videos.** Tap **🎬 Animate** on any picture to make a short real video of it with Google's Veo.
- **Gallery (🖼️)**:
  - *Special memories*: scenes locked 🔒 until the relationship grows, spread across the 7 levels (eight for one-on-one stories, four per woman in group stories). Each locked card shows when it unlocks. Once unlocked they stay unlocked, even if you restart the story.
  - *Key moments*: when something big happens in your story (first date, confession, first kiss…), the AI turns it into a new card with its own picture. There is no limit.
  - *Story moments*: every picture and video from your chats.
- **Memory.** The AI notes important facts as you play (⋯ menu → memories).
- **Quick replies**, **↻ Another reply**, and **🎨 Picture** for any moment.
- **Saved in your own Cloudflare storage (R2).** Chats, pictures, videos and the gallery are saved once and never redrawn. They show up on every device you log in from, and clearing Safari loses nothing. Each device also keeps a copy so things load fast.

## How it fits together

```
Your phone ──(password)──▶ Cloudflare Worker ──▶ Cloudflare AI Gateway ──▶ Google Vertex AI
 (the app)                 (this repo, src/)      (holds your Google key)     (Gemini, Nano Banana, Veo)
                                  │
                                  └──▶ Cloudflare R2 bucket "kindred-data" (your chats, pictures, videos)
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
5. **Storage:** go to **R2 Object Storage → Create bucket** and name it exactly **`kindred-data`**. Leave the other options as they are. R2 may ask you to add a payment method once, but the free allowance (10 GB) is plenty for personal use. **Do this before deploying.** Cloudflare won't install the app if the bucket is missing.

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

### Optional: open-source picture models (fal.ai)

Instead of Google's Nano Banana, pictures can be drawn by open-source **SDXL** models, the kind character-chat apps commonly use, running on **fal.ai**. A face reference (IP-Adapter) keeps each woman's face the same. Nudity is always blocked: fal's safety filter stays on, and the prompts rule out nudity and anyone underage.

1. Make an account at <https://fal.ai>, add some credit, and create an **API key** (Dashboard → Keys).
2. In Cloudflare, open your Worker → **Settings → Variables and Secrets**, and add `FAL_KEY` (type **Secret**) with that key. Requests go through your AI Gateway automatically.
3. In the app: **Settings → Picture maker → Open-source models (fal.ai)**, then pick a model:
   - **DreamShaper XL**: semi-realistic "2.5D"
   - **Animagine XL 4**: anime (set **Picture style → Anime** with this one)
   - **RealVis XL 5**: realistic
   - **Other**: any SDXL model's Hugging Face ID, or a direct link to a model file
4. Each portrait is redrawn once in the new model, then everything stays consistent.

fal bills this model by GPU time rather than a fixed price per picture. Check your fal dashboard after a few pictures to see what you're spending.

### If something doesn't work

| Message | What to do |
|---|---|
| *Server setup is incomplete. Missing: …* | Add the variable it names (Part C, step 2). |
| *FAL_KEY is not set on the Worker* | Add the `FAL_KEY` secret (see "Optional: open-source picture models"), or switch **Picture maker** back to Google. |
| *Cloud storage is not set up* / a Cloudflare build fails mentioning R2 | Create the R2 bucket `kindred-data` (Part B, step 5), then in your Worker → **Deployments** click **Retry build**. |
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

**Privacy:**
- Your stories live in your own private R2 bucket, which only the app (with your password) can read.
- AI Gateway keeps a log of requests (your chats and pictures) by default, so you can see usage. You can turn logging off in the gateway's settings.
- Settings like language and your name are kept per device.

## Settings explained

| Setting | What it does |
|---|---|
| Language | English, or Traditional Chinese with Cantonese characters. |
| Your name | What characters call you. |
| You play as | A man (default), a woman, or not specified. Characters and pictures treat you accordingly. |
| Pictures | *When something is worth seeing* (default, about every 2–3 replies), *every reply*, or *only when I tap 🎨*. |
| Picture maker | Google Nano Banana (default) or open-source SDXL models on fal.ai (needs `FAL_KEY`). |
| Picture style | Realistic photo (default), painted, anime, or each character's own style. Changing it redraws each portrait once. |
| Picture motion | Gentle movement on still pictures (free). |
| Video length | 4, 6 or 8 seconds for 🎬 videos. |
| Romance level | *Mature*: steamy but never graphic. Kissing from the Crush level, intimacy from the Lover level, always cutting away before anything explicit. *Flirty*: kissing, then fade to black. *Sweet*: wholesome. Pictures are always clothed (lingerie or sleepwear for intimate moments). |
| Google safety filter | How strict Google's adjustable filters are. Google always applies its own fixed rules on top, so very explicit requests, pictures or videos may still be blocked. |
| App password | The `APP_PASSWORD` from Part C. |
| Advanced: AI models | Which models write, draw and animate. |

## How the code works

| File | What it does |
|---|---|
| `public/index.html` | The page skeleton: home, chat and gallery screens, plus the pop-up window. |
| `public/style.css` | The look: dark theme, chat bubbles, cards, affection bar, gallery, motion effect. |
| `public/js/characters.js` | The one-on-one characters: English description, Cantonese text, and their 8 special scenes. |
| `public/js/stories.js` | The group stories: the women in each, their opening scene as lines, Cantonese text, and 4 special scenes per woman. |
| `public/js/i18n.js` | Every word on screen in English and Chinese. |
| `public/js/api.js` | Writes the instructions for the AI (character, affection level, memories, language rules) and sends requests to our server. |
| `public/js/app.js` | Runs the app: buttons, messages, affection, unlocking scenes, pictures, videos, gallery, settings. |
| `public/js/store.js` | Saves things in your Cloudflare R2 storage (the master copy) and in the browser (a fast local copy). |
| `src/worker.js` | The small server on Cloudflare. It checks the password, forwards AI requests through AI Gateway to Vertex AI, and saves and loads your data in R2. |
| `wrangler.jsonc` | Tells Cloudflare how to run the server and where the web files are. |
| `public/_headers` | Security settings so the page can only load its own files. |

**What happens when you send a message:**

1. The app builds a set of instructions: who the character is, the current affection level and how to act at it, the memories, and the language and writing rules. With them go your last 60 messages.
2. These go to the Cloudflare server, which checks your password and passes them through AI Gateway to Gemini on Vertex AI.
3. Gemini answers in a fixed format: the reply, a mood, an affection change from −10 to +10 with a reason, an English picture description, new facts to remember, and three suggestions.
4. The app shows the reply and moves the affection bar. It unlocks a special scene if a new level is reached, creates a key-moment card if the AI flagged one, and draws a picture if the scene changed.
5. The chat, gallery and any new pictures are saved to your R2 storage. If saving fails (e.g. no signal), they're kept on the phone and uploaded next time.

**Making a video:** the app sends the picture to Veo, which starts working and hands back a job number. The app asks every 8 seconds whether the job is done. When the video arrives, it is saved on your device. If you close the app while a video is being made, it picks up the job next time you open it.

## Running it on your own computer (optional)

```
npx wrangler dev --var APP_PASSWORD:test --var GCP_PROJECT_ID:... --var CF_ACCOUNT_ID:... --var AI_GATEWAY_ID:... --var CF_AIG_TOKEN:...
```

Then open <http://localhost:8787>.
