import Anthropic from "@anthropic-ai/sdk";
import type { AiProviderClient, AiCompletionRequest } from "../types";
import { createProviderFactory } from "../providerFactory";

const factory = createProviderFactory(
  (apiKey) => new Anthropic({ apiKey, dangerouslyAllowBrowser: true }),
);

/**
 * Claude Opus 5 and Sonnet 5 think by default, and `max_tokens` bounds thinking
 * and response text together — under the old 1024 a thinking model could spend
 * the whole budget reasoning and return nothing. Haiku 4.5 does not think, so
 * it simply never reaches this ceiling.
 */
const DEFAULT_MAX_TOKENS = 8192;

export function createClaudeProvider(apiKey: string, model: string): AiProviderClient {
  const client = factory.getClient(apiKey);

  return {
    async complete(req: AiCompletionRequest): Promise<string> {
      const response = await client.messages.create({
        model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: req.systemPrompt,
        messages: [{ role: "user", content: req.userContent }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock?.text ?? "";
    },

    async testConnection(): Promise<boolean> {
      try {
        await client.messages.create({
          model,
          // Thinking counts against this budget, so a 10-token ceiling would
          // fail the connection test on the thinking models.
          max_tokens: 512,
          messages: [{ role: "user", content: "Say hi" }],
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function clearClaudeProvider(): void {
  factory.clear();
}
