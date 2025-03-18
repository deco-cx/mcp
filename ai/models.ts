import { createAnthropic as anthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI as google } from "@ai-sdk/google";
import { createOpenAI as openai } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";

interface AIGatewayOptions {
  accountId: string;
  gatewayId: string;
  provider: string;
  apiKey: string;
}

const aiGatewayForProvider = (
  { accountId, gatewayId, provider }: AIGatewayOptions,
) =>
  `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}`;

type ProviderFactory = (opts: AIGatewayOptions) => (model: string) => LanguageModelV1;

type NativeLLMCreator = <TOpts extends { baseURL: string; apiKey: string }>(
  opts: TOpts,
) => (model: string) => LanguageModelV1;

/**
 * Supported providers for the AI Gateway
 */
const providers: Record<string, NativeLLMCreator> = {
  anthropic,
  google,
  openai,
} as const;

export const createLLM: ProviderFactory = (opts) => {
  const provider = providers[opts.provider];
  if (!provider) {
    throw new Error(`Provider ${opts.provider} not supported`);
  }
  return provider({ apiKey: opts.apiKey, baseURL: aiGatewayForProvider(opts) });
};
