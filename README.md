# AI Pipe

AI Pipe lets you build web apps that can access LLM APIs (e.g. OpenRouter, OpenAI etc.) without a back-end.

An instance is hosted at <https://aipipe.org/>. You can host your own on CloudFlare. Licensed under [MIT](LICENSE).

## User Guide

Visit these pages:

- **[aipipe.org](https://aipipe.org/)** to understand how it works.
- **[aipipe.org/login](https://aipipe.org/login)** with a Google Account to get your AI Pipe Token and track your usage.
- **[aipipe.org/playground](https://aipipe.org/playground)** to explore models and chat with them.

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
curl https://aipipe.org/usage -H "Authorization: $AIPIPE_TOKEN"
```

Response:

```json
{
  "email": "user@example.com",
  "days": 7,
  "cost": 0.000137,
  "usage": [
    {
      "date": "2025-04-16",
      "cost": 0.000137
    }
  ],
  "limit": 0.1
}
```

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
curl https://aipipe.org/openrouter/v1/models -H "Authorization: $AIPIPE_TOKEN"
```

Response:

```json
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
curl https://aipipe.org/openrouter/v1/chat/completions -H "Authorization: $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "google/gemini-2.0-flash-lite-001", "messages": [{ "role": "user", "content": "What is 2 + 2?" }] }'
```

Response:

```json
{
  "id": "gen-...",
  "provider": "Google",
  "model": "google/gemini-2.0-flash-lite-001",
  "object": "chat.completion"
  // ...
}
```

### OpenAI API

**`GET /openai/*`**: Proxy requests to OpenAI

**Example**: List [OpenAI models](https://platform.openai.com/docs/api-reference/models)

```bash
curl https://aipipe.org/openai/v1/models -H "Authorization: $AIPIPE_TOKEN"
```

Response:

```json
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
curl https://aipipe.org/openai/v1/responses -H "Authorization: $AIPIPE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4.1-nano", "input": "What is 2 + 2?" }'
```

Response:

```json
{
  "id": "resp_...",
  "object": "response",
  "model": "gpt-4.1-nano-2025-04-14",
  // ...
  "output": [
    {
      "role": "assistant",
      "content": [{ "text": "2 + 2 equals 4." }]
      // ...
    }
  ]
}
```

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

2. Configure budgets and security in `src/config.js`. For example:

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

# Optional: Add only the APIs you need
OPENROUTER_API_KEY=sk-or-v1-...  # via openrouter.ai/settings
OPENAI_API_KEY=sk-...            # via platform.openai.com/api-keys
```

4. Test your deployment:

```bash
npm run dev   # Runs at http://localhost:8787
npm test      # Run all tests
curl http://localhost:8787/usage -H "Authorization: $AIPIPE_TOKEN"
```

5. Deploy to Cloudflare:

```bash
# Add secrets to production
npx wrangler secret put AIPIPE_SECRET
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put OPENAI_API_KEY

# Deploy
npm run deploy

# Test
BASE_URL=https://aipipe.org npm test
```

## Architecture

### File Structure

- `src/worker.js`: Main entry point. Handles authentication, proxying with streaming, cost tracking
- `src/providers.js`: Defines parameters for each LLM providers, e.g. endpoints, API keys, cost calculation
- `src/cost.js`: Tracks daily cost per user via Durable Objects
- `src/config.js`: Configuration for budget limits by user/domain, token invalidation
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
