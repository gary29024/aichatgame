# Kindred: AI story chat

A personal web app for interactive stories with AI characters. You chat with a character, Google's Gemini AI writes their replies, and the app draws pictures of the scene as the story goes. Characters remember what happened, and an **affection meter** shows how they feel about you. What you say changes it.

## What's in it

- **6 starter characters** in different genres (fantasy, mystery, romance, sci-fi, gothic, romcom), all adults. You can also **create your own** or edit them.
- **Gemini writes the replies.** Each reply also includes the character's mood, a change in affection, and a description of the scene.
- **Pictures.** The app draws the character's portrait and then uses it as a reference, so later scene pictures look like the same person.
- **Affection meter**, from *Cold* to *Devoted*. Characters act differently at each level. Every reply shows its effect (e.g. `+3 ♥ liked the honesty`).
- **Memory.** The AI notes important facts as you play. You can see and edit them from the ⋯ menu.
- **Quick replies.** Three suggested things to say appear after each reply. Tap one to send it.
- **↻ Another reply** asks for a different answer if you don't like one. **🎨 Picture** draws any moment on demand.
- Everything is saved in your browser, on your device.

## 1. Get a Gemini API key

An API key is like a password that lets this app use Gemini through your Google account.

1. Go to <https://aistudio.google.com/apikey> and sign in with Google.
2. Click **Create API key** and copy it.
3. Pictures may require you to turn on billing in AI Studio. Text replies cost fractions of a cent each. Pictures cost a few cents each. Use **Settings → Pictures → "Only when I tap 🎨"** to keep costs down.

## 2. Put the app online (so it works on your iPhone)

The app is just a web page, so GitHub can host it for free with **GitHub Pages**:

1. On GitHub, open this repository → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*.
3. Pick the branch that has these files (e.g. `main` after merging), folder `/ (root)`, and click **Save**.
4. After a minute or two, the page is live at `https://<your-username>.github.io/aichatgame/`.
5. On iPhone, open that link in Safari → **Share** → **Add to Home Screen**. It now opens like an app.

The first time you open it, tap **Open settings**, paste your key, and pick a character.

> **Privacy note:** the page is public, but your key is not in the code. It is typed into the page and saved only in your browser, and it is only ever sent to Google. Anyone else who opens the link would need their own key. Your chats stay on your device. Clearing Safari's website data deletes them.

### Running it on a computer instead

Download the files and double-click `index.html`. If your browser blocks something, run `python3 -m http.server` in the folder and open <http://localhost:8000>.

## Settings explained

| Setting | What it does |
|---|---|
| Your name | What characters call you. |
| Pictures | *When the scene changes* (default), *every reply* (costs more), or *only when I tap 🎨*. |
| Romance level | *Mature* allows adult romance and intimate moments once the relationship has built up. *Flirty* stops at kissing. *Sweet* keeps it wholesome. |
| Google safety filter | How strict Google's adjustable filters are. Google always applies its own fixed rules on top of this, so very explicit requests or images may still be blocked or toned down. |
| Advanced: AI models | Which Gemini models write and draw. Change these if Google retires a model, or to try a smarter (slower) or cheaper one. |

## How the code works

| File | What it does |
|---|---|
| `index.html` | The page skeleton: home screen, chat screen, and pop-up window. |
| `style.css` | The look: dark theme, chat bubbles, cards, affection bar. |
| `js/characters.js` | The starter characters' descriptions. Edit the text to change them. |
| `js/gemini.js` | Talks to Gemini. It builds the instructions for the AI, sends the recent conversation, and reads back the structured answer. It also asks for pictures. |
| `js/app.js` | Runs the app: buttons, sending messages, updating affection, drawing pictures, settings, and the character editor. |
| `js/store.js` | Saves everything in your browser's built-in storage (IndexedDB). |

**What happens when you send a message:**

1. The app sends Gemini a set of instructions: who the character is, the current affection level and how to act at it, the memories, and the writing rules. With them go your last 60 messages.
2. Gemini answers in a fixed format: the reply, a mood, an affection change from −10 to +10 with a reason, a picture description, new facts to remember, and three suggestions.
3. The app shows the reply, moves the affection bar, saves the memories, and draws a picture if the scene changed.
