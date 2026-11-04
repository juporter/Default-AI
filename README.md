# Default AI Prompt

A small web app for sending one prompt to several AI models at once and comparing the answers side by side.

Supported providers:

| Provider | API key variable | Default model | Get a key |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-6-astra` | https://platform.openai.com/api-keys |
| Claude (Anthropic) | `ANTHROPIC_API_KEY` | `claude-opus-5-5` | https://console.anthropic.com/settings/keys |
| Meta | `META_API_KEY` | `muse-spark-1.3` | https://dev.meta.ai/ |
| Gemini (Google) | `GEMINI_API_KEY` | `gemini-4-argon` | https://aistudio.google.com/apikey |
| Grok (xAI) | `XAI_API_KEY` | `grok-4.7` | https://console.x.ai/ |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` | https://platform.deepseek.com/api_keys |
| Perplexity | `PERPLEXITY_API_KEY` | `perplexity/sonar` | https://console.perplexity.ai/ |
| Kimi (Moonshot AI) | `KIMI_API_KEY` | `kimi-k3.1-pro` | https://platform.kimi.ai/console/api-keys |

You only need keys for the providers you want to use. Providers without a key are shown but greyed out.

## Quick start

Requires Node.js 20.12 or newer. There are no npm dependencies to install.

```sh
git clone https://github.com/juporter/Default-AI.git
cd Default-AI
npm start
```

Open http://127.0.0.1:3000. Add your API keys in **Settings → Import settings** (or copy `.env.example` to `.env` and fill it in), tick the models you want, type a prompt and press **Send** (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>).

## Features

### Compare

- **Pick any mix of eight providers.** Your selection is remembered in the browser.
- **Choose the model per provider.** Each dropdown is loaded live from that provider's model list, so new models show up without changing the code. If a list can't be loaded, suggested models are shown instead. Choose **Other model ID…** to type any ID.
- **Attach files.** Add text files (code, Markdown, CSV, JSON, logs and so on) with **Attach files** or by dropping them on the prompt. Their contents are sent to every selected model with your prompt. Each file can be up to 1 MB, and 2 MB in total. PDFs, Word files and images aren't supported yet.
- **Optional system prompt**, sent to every selected model.
- **Answers appear as they arrive.** Each card shows the elapsed time and token counts, and warns when an answer was cut off.
- **Perplexity searches the web.** Its answers come with a numbered list of sources.
- **Formatted or raw output.** Markdown (code blocks, tables and lists) is rendered safely. Toggle **Raw** to see the original text, or use **Copy**.

### History

