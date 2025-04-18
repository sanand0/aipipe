import { updateHeaders } from "./utils.js";

export const providers = {
  openrouter: {
    transform: async ({ path, request, env }) => ({
      url: `https://openrouter.ai/api${path}`,
      headers: updateHeaders(request.headers, [], { Authorization: `Bearer ${env["OPENROUTER_API_KEY"]}` }),
      ...(request.method == "POST" ? { body: await request.arrayBuffer() } : {}),
    }),
    cost: async ({ model, usage }) => {
      const { pricing } = await getOpenrouterModel(model);
      return (
        (usage?.prompt_tokens * pricing?.prompt || 0) +
        (usage?.completion_tokens * pricing?.completion || 0) +
        (+pricing?.request || 0)
      );
    },
  },

  openai: {
    transform: async ({ path, request, env }) => {
      let body;
      if (request.method == "POST") {
        if (!request.headers.get("Content-Type")?.includes("application/json"))
          return { error: { code: 400, message: "Pass a JSON body with {model} so we can calculate cost" } };
        const json = await request.json();
        if (!openaiCost[json.model]) return { error: { code: 400, message: `Model ${json.model} pricing unknown` } };
        if (json.stream && path.includes("chat/completions")) json.stream_options = { include_usage: true };
        body = JSON.stringify(json);
      }
      return {
        url: `https://api.openai.com${path}`,
        headers: updateHeaders(request.headers, [], { Authorization: `Bearer ${env["OPENAI_API_KEY"]}` }),
        ...(body ? { body } : {}),
      };
    },
    cost: async ({ model, usage }) => {
      const [input, output] = openaiCost[model] ?? [0, 0];
      // Chat Completion usage: { prompt_tokens, completion_tokens }
      // Responses API usage: {input_tokens, output_tokens}
      return {
        cost:
          ((usage?.prompt_tokens ?? usage?.input_tokens) * input || 0) +
          ((usage?.completion_tokens ?? usage?.output_tokens) * output || 0),
      };
    },
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
const openaiCost = {
  "chatgpt-4o-latest": [5, 15],
  "computer-use-preview-2025-03-11": [3, 12],
  "computer-use-preview": [3, 12],
  "gpt-3.5-turbo-0125": [0.5, 1.5],
  "gpt-3.5-turbo-0301": [1.5, 2],
  "gpt-3.5-turbo-0613": [1.5, 2],
  "gpt-3.5-turbo-1106": [1, 2],
  "gpt-3.5-turbo-16k-0613": [3, 4],
  "gpt-3.5-turbo-16k": [3, 4],
  "gpt-3.5-turbo-instruct": [1.5, 2],
  "gpt-3.5-turbo": [0.5, 1.5],
  "gpt-4-0125-preview": [10, 30],
  "gpt-4-0613": [30, 60],
  "gpt-4-1106-preview": [10, 30],
  "gpt-4-1106-vision-preview": [10, 30],
  "gpt-4-32k-0314": [60, 120],
  "gpt-4-32k-0613": [60, 120],
  "gpt-4-32k": [60, 120],
  "gpt-4-turbo-2024-04-09": [10, 20],
  "gpt-4-turbo-preview": [10, 30],
  "gpt-4-turbo": [10, 30],
  "gpt-4-vision-preview": [10, 30],
  "gpt-4.1-2025-04-14": [2, 8],
  "gpt-4.1-mini-2025-04-14": [0.4, 1.6],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1-nano-2025-04-14": [0.1, 0.4],
  "gpt-4.1-nano": [0.1, 0.4],
  "gpt-4.1": [2, 8],
  "gpt-4.5-preview-2025-02-27": [75, 150],
  "gpt-4.5-preview": [75, 150],
  "gpt-4": [10, 20],
  "gpt-4o-2024-05-13": [5, 15],
  "gpt-4o-2024-08-06": [2.5, 10],
  "gpt-4o-2024-11-20": [2.5, 10],
  "gpt-4o-audio-preview-2024-10-01": [2.5, 10],
  "gpt-4o-audio-preview-2024-12-17": [2.5, 10],
  "gpt-4o-audio-preview": [2.5, 10],
  "gpt-4o-mini-2024-07-18": [0.15, 0.6],
  "gpt-4o-mini-audio-preview-2024-12-17": [0.15, 0.6],
  "gpt-4o-mini-audio-preview": [0.15, 0.6],
  "gpt-4o-mini-realtime-preview-2024-12-17": [0.6, 2.4],
  "gpt-4o-mini-realtime-preview": [0.6, 2.4],
  "gpt-4o-mini-search-preview-2025-03-11": [0.15, 0.6],
  "gpt-4o-mini-search-preview": [0.15, 0.6],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o-realtime-preview-2024-10-01": [5, 20],
  "gpt-4o-realtime-preview-2024-12-17": [5, 20],
  "gpt-4o-realtime-preview": [5, 20],
  "gpt-4o-search-preview-2025-03-11": [2.5, 10],
  "gpt-4o-search-preview": [2.5, 10],
  "gpt-4o": [2.5, 10],
  "o1-2024-12-17": [15, 60],
  "o1-mini-2024-09-12": [1.1, 4.4],
  "o1-mini": [1.1, 4.4],
  "o1-preview-2024-09-12": [15, 60],
  "o1-preview": [15, 60],
  "o1-pro-2025-03-19": [150, 600],
  "o1-pro": [150, 600],
  "o3-2025-04-16": [10, 40],
  "o3-mini-2025-01-31": [1.1, 4.4],
  "o3-mini": [1.1, 4.4],
  "o4-mini-2025-04-16": [1.1, 4.4],
  "o4-mini": [1.1, 4.4],
  "tts-1-hd": [0, 30],
  "tts-1": [0, 15],
  o1: [15, 60],
  o3: [10, 40],
  // "text-embedding-3-large": [0.13, 0],
  // "text-embedding-3-small": [0.02, 0],
  // "text-embedding-ada-002": [0.1, 0],
};
