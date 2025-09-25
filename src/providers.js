import { updateHeaders } from "./utils.js";
import pricing from "./pricing.json" assert { type: "json" };

const { openai: openaiCost, gemini: geminiCost } = pricing;

const tokenCost = (pricing, model, usage) => {
  const [input, output] = pricing[model] ?? [0, 0];
  return (
    ((usage?.prompt_tokens ?? usage?.input_tokens ?? 0) * input +
      (usage?.completion_tokens ?? usage?.output_tokens ?? 0) * output) /
      1e6 || 0
  );
};

const parseUsage = (u) =>
  u
    ? {
        prompt_tokens: u.prompt_tokens ?? u.promptTokenCount ?? u.input_tokens,
        completion_tokens: u.completion_tokens ?? u.candidatesTokenCount ?? u.output_tokens,
      }
    : undefined;

export const providers = {
  openrouter: {
    transform: async ({ path, request, env }) => ({
      url: `https://openrouter.ai/api${path}`,
      headers: updateHeaders(request.headers, [], {
        Authorization: `Bearer ${env["OPENROUTER_API_KEY"]}`,
        "HTTP-Referer": "https://aipipe.org/",
        "X-Title": "AIPipe",
      }),
      ...(request.method == "POST" ? { body: await request.arrayBuffer() } : {}),
    }),
    cost: async ({ model, usage }) => {
      // We can't look up https://openrouter.ai/api/v1/generation
      // It usually takes a few seconds to get updated. So we calculate the cost ourselves.
      const { pricing } = await getOpenrouterModel(model);
      const cost =
        (usage?.prompt_tokens * pricing?.prompt || 0) +
        (usage?.completion_tokens * pricing?.completion || 0) +
        (usage?.completion_tokens_details?.reasoning_tokens * pricing?.internal_reasoning || 0) +
        (usage?.completion_tokens_details?.image_tokens * pricing?.image || 0) +
        (+pricing?.request || 0);
      return { cost };
    },
    parse: (event) => {
      event = event.response ?? event;
      return { ...event, usage: parseUsage(event.usage) };
    },
  },

  openai: {
    transform: async ({ path, request, env }) => {
      let body;
      if (request.method == "POST") {
        // For chat POSTs, get { model }. Reject if model pricing unknown
        if (!request.headers.get("Content-Type")?.includes("application/json"))
          return { error: { code: 400, message: "Pass a JSON body with {model} so we can calculate cost" } };
        const json = await request.json();
        if (!openaiCost[json.model]) return { error: { code: 400, message: `Model ${json.model} pricing unknown` } };

        // If streaming chat completion, request usage in the response
        if (json.stream && path.includes("chat/completions")) json.stream_options = { include_usage: true };
        body = JSON.stringify(json);
      }
      return {
        url: `https://api.openai.com${path}`,
        headers: updateHeaders(request.headers, [], { Authorization: `Bearer ${env["OPENAI_API_KEY"]}` }),
        ...(body ? { body } : {}),
      };
    },
    cost: async ({ model, usage }) => ({ cost: tokenCost(openaiCost, model, usage) }),
    parse: (event) => {
      return { ...(event.response ?? event) };
    },
  },

  geminiv1beta: {
    transform: async ({ path, request, env }) => {
      let json, model;
      if (request.method == "POST" && request.headers.get("Content-Type")?.includes("application/json")) {
        // For chat POSTs, get { model }. Reject if model pricing unknown
        json = await request.json();
        model = json.model ?? path.match(/models\/([^:]+)/)?.[1];
        if (model && !geminiCost[model]) return { error: { code: 400, message: `Model ${model} pricing unknown` } };
      }
      // If OK, rewrite Authorization header
      return {
        url: `https://generativelanguage.googleapis.com/v1beta${path}`,
        headers: updateHeaders(request.headers, [/^authorization$/i], { "x-goog-api-key": env["GEMINI_API_KEY"] }),
        ...(json ? { body: JSON.stringify(json) } : {}),
      };
    },
    cost: async ({ model, usage, env, path, body }) => {
      model = model ?? path.match(/models\/([^:]+)/)?.[1];
      if (!geminiCost[model]) return { cost: 0 };
      if (!usage && path.includes(":embedContent") && body)
        try {
          const { content } = JSON.parse(body);
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": env["GEMINI_API_KEY"] },
            body: JSON.stringify({ contents: [content] }),
          });
          if (res.ok) usage = { prompt_tokens: (await res.json()).totalTokens };
        } catch {}
      return { cost: tokenCost(geminiCost, model, usage) };
    },
    parse: (event) => {
      event = event.response ?? event;
      const usage = parseUsage(event.usage ?? event.usageMetadata);
      return { ...event, model: event.model ?? event.modelVersion, usage };
    },
  },

  similarity: {
    transform: async ({ request, env }) => {
      try {
        // Error handling common
        const { docs, topics, model = "text-embedding-3-small", precision = 5 } = await request.json();
        if (!Array.isArray(docs) || docs.length === 0)
          return { error: { code: 400, message: "required: docs[] array" } };

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
            Authorization: `Bearer ${env["OPENAI_API_KEY"]}`,
            ...(env["OPENAI_ORG_ID"] && { "OpenAI-Organization": env["OPENAI_ORG_ID"] }),
          },
          body: JSON.stringify({ model, input: [...processedDocs, ...targetDocs] }),
        });

        if (!response.ok) {
          const message = await response.text();
          return { error: { code: response.status, message } };
        }
        const result = await response.json();
        if (!Array.isArray(result?.data))
          return { error: { code: 500, message: "OpenAI result.data not an array" }, ...result };

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
  if (model && (!openrouterModels || !openrouterModels?.data.find((d) => d.id == model)))
    openrouterModels = await fetch("https://openrouter.ai/api/v1/models").then((res) => res.json());
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
        if (line.startsWith("data: "))
          try {
            const parsed = parse?.(JSON.parse(line.slice(6)));
            model = model ?? parsed?.model;
            usage = usage ?? parsed?.usage;
          } catch {}
      });
      controller.enqueue(chunk);
    },
    async flush() {
      await addCost({ model, usage });
    },
  });
}