- **Every prompt is saved**, with each model's answer and any attached files. History is stored in your browser, so it stays after you close the page.
- **Search** prompts and answers, and filter by where they came from.
- **Use this prompt** puts an old prompt (and its files) back in the composer so you can send it to other models.
- **Import chats from other apps:**

  | From | What to upload |
  | --- | --- |
  | ChatGPT | Settings → Data controls → Export data. Upload the .zip you receive, or the `conversations.json` inside it. |
  | Claude | Settings → Privacy → Export data. Upload the .zip, or the `conversations.json` inside it. |
  | Gemini | [Google Takeout](https://takeout.google.com/) → My Activity → Gemini Apps, with the format set to **JSON**. Upload the .zip, or `MyActivity.json`. |
  | Anything else | A JSON list of chats: `[{"title": "…", "messages": [{"role": "user", "content": "…"}, …]}]` |

- **Export history** saves everything (your prompts and imported chats) to one JSON file. Import that file to restore it later or on another computer.
- **Delete shown** removes whatever matches the current search and source filter.

### Settings

- **See which providers are ready** and where to get each key.
- **Import settings** from a `.env` file or a JSON file such as `{"OPENAI_API_KEY": "sk-…"}`, or paste them in. You see a preview first, with keys masked, then **Save settings** writes them to the app's `.env` file. They take effect right away, with no restart.
- Settings can only be changed from the computer that runs the app.

### Advertising (Google AdSense)

The page has two ad spaces, one under the header and one at the bottom. They stay hidden until you configure them.

| Variable | Purpose |
| --- | --- |
| `ADSENSE_CLIENT` | Your AdSense publisher ID, e.g. `ca-pub-1234567890123456`. Turns AdSense on. |
| `ADSENSE_SLOT_TOP` / `ADSENSE_SLOT_BOTTOM` | The ad unit ID for each space (AdSense → Ads → By ad unit → Display ads). Leave both empty to let AdSense **Auto ads** place ads for you. |
| `ADS_PLACEHOLDER` | `true` shows empty, labelled boxes where the ads will go, so you can check the layout before AdSense is set up. |

With `ADSENSE_CLIENT` set, the app also serves `/ads.txt` for you, and it switches to the nonce-based Content Security Policy that Google requires for AdSense.

**Before you rely on ads, note:**

- **AdSense only shows ads on a public website** that Google has reviewed and approved. On `127.0.0.1` the spaces load but stay empty. To earn from ads you need to host the app on your own domain and add that site in your AdSense account.
- **Hosting the app publicly means visitors use your API keys.** Every prompt anyone sends is billed to your accounts with OpenAI, Anthropic and the rest. Before going public, put the app behind a login, add rate limits and set spending caps with each provider.
- To host it, set `HOST=0.0.0.0` and run it behind an HTTPS reverse proxy. Settings import stays limited to the server itself.

## How it works

```
browser ──► server.js ──► OpenAI / Anthropic / Meta / Google / xAI / DeepSeek / Perplexity / Moonshot
```

`server.js` serves the page and forwards each prompt to the provider's API. Your API keys stay in `.env` on the server and are never sent to the browser. The browser makes one request per selected provider, so a slow model never holds up the others.

- `providers.js` describes each provider and converts between the app's format and each API. OpenAI, Meta, Grok, DeepSeek and Kimi use the OpenAI Chat Completions format. Claude uses the Anthropic Messages API. Gemini uses `generateContent`. Perplexity uses its Agent API with web search turned on.
- `settings.js` reads, checks and saves imported settings files, and holds the ad settings.
- `public/` holds the UI: plain HTML, CSS and JavaScript with no build step. `public/importers.js` reads chat exports (including .zip files) in the browser, and `public/store.js` keeps History in the browser's IndexedDB.

## Configuration

Everything goes in `.env`, either edited by hand or through **Settings → Import settings**. See [`.env.example`](.env.example) for the full list. Values in `.env` take precedence over variables already set in your shell.

| Variable | Purpose |
| --- | --- |
| `<PROVIDER>_API_KEY` | A provider's API key (Kimi also accepts `MOONSHOT_API_KEY`) |
| `<PROVIDER>_MODEL` | Change a provider's default model, e.g. `OPENAI_MODEL=gpt-6-luna` |
| `<PROVIDER>_BASE_URL` | Send a provider's requests to a compatible endpoint, such as a proxy or gateway |
| `MAX_TOKENS` | Output limit for Claude, which requires one (default 4096) |
| `REQUEST_TIMEOUT_MS` | How long to wait for each provider (default 120000) |
| `HOST` / `PORT` | Where the app listens (default `127.0.0.1:3000`) |
| `ADSENSE_*`, `ADS_PLACEHOLDER` | Ads, see above |

`<PROVIDER>` is one of `OPENAI`, `ANTHROPIC`, `META`, `GEMINI`, `XAI`, `DEEPSEEK`, `PERPLEXITY` or `KIMI`.

### Meta: Muse or Llama

Meta's developer API (`https://api.meta.ai/v1`) serves Meta's current Muse models. To use **Llama** models, point the Meta slot at any OpenAI-compatible host that serves them, for example:

```sh
META_API_KEY=your-key-for-that-host
META_BASE_URL=https://api.groq.com/openai/v1   # or https://api.together.xyz/v1, etc.
META_MODEL=<that host's Llama model ID>
```

Once the key is set, the model dropdown lists that host's models.

## Security notes

- The server listens on `127.0.0.1` only, so only your computer can reach it. Anyone who can reach the port can spend your API credits, so think carefully before changing `HOST`.
- Requests must be JSON, and the server checks the `Host` header. This stops other websites you visit from using the app in the background.
- Settings import only accepts requests from the computer running the app, only writes the variables listed above (never `HOST` or `PORT`), and rejects values that could break the `.env` file. Keys are shown masked.
- Model output and imported chats are HTML-escaped before they are displayed, and links are only created for `http(s)` URLs.

## Tests

```sh
npm test
```

The tests check the request and response conversion for every provider, the chat-export importers (including real .zip files), settings import, the Markdown renderer's escaping, and the whole server. The server tests run against a fake provider, so no API keys are needed.
