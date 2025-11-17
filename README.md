# AI Pipe

AI Pipe lets you build web apps that can access LLM APIs (e.g. OpenRouter, OpenAI, Gemini etc.) without a back-end.

An instance is hosted at <https://aipipe.org/>. You can host your own on CloudFlare. Licensed under [MIT](LICENSE).

## User Guide

Visit these pages:

- **[aipipe.org](https://aipipe.org/)** to understand how it works.
- **[aipipe.org/login](https://aipipe.org/login)** with a Google Account to get your AI Pipe Token and track your usage.
- **[aipipe.org/playground](https://aipipe.org/playground)** to explore models and chat with them.

## AI Pipe Token

You can use the AI Pipe Token from **[aipipe.org/login](https://aipipe.org/login)** in any OpenAI API compatible application by setting:

- `OPENAI_API_KEY` as your AI Pipe Token
- `OPENAI_BASE_URL` as `https://aipipe.org/openai/v1`

For example:

```bash
export OPENAI_API_KEY=$AIPIPE_TOKEN
export OPENAI_BASE_URL=https://aipipe.org/openai/v1
```

Now you can run:

```bash
uvx openai api chat.completions.create -m gpt-4.1-nano -g user "Hello"
```

... or:

```bash
uvx llm 'Hello' -m gpt-4o-mini --key $AIPIPE_TOKEN
```

This will print something like `Hello! How can I assist you today?`

## Native Provider API Keys

You can also use your own provider API keys directly (instead of an AI Pipe Token). This is useful if you want to:

- Bypass AI Pipe's cost tracking and budget limits
- Use models that aren't yet in AI Pipe's pricing database
- Handle billing directly with the provider

Simply use your native API key in the `Authorization` header:

```bash
# OpenAI with native key (starts with sk-)
curl https://aipipe.org/openai/v1/chat/completions \
  -H "Authorization: Bearer sk-your-openai-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'

# OpenRouter with native key (starts with sk-or-)
curl https://aipipe.org/openrouter/v1/chat/completions \
  -H "Authorization: Bearer sk-or-your-openrouter-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'

# Gemini with native key (starts with AIza)
curl https://aipipe.org/geminiv1beta/models/gemini-2.5-flash-lite:generateContent \
  -H "Authorization: Bearer AIzaSyYourGeminiKey" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello"}]}]}'
```

Native keys are detected by their prefix pattern:

- **OpenAI / OpenRouter**: Keys starting with `sk-`
- **Google Gemini**: Keys starting with `AIza`

**Note**: Native API keys cannot access `/usage` or `/admin` endpoints, which require an AI Pipe Token.

## Developer Guide

Paste this code into `index.html`, open it in a browser, and check your [DevTools Console](https://developer.chrome.com/docs/devtools/console)

```html
<script type="module">
  import { getProfile } from "https://aipipe.org/aipipe.js";

  const { token, email } = getProfile();
  if (!token) window.location = `https://aipipe.org/login?redirect=${window.location.href}`;

  const response = await fetch("https://aipipe.org/openrouter/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is 2 + 2?" }],
    }),
  }).then((r) => r.json());
  console.log(response);
</script>
```

This app will:

1. **Redirect the user to AI Pipe.**
   - `getProfile()` sets `token` to `null` since it doesn't know the user.
   - `window.location` redirects the user to `https://aipipe.org/login` with `?redirect=` as your app URL
2. **Redirect them back to your app once they log in.**

- Your app URL will have a `?aipipe_token=...&aipipe_email=...` with the user's token and email
- `getProfile()` fetches these, stores them for future reference, and returns `token` and `email`

3. **Make an LLM API call to OpenRouter or OpenAI and log the response.**

