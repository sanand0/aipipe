import pricing from "./pricing.json" assert { type: "json" };
import { updateHeaders } from "./utils.js";

const { openai: openaiCost, gemini: geminiCost } = pricing;

const withUser = (json, email) => email ? { ...json, user: email } : json;

const withOpenAIObservability = (json, email) =>
  email
    ? {
      ...json,
      store: true,
      metadata: {
        ...(json.metadata && typeof json.metadata == "object" && !Array.isArray(json.metadata) ? json.metadata : {}),
        aipipe_email: email,
      },
    }
    : json;

const tokenCost = (pricing, model, usage, requestedModel) => {
  const [input, output, audioInput = 0, audioOutput = 0] = pricing[model] ?? pricing[requestedModel]
    ?? [30, 180, 30, 180];

  // Check if we have detailed token breakdowns
  const hasInputDetails = usage?.prompt_tokens_details || usage?.input_token_details;
  const hasOutputDetails = usage?.completion_tokens_details;

  // Extract audio token counts from usage details
  const inputAudioTokens = usage?.prompt_tokens_details?.audio_tokens
    ?? usage?.input_token_details?.audio_tokens
    ?? 0;
  const outputAudioTokens = usage?.completion_tokens_details?.audio_tokens ?? 0;

  // Extract text token counts - if details exist but text_tokens is missing, compute it
  // Use Math.max(0, ...) to guard against malformed API responses where audio_tokens > total
  let inputTextTokens, outputTextTokens;

  if (hasInputDetails) {
    inputTextTokens = usage?.prompt_tokens_details?.text_tokens
      ?? usage?.input_token_details?.text_tokens
      ?? Math.max(0, (usage?.prompt_tokens ?? usage?.input_tokens ?? 0) - inputAudioTokens);
  } else {
    inputTextTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  }

  if (hasOutputDetails) {
    outputTextTokens = usage?.completion_tokens_details?.text_tokens
      ?? Math.max(0, (usage?.completion_tokens ?? usage?.output_tokens ?? 0) - outputAudioTokens);
  } else {
    outputTextTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  }

  // If we have token details (audio, reasoning, etc.), use detailed pricing
  const hasTokenDetails = inputAudioTokens > 0 || outputAudioTokens > 0 || hasInputDetails || hasOutputDetails;

  if (hasTokenDetails) {
    return (
      (inputTextTokens * input + inputAudioTokens * audioInput
          + outputTextTokens * output + outputAudioTokens * audioOutput)
        / 1e6 || 0
    );
  }

  // Fallback to simple calculation for models without token details
  return (
    ((usage?.prompt_tokens ?? usage?.input_tokens ?? 0) * input
        + (usage?.completion_tokens ?? usage?.output_tokens ?? 0) * output)
      / 1e6 || 0
  );
};

// Upper bound on a request's output cost, from the ceiling the caller declared.
// Returns null when there is no usable ceiling (absent, non-numeric, negative, or unpriced model):
// the request is then unbounded and this pre-check cannot apply. OpenAI rejects invalid values itself.
const openaiMaxOutputCost = (model, json) => {
  const limit = json.max_output_tokens ?? json.max_completion_tokens ?? json.max_tokens;
  const maximumTokens = typeof limit == "number" ? limit : typeof limit == "string" ? Number(limit) : NaN;
  const [, outputPrice] = openaiCost[model] ?? [];
  if (!Number.isFinite(maximumTokens) || maximumTokens < 0 || !Number.isFinite(outputPrice)) return null;
  return (maximumTokens * outputPrice) / 1e6;
};

const parseUsage = (u) =>
  u
    ? {
      ...u,
      prompt_tokens: u.prompt_tokens ?? u.promptTokenCount ?? u.input_tokens,
      completion_tokens: u.completion_tokens ?? u.candidatesTokenCount ?? u.output_tokens,
    }
    : undefined;

const promptBytes = (json) => new TextEncoder().encode(JSON.stringify(json)).length;

const estimateOpenrouterCost = async (json) => {
  const { pricing } = await getOpenrouterModel(json.model);
  if (!pricing) return;
  return promptBytes(json) * Number(pricing.prompt ?? 0)
    + Number(json.max_tokens ?? json.max_completion_tokens ?? 0) * Number(pricing.completion ?? 0)
    + Number(pricing.request ?? 0);
};

