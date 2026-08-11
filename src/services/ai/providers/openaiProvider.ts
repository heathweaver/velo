import OpenAI from "openai";
import type { AiProviderClient, AiCompletionRequest } from "../types";
import { createProviderFactory } from "../providerFactory";

const factory = createProviderFactory(
  (apiKey) => new OpenAI({ apiKey, dangerouslyAllowBrowser: true }),
);

/**
 * `max_tokens` is deprecated on chat completions and rejected outright by the
 * reasoning models, which is every current OpenAI model. Its replacement,
 * `max_completion_tokens`, covers reasoning tokens as well as visible output,
 * so the old 1024 could be spent entirely on reasoning and return an empty
 * string; the budget is raised to leave room for the answer.
 */
const DEFAULT_MAX_COMPLETION_TOKENS = 8192;

export function createOpenAIProvider(apiKey: string, model: string): AiProviderClient {
  const client = factory.getClient(apiKey);

  return {
    async complete(req: AiCompletionRequest): Promise<string> {
      const response = await client.chat.completions.create({
        model,
        max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: req.userContent },
        ],
      });

      return response.choices[0]?.message?.content ?? "";
    },

    async testConnection(): Promise<boolean> {
      try {
        await client.chat.completions.create({
          model,
          // Reasoning tokens count against this budget, so a 10-token ceiling
          // would fail the connection test on every current model.
          max_completion_tokens: 512,
          messages: [{ role: "user", content: "Say hi" }],
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function clearOpenAIProvider(): void {
  factory.clear();
}
