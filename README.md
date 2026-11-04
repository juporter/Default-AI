# Default-AI

**Multi-LLM Prompt**: a small web app for sending one prompt to several AI models at once and comparing the answers side by side.

Supported providers:

| Provider | API key variable | Default model | Get a key |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-6-astra` | https://platform.openai.com/api-keys |
| Claude (Anthropic) | `ANTHROPIC_API_KEY` | `claude-opus-5-5` | https://console.anthropic.com/settings/keys |
| Meta | `META_API_KEY` | `muse-spark-1.3` | https://dev.meta.ai/ |
| Gemini (Google) | `GEMINI_API_KEY` | `gemini-4-argon` | https://aistudio.google.com/apikey |
| Grok (xAI) | `XAI_API_KEY` | `grok-4.7` | https://console.x.ai/ |

You only need keys for the providers you want to use. Providers without a key are shown but greyed out.

## Quick start

Requires Node.js 20.12 or newer. There are no npm dependencies to install.

```sh
git clone https://github.com/juporter/Default-AI.git
cd Default-AI
cp .env.example .env     # then paste your API keys into .env
npm start
```

Open http://127.0.0.1:3000, tick the models you want, type a prompt and press **Send** (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>).

## Features

- **Pick any mix of providers**: tick one or all five. Your selection is remembered in the browser.
- **Choose the model per provider.** Each dropdown is loaded live from that provider's model list, so new models show up without changing the code. Choose **Other model ID…** to type any ID.
- **Optional system prompt**, sent to every selected model.
- **Answers appear as they arrive.** Each card shows the elapsed time and token counts, and warns when an answer was cut off.
- **Formatted or raw output.** Markdown (code blocks, tables and lists) is rendered safely. Toggle **Raw** to see the original text, or use **Copy**.
- **History for the session.** Each prompt keeps its own row of answers, newest first.

## How it works

```
browser ──► server.js ──► OpenAI / Anthropic / Meta / Google / xAI
```

`server.js` serves the page and forwards each prompt to the provider's API. Your API keys stay in `.env` on the server and are never sent to the browser. The browser makes one request per selected provider, so a slow model never holds up the others.

- `providers.js` describes each provider and converts between the app's format and each API. OpenAI, Meta and Grok all use the OpenAI Chat Completions format. Claude uses the Anthropic Messages API. Gemini uses `generateContent`.
- `public/` holds the UI: plain HTML, CSS and JavaScript with no build step.

## Configuration

Everything goes in `.env`. See [`.env.example`](.env.example) for the full list. Values in `.env` take precedence over variables already set in your shell.

| Variable | Purpose |
| --- | --- |
| `<PROVIDER>_MODEL` | Change a provider's default model, e.g. `OPENAI_MODEL=gpt-6-luna` |
| `<PROVIDER>_BASE_URL` | Send a provider's requests to a compatible endpoint, such as a proxy or gateway |
| `MAX_TOKENS` | Output limit for Claude, which requires one (default 4096) |
| `REQUEST_TIMEOUT_MS` | How long to wait for each provider (default 120000) |
| `HOST` / `PORT` | Where the app listens (default `127.0.0.1:3000`) |

`<PROVIDER>` is one of `OPENAI`, `ANTHROPIC`, `META`, `GEMINI` or `XAI`.

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
- Model output is HTML-escaped before it is displayed, and links are only created for `http(s)` URLs.

## Tests

```sh
npm test
```

The tests check the request and response conversion for every provider, the Markdown renderer's escaping, and the whole server. The server tests run against a fake provider, so no API keys are needed.