export const providers = {
  openrouter: {
    transform: async ({ path, request, env, nativeKey, email, budget }) => {
      let body;
      if (request.method == "POST") {
        if (!request.headers.get("Content-Type")?.includes("application/json")) {
          if (!nativeKey) {
            return { error: { code: 400, message: "Pass a JSON body with {model} so we can calculate cost" } };
          }
          body = await request.arrayBuffer();
        } else {
          const json = await request.json();
          if (!nativeKey && !json.model) {
            return { error: { code: 400, message: "Pass a JSON body with {model} so we can calculate cost" } };
          }
          const estimatedCost = nativeKey ? undefined : await estimateOpenrouterCost(json);
          if (!nativeKey && estimatedCost === undefined) {
            return { error: { code: 400, message: `Model ${json.model} pricing unknown` } };
          }
          if (budget && estimatedCost > budget.remaining) {
            return {
              error: {
                code: 429,
                message: `Estimated request cost $${estimatedCost.toFixed(6)} exceeds remaining budget $${
                  budget.remaining.toFixed(6)
                }`,
              },
            };
          }
          body = JSON.stringify(withUser(json, email));
        }
      }
      return {
        url: `https://openrouter.ai/api${path}`,
        headers: updateHeaders(
          request.headers,
          [],
          nativeKey
            ? { Authorization: `Bearer ${nativeKey}` }
            : {
              Authorization: `Bearer ${env["OPENROUTER_API_KEY"]}`,
              "HTTP-Referer": "https://aipipe.org/",
              "X-Title": "AIPipe",
            },
        ),
        ...(body ? { body } : {}),
      };
    },
    cost: async ({ model, usage, requestedModel }) => {
      if (usage?.cost != null) {
        const reportedCost = Number(usage.cost);
        if (!Number.isNaN(reportedCost)) return { cost: reportedCost };
      }
      // We can't look up https://openrouter.ai/api/v1/generation
      // It usually takes a few seconds to get updated. So we calculate the cost ourselves.
      let { pricing } = await getOpenrouterModel(model);
      if (!pricing && requestedModel) ({ pricing } = await getOpenrouterModel(requestedModel));
      pricing ??= { prompt: 30 / 1e6, completion: 180 / 1e6, internal_reasoning: 180 / 1e6, image: 180 / 1e6 };
      const cost = (usage?.prompt_tokens * pricing?.prompt || 0)
        + (usage?.completion_tokens * pricing?.completion || 0)
        + (usage?.completion_tokens_details?.reasoning_tokens * pricing?.internal_reasoning || 0)
        + (usage?.completion_tokens_details?.image_tokens * pricing?.image || 0)
        + (+pricing?.request || 0);
      return { cost };
    },
    parse: (event) => {
      event = event.response ?? event;
      return { ...event, usage: parseUsage(event.usage) };
    },
  },

  openai: {
    transform: async ({ path, request, env, nativeKey, email, budget }) => {
      let body;
      if (request.method == "POST") {
        // For chat POSTs, get { model }. Reject if model pricing unknown (unless using native key)
        if (!request.headers.get("Content-Type")?.includes("application/json")) {
          return { error: { code: 400, message: "Pass a JSON body with {model} so we can calculate cost" } };
        }
        let json = await request.json();
        // Skip pricing validation for native keys (user handles their own costs)
        if (!nativeKey && !openaiCost[json.model]) {
          return { error: { code: 400, message: `Model ${json.model} pricing unknown` } };
        }
        // budget is null for native keys, so this only applies to AIPipe-metered requests
        const outputCost = openaiMaxOutputCost(json.model, json);
        if (budget && outputCost !== null && outputCost > budget.remaining) {
          return {
            error: {
              code: 429,
              message: `Maximum output cost $${outputCost.toFixed(6)} exceeds remaining budget $${
                budget.remaining.toFixed(6)
              }. Reduce the output-token limit or choose a cheaper model.`,
            },
          };
        }

        // If streaming chat completion, request usage in the response
        if (json.stream && path.includes("chat/completions")) json.stream_options = { include_usage: true };
        if (path.includes("/chat/completions") || path.includes("/responses")) {
          json = withOpenAIObservability(json, email);
        } else if (path.includes("/embeddings")) json = withUser(json, email);
        body = JSON.stringify(json);
      }
      return {
        url: `https://api.openai.com${path}`,
        headers: updateHeaders(request.headers, [], {
          Authorization: `Bearer ${nativeKey ?? env["OPENAI_API_KEY"]}`,
        }),
        ...(body ? { body } : {}),
      };
    },
    cost: async ({ model, usage, requestedModel }) => ({ cost: tokenCost(openaiCost, model, usage, requestedModel) }),
    parse: (event) => {
      return { ...(event.response ?? event) };
    },
  },

  geminiv1beta: {
    transform: async ({ path, request, env, nativeKey }) => {
      let json, model;
      if (request.method == "POST" && request.headers.get("Content-Type")?.includes("application/json")) {
        // For chat POSTs, get { model }. Reject if model pricing unknown (unless using native key)
        json = await request.json();
        model = json.model ?? path.match(/models\/([^:]+)/)?.[1];
        // Skip pricing validation for native keys (user handles their own costs)
        if (!nativeKey && model && !geminiCost[model]) {
          return { error: { code: 400, message: `Model ${model} pricing unknown` } };
        }
      }
      // If OK, rewrite Authorization header
      return {
        url: `https://generativelanguage.googleapis.com/v1beta${path}`,
        headers: updateHeaders(request.headers, [/^authorization$/i], {
          "x-goog-api-key": nativeKey ?? env["GEMINI_API_KEY"],
        }),
        ...(json ? { body: JSON.stringify(json) } : {}),
      };
    },
    cost: async ({ model, usage, requestedModel, env, path, body }) => {
      model = geminiCost[model] ? model : requestedModel ?? path.match(/models\/([^:]+)/)?.[1];
      if (!usage && path.includes(":embedContent") && body) {
        try {
          const { content } = JSON.parse(body);
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": env["GEMINI_API_KEY"] },
            body: JSON.stringify({ contents: [content] }),
          });
          if (res.ok) usage = { prompt_tokens: (await res.json()).totalTokens };
        } catch {}
      }
      return { cost: tokenCost(geminiCost, model, usage) };
    },
    parse: (event) => {
      event = event.response ?? event;
      const usage = parseUsage(event.usage ?? event.usageMetadata);
      return { ...event, model: event.model ?? event.modelVersion, usage };
    },
  },

  similarity: {
    transform: async ({ request, env, nativeKey, email }) => {
      try {
        // Error handling common
        const { docs, topics, model = "text-embedding-3-small", precision = 5 } = await request.json();
        if (!Array.isArray(docs) || docs.length === 0) {
          return { error: { code: 400, message: "required: docs[] array" } };
        }

        const extractValue = (item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "type" in item && "value" in item) return item.value;
          throw new Error("Each doc must be a string or an object with {type, value}");
        };
        const processedDocs = docs.map(extractValue);
        const targetDocs = topics ? topics.map(extractValue) : processedDocs;

        const response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${nativeKey ?? env["OPENAI_API_KEY"]}`,
            ...(!nativeKey && env["OPENAI_ORG_ID"] && { "OpenAI-Organization": env["OPENAI_ORG_ID"] }),
          },
          body: JSON.stringify(withUser({ model, input: [...processedDocs, ...targetDocs] }, email)),
        });

        if (!response.ok) {
          const message = await response.text();
          return { error: { code: response.status, message } };
        }
        const result = await response.json();
        if (!Array.isArray(result?.data)) {
          return { error: { code: 500, message: "OpenAI result.data not an array" }, ...result };
        }

        const embeddings = result.data.map((d) => d.embedding);
        const docEmbeddings = embeddings.slice(0, processedDocs.length);
        const topicEmbeddings = topics ? embeddings.slice(processedDocs.length) : docEmbeddings;

        const similarity = docEmbeddings.map((docEmb) => {
          const docMagnitude = Math.sqrt(docEmb.reduce((sum, val) => sum + val * val, 0));
          return topicEmbeddings.map((topicEmb) => {
            const topicMagnitude = Math.sqrt(topicEmb.reduce((sum, val) => sum + val * val, 0));
            const dotProduct = docEmb.reduce((sum, val, i) => sum + val * topicEmb[i], 0);
            return Number((dotProduct / (docMagnitude * topicMagnitude)).toFixed(precision));
          });
        });

        const usage = { prompt_tokens: result.usage?.prompt_tokens ?? result.usage?.input_tokens ?? 0 };
        return { model, similarity, usage };
      } catch (error) {
        return { error: { code: 400, message: error.message } };
      }
    },

    cost: async ({ model, usage }) => ({ cost: tokenCost(openaiCost, model, usage) }),
  },
};

let openrouterModels;

async function getOpenrouterModel(model) {
  // If we need to look up a model (and it's not present), download model list again
  if (model && (!openrouterModels || !openrouterModels?.data.find((d) => d.id == model))) {
    openrouterModels = await fetch("https://openrouter.ai/api/v1/models").then((res) => res.json());
  }
  return openrouterModels?.data?.find?.((d) => d.id == model) ?? {};
}

// TODO: Only allow models for which { usage } is in the response
// https://platform.openai.com/docs/pricing

export function sseTransform(provider, addCost) {
  const parse = providers[provider]?.parse;
  let model, usage;
  return new TransformStream({
    start() {
      this.buffer = "";
    },
    transform(chunk, controller) {
      const lines = (this.buffer + new TextDecoder().decode(chunk, { stream: true })).split("\n");
      this.buffer = lines.pop() || "";
      lines.forEach((line) => {
        if (line.startsWith("data: ")) {
          try {
            const parsed = parse?.(JSON.parse(line.slice(6)));
            model = model ?? parsed?.model;
            usage = usage ?? parsed?.usage;
          } catch {}
        }
      });
      controller.enqueue(chunk);
    },
    async flush() {
      await addCost({ model, usage });
    },
  });
}