- You can replace any call to [`https://openrouter.ai/api/v1`](https://openrouter.ai/docs/quickstart)
  with `https://aipipe.org/openrouter/v1` and provide `Authorization: Bearer $AIPIPE_TOKEN` as a header.
- Similarly, you can replace [`https://api.openai.com/v1`](https://platform.openai.com/docs/api-reference/)
  with `https://aipipe.org/openai/v1` and provide `Authorization: Bearer $AIPIPE_TOKEN` as a header.
- AI Pipe replaces the token and proxies the request via the provider.

## API

**`GET /usage`**: Returns usage data for specified email and time period

**Example**: Get usage for a user

```bash
curl https://aipipe.org/usage -H "Authorization: Bearer $AIPIPE_TOKEN"
```

Response:

```json
{
  "email": "user@example.com",
  "days": 7,
  "cost": 0.000137,
  "usage": [{ "date": "2025-04-16", "cost": 0.000137 }],
  "limit": 0.1
}
```

**`GET /proxy/[URL]`**: Proxies requests to the specified URL, bypassing CORS restrictions. No authentication required.

**Example**: Get contents of a URL

```bash
curl "https://aipipe.org/proxy/https://httpbin.org/get?x=1"
```

Response:

```json
{
  "args": { "x": "1" },
  "headers": {
    "Accept": "*/*",
    "Host": "httpbin.org",
    "User-Agent": "curl/8.5.0"
  },
  "origin": "45.123.26.54",
  "url": "https://httpbin.org/get?x=1"
}
```

Notes:

- The response includes the original URL in the `X-Proxy-URL` header
- URLs must begin with `http` or `https`
- Requests timeout after 30 seconds
- All HTTP methods (GET, POST, etc.) and headers are preserved
- CORS headers are added for browser compatibility

**`GET token?credential=...`**: Converts a Google Sign-In credential into an AI Pipe token:

- When a user clicks "Sign in with Google" on the login page, Google's client library returns a JWT credential
- The login page sends this credential to `/token?credential=...`
- AI Pipe verifies the credential using Google's public keys
- If valid, AI Pipe signs a new token containing the user's email (and optional salt) using `AIPIPE_SECRET`
- Returns: `{ token, email ... }` where additional fields come from Google's profile

### OpenRouter API

**`GET /openrouter/*`**: Proxy requests to OpenRouter

**Example**: List [Openrouter models](https://openrouter.ai/docs/api-reference/list-available-models)

```bash
curl https://aipipe.org/openrouter/v1/models -H "Authorization: Bearer $AIPIPE_TOKEN"
```

Response:

```jsonc
{
  "data": [
    {
      "id": "google/gemini-2.5-pro-preview-03-25",
      "name": "Google: Gemini 2.5 Pro Preview"
      // ...
    }
  ]
}
```

**Example**: Make a [chat completion request](https://openrouter.ai/docs/api-reference/chat-completion)

```bash
curl https://aipipe.org/openrouter/v1/chat/completions \
  -H "Authorization: Bearer $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "google/gemini-2.0-flash-lite-001", "messages": [{ "role": "user", "content": "What is 2 + 2?" }] }'
```

Response contains:

```jsonc
{ "choices": [{ "message": { "role": "assistant", "content": "..." } }] }
```

#### OpenRouter Image Generation

```bash
curl https://aipipe.org/openrouter/v1/chat/completions \
  -H "Authorization: Bearer $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.5-flash-image-preview",
    "messages": [{"role": "user", "content": "Draw a cat"}],
    "modalities": ["image", "text"]
  }'
```

Response contains:

```jsonc
{
  "choices": [
    {
      "message": {
        "images": [
          {
            "type": "image_url",
            "image_url": { "url": "data:image/png;base64,iVBORw0K..." }
          }
        ]
      }
    }
  ]
}
```

### OpenAI API

**`GET /openai/*`**: Proxy requests to OpenAI

AIPipe supports all OpenAI models that return usage data in their responses, enabling accurate cost tracking.
This includes chat completion models, audio preview models (e.g. `gpt-4o-audio-preview`), and transcription
models (e.g. `gpt-4o-transcribe`). Text-to-speech (TTS) models like `tts-1` are **not supported** because they
return raw audio without usage metadata.

**Example**: List [OpenAI models](https://platform.openai.com/docs/api-reference/models)

```bash
curl https://aipipe.org/openai/v1/models -H "Authorization: Bearer $AIPIPE_TOKEN"
```

Response contains:

```jsonc
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o-audio-preview-2024-12-17",
      "object": "model",
      "created": 1734034239,
      "owned_by": "system"
    }
    // ...
  ]
}
```

**Example**: Make a [responses request](https://platform.openai.com/docs/api-reference/responses)

```bash
curl https://aipipe.org/openai/v1/responses \
  -H "Authorization: Bearer $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4.1-nano", "input": "What is 2 + 2?" }'
```

Response contains:

```jsonc
{
  "output": [{
    "role": "assistant",
    "content": [{ "text": "2 + 2 equals 4." }] // ...
  }]
}
```

**Example**: Create [embeddings](https://platform.openai.com/docs/api-reference/embeddings)

```bash
curl https://aipipe.org/openai/v1/embeddings \
  -H "Authorization: Bearer $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "text-embedding-3-small", "input": "What is 2 + 2?" }'
```

Response contains:

```jsonc
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.010576399, -0.037246477 // ...
      ]
    }
  ],
  "model": "text-embedding-3-small",
  "usage": { "prompt_tokens": 8, "total_tokens": 8 }
}
```

### Gemini API

**`GET /geminiv1beta/*`**: Proxy requests to Google's Gemini API

**Example**: Make a [generateContent](https://ai.google.dev/gemini-api/docs) request

```bash
curl https://aipipe.org/geminiv1beta/models/gemini-2.5-flash-lite:generateContent \
  -H "x-goog-api-key: $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"What is 2 + 2?"}]}]}'
```

Response contains:

```jsonc
{
  "candidates": [{ "content": { "parts": [{ "text": "2 + 2 is 4." }] } }],
  "modelVersion": "gemini-2.5-flash-lite",
  "usageMetadata": {
    "promptTokenCount": 8,
    "candidatesTokenCount": 8,
    "totalTokenCount": 16
  }
}
```

**Example**: Create [embeddings](https://ai.google.dev/gemini-api/docs/embeddings)

```bash
curl https://aipipe.org/geminiv1beta/models/gemini-embedding-001:embedContent \
  -H "x-goog-api-key: $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-embedding-001","content":{"parts":[{"text":"What is 2 + 2?"}]}}'
```

Response contains:

```jsonc
{
  "embedding": { "values": [0.01, -0.02] },
  "usageMetadata": { "tokenCount": 8 }
}
```

### Similarity API

**`POST /similarity`**: Calculate semantic similarity between documents and topics using embeddings.

**Example**: Calculate similarity between documents and topics

```bash
curl https://aipipe.org/similarity \
  -H "Authorization: Bearer $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "docs": ["The quick brown fox jumps over the lazy dog", "A fast orange fox leaps over a sleepy canine"],
    "topics": ["fox jumping", "dog sleeping"],
    "model": "text-embedding-3-small",
    "precision": 5
  }'
```

Response contains:

```jsonc
{
  "model": "text-embedding-3-small",
  "similarity": [
    [0.82345, 0.12345], // Similarity scores for first doc against each topic
    [0.81234, 0.23456] // Similarity scores for second doc against each topic
  ],
  "tokens": 42
}
```

**Example**: Calculate similarity between all documents (self-similarity matrix)

```bash
curl https://aipipe.org/similarity \
  -H "Authorization: Bearer $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "docs": [
      "The quick brown fox jumps over the lazy dog",
      "A fast orange fox leaps over a sleepy canine",
      "The lazy dog sleeps while the fox jumps"
    ],
    "model": "text-embedding-3-small"
  }'
```

Response contains:

```jsonc
{
  "model": "text-embedding-3-small",
  "similarity": [
    [1.0, 0.82345, 0.71234], // First doc's similarity with all docs
    [0.82345, 1.0, 0.6789], // Second doc's similarity with all docs
    [0.71234, 0.6789, 1.0] // Third doc's similarity with all docs
  ],
  "tokens": 63
}
```

**Example**: Using structured input format

```bash
curl https://aipipe.org/similarity \
  -H "Authorization: Bearer $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "docs": [
      { "type": "text", "value": "The quick brown fox jumps over the lazy dog" },
      { "type": "text", "value": "A fast orange fox leaps over a sleepy canine" }
    ],
    "topics": [
      { "type": "text", "value": "fox jumping" },
      { "type": "text", "value": "dog sleeping" }
    ]
  }'
```

Parameters:

- `docs`: Array of strings or objects with `{type, value}`. Required.
- `topics`: Optional array of strings or objects with `{type, value}`. If not provided, calculates similarity between all documents.
- `model`: Optional embedding model name. Defaults to "text-embedding-3-small".
- `precision`: Optional number of decimal places in similarity scores. Defaults to 5.

## Admin Guide

To self-host AI Pipe, you need a:

- [CloudFlare Account](https://dash.cloudflare.com/) - hosts your AI Pipe instance
- [OpenRouter API Key](https://openrouter.ai/settings) - to access OpenRouter models
- [OpenAI API Key](https://platform.openai.com/api-keys) - to access OpenAI models
- [Google Client ID](https://console.cloud.google.com/apis/credentials) - for user login. Add OAuth 2.0 redirect URLs:
  - https://aipipe.org/login (or your domain)
  - http://localhost:8787/login (for testing)

1. Clone and install:

```bash
git clone https://github.com/sanand0/aipipe.git
cd aipipe
npm install
```

2. Copy `src/config.example.js` to `src/config.js` and update budgets and salts. If `src/config.js` is missing, AIPipe falls back to `config.example.js`. For example:

```js
// Set a budget limit for specific email IDs or domains
const budget = {
  "*": { limit: 0.1, days: 7 }, // Default fallback: low limits for unknown users. Use 0.001 to limit to free models.
  "blocked@example.com": { limit: 0, days: 1 }, // Blocked user: zero limit stops all operations
  "user@example.com": { limit: 10.0, days: 30 }, // Premium user with monthly high-volume allocation
  "@example.com": { limit: 1.0, days: 7 }, // Domain-wide policy: moderate weekly quota for organization
};

// If a user reports their key as stolen, add/change their salt to new random text.
// That will invalidate their token.
const salt = {
  "user@example.com": "random-text",
};
```

3. Create `.dev.vars` (which is `.gitignore`d) with your secrets:

```bash
# Required: Your JWT signing key
AIPIPE_SECRET=$(openssl rand -base64 12)

# Optional: add email IDs of admin users separated by comma and/or whitespace.
ADMIN_EMAILS="admin@example.com, admin2@example.com, ..."

# Optional: Add only the APIs you need
OPENROUTER_API_KEY=sk-or-v1-...  # via openrouter.ai/settings
OPENAI_API_KEY=sk-...            # via platform.openai.com/api-keys
GEMINI_API_KEY=AI...             # via aistudio.google.com/app/apikey
```

4. Test your deployment:

Ensure that `.dev.vars` has all keys set (including optional ones). Then run:

```bash
npm run dev   # Runs at http://localhost:8787
ADMIN_EMAILS=admin@example.com npm test
curl http://localhost:8787/usage -H "Authorization: Bearer $AIPIPE_TOKEN"
```

Or run specific tests, e.g. only OpenAI tests, via:

```bash
npm test -- --grep 'OpenAI'
```

5. Deploy to Cloudflare:

```bash
# Add secrets to production
npx wrangler secret put AIPIPE_SECRET
npx wrangler secret put ADMIN_EMAILS
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GEMINI_API_KEY

# Deploy
npm run deploy

# Test
BASE_URL=https://aipipe.org ADMIN_EMAILS=admin@example.com npm test
```

### Admin API

**`GET /admin/usage`**: Get historical usage of all users. Only for admins

```bash
curl https://aipipe.org/admin/usage -H "Authorization: Bearer $AIPIPE_TOKEN"
```

Response:

```jsonc
{
  "data": [{ "email": "test@example.com", "date": "2025-04-18", "cost": 25.5 } // ...
  ]
}
```

**`GET /admin/token?email=user@example.com`**: Generate a JWT token for any user. Only for admins.

```bash
curl "https://aipipe.org/admin/token?email=user@example.com" -H "Authorization: Bearer $AIPIPE_TOKEN"
```

Response:

```json
{ "token": "eyJhbGciOiJIUzI1NiI..." }
```

**`POST /admin/cost`**: Overwrite the cost usage for a user on a specific date. Only for admins.

```bash
curl https://aipipe.org/admin/cost \
  -H "Authorization: Bearer $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "date": "2025-04-18", "cost": 1.23}'
```

Response:

```json
{ "message": "Cost for user@example.com on 2025-04-18 set to 1.23" }
```

## Architecture

### File Structure

- `src/worker.js`: Main entry point. Handles authentication, proxying with streaming, cost tracking
- `src/providers.js`: Defines parameters for each LLM providers, e.g. endpoints, API keys, cost calculation
- `src/cost.js`: Tracks daily cost per user via Durable Objects
- `src/config.example.js`: Sample configuration to copy into `src/config.js`
- `src/utils.js`: Utilities to manage headers, etc.

### Database Schema

The `cost` table in Durable Objects stores:

```sql
CREATE TABLE cost (
  email TEXT,      -- User's email address
  date TEXT,       -- YYYY-MM-DD in UTC
  cost NUMBER,     -- Cumulative cost for the day
  PRIMARY KEY (email, date)
);
```

### Provider Interface

Each provider in `providers.js` implements:

```js
{
  base: "https://api.provider.com",     // Base URL to proxy to
  key: "PROVIDER_API_KEY",             // Environment variable with API key
  cost: async ({ model, usage }) => {  // Calculate cost for a request
    return {
      cost: /* Calculate cost based on prompt & completion tokens */
    }
  }
}
```

Add new providers by implementing this interface and adding routing in `worker.js`.

## Alternatives

AI Pipe is for _light, widespread use_, e.g. public demos and student assignments, where cost is low, frequency is low, and access is wide.

If you need production features, explore LLM Routers like:

- [litellm 21,852 ⭐ May 2025](https://github.com/BerriAI/litellm) (BerriAI). 100+ providers (OpenAI, Bedrock, Vertex, Groq, …). **Auth**: per-key, per-user, BYO provider keys, JWT or Basic for multi-tenant dashboards. **Rate-limit**: token/req budget per model/project, burst ceilings, fallback queue.
- [RouteLLM 3,886 ⭐ Aug 2024](https://github.com/lm-sys/RouteLLM) (LM-Sys). Custom providers (template: OpenAI, Anyscale). **Auth**: BYO provider keys via env vars. **Rate-limit**: none (relies on upstream or external proxy).
- [helicone 3,715 ⭐ May 2025](https://github.com/Helicone/helicone). 15+ providers (OpenAI, Anthropic, Bedrock, Groq, Gemini, …). **Auth**: Helicone org key + BYO provider keys. **Rate-limit**: soft limits via dashboard alerts, no enforced throttling (observability focus).
- [FastChat 38,506 ⭐ Apr 2025](https://github.com/lm-sys/FastChat). Local/remote self-hosted models (e.g., Mixtral, Llama). **Auth**: Bearer key pass-through. **Rate-limit**: none (use external proxy).
- [apisix 15,076 ⭐ Apr 2025](https://github.com/apache/apisix). 100+ providers via plugins (OpenAI, Claude, Gemini, Mistral, …). **Auth**: JWT, Key-Auth, OIDC, HMAC. **Rate-limit**: token/request per consumer/route, distributed leaky-bucket.
- [envoy 25,916 ⭐ May 2025](https://github.com/envoyproxy/envoy). Provider-agnostic (define clusters manually). **Auth**: mTLS, API key, OIDC via filters. **Rate-limit**: global/local via Envoy's rate-limit service.
- [openllmetry 5,752 ⭐ Apr 2025](https://github.com/traceloop/openllmetry). Configurable providers (OpenAI, Azure, Anthropic, local vLLM). **Auth**: OpenAI-style key, BYO keys. **Rate-limit**: Redis-backed token/RPS optional.
- [kong 40,746 ⭐ Apr 2025](https://github.com/Kong/kong). Multi-provider via "ai-llm-route" plugin. **Auth**: Key-Auth, ACL, OIDC via plugins. **Rate-limit**: per-key, per-route, cost-aware token limits.
- [semantic-router 2,569 ⭐ Apr 2025](https://github.com/aurelio-labs/semantic-router) (experimental). Embedding-based routing within apps (no external provider integration). **Auth**: n/a. **Rate-limit**: n/a.
- [unify 298 ⭐ May 2025](https://github.com/unifyai/unify). Providers wrapped via LiteLLM. **Auth**: Unify project key, BYO provider keys. **Rate-limit**: soft budget alerts; no enforced throttling yet.
- [OpenRouter](https://openrouter.ai/) (SaaS). 300+ models, 30+ providers. **Auth**: OpenRouter key, OAuth2, BYO provider keys. **Rate-limit**: credit-based (1 req/credit/s, 20 rpm free tier), DDOS protection.
- [Portkey Gateway](https://portkey.ai) (SaaS). 250+ providers & guard-rail plugins. **Auth**: Portkey API key, BYO keys, OAuth for teams. **Rate-limit**: sliding-window tokens, cost caps, programmable policy engine.
- [Martian Model Router](https://withmartian.com/) (SaaS, private). Dozens of commercial/open models (Accenture's "Switchboard"). **Auth**: Martian API key, BYO keys planned. **Rate-limit**: undisclosed; SLA-based dynamic throttling.
