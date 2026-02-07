/**
 * Provider quota fetchers for openclaw-smart-router
 *
 * Fetches actual quota/usage data from provider APIs where available.
 * For providers without usage APIs, we track usage ourselves via hooks.
 */

import { log } from "../../logger.js";
import type { QuotaInfo } from "../../types.js";

export interface QuotaFetchResult {
  success: boolean;
  quota?: {
    limit: number;
    used: number;
    remaining: number;
    quotaType: "tokens" | "requests" | "budget";
    resetAt?: Date;
  };
  error?: string;
}

export interface QuotaFetcher {
  provider: string;
  fetch(apiKey: string): Promise<QuotaFetchResult>;
}

// =============================================================================
// OpenRouter Fetcher (confirmed working)
// =============================================================================

export const openRouterFetcher: QuotaFetcher = {
  provider: "openrouter",

  async fetch(apiKey: string): Promise<QuotaFetchResult> {
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!resp.ok) {
        return {
          success: false,
          error: `API returned ${resp.status}: ${resp.statusText}`,
        };
      }

      const data = (await resp.json()) as {
        data?: {
          limit?: number;
          limit_remaining?: number;
          usage?: number;
          is_free_tier?: boolean;
        };
      };

      if (!data.data) {
        return { success: false, error: "Unexpected response format" };
      }

      const { limit, limit_remaining, usage } = data.data;

      // OpenRouter uses USD for budget
      return {
        success: true,
        quota: {
          limit: limit ?? 0,
          used: usage ?? 0,
          remaining: limit_remaining ?? 0,
          quotaType: "budget",
          // OpenRouter doesn't have a fixed reset schedule
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// =============================================================================
// Provider Registry
// =============================================================================

const fetchers: Record<string, QuotaFetcher> = {
  openrouter: openRouterFetcher,
};

/**
 * Check if a provider has an API-based quota fetcher
 */
export function hasQuotaFetcher(provider: string): boolean {
  return provider in fetchers;
}

/**
 * Fetch quota from a provider API
 */
export async function fetchProviderQuota(
  provider: string,
  apiKey: string
): Promise<QuotaFetchResult> {
  const fetcher = fetchers[provider];
  if (!fetcher) {
    return {
      success: false,
      error: `No quota fetcher available for provider: ${provider}`,
    };
  }

  log.debug(`fetching quota for ${provider} via API`);
  return fetcher.fetch(apiKey);
}

// =============================================================================
// OpenClaw Built-in Usage Tracking
// =============================================================================

// Re-export OpenClaw usage fetcher
export {
  fetchOpenClawUsage,
  getProviderUsage,
  parseModelsOutput,
  type ProviderUsage,
  type UsageWindow,
} from "./openclaw.js";

// =============================================================================
// Provider Tracking Methods
// =============================================================================

/**
 * Providers with OpenClaw built-in usage tracking.
 * OpenClaw fetches real-time quota from provider APIs:
 * - Anthropic: claude.ai/api/organizations/{orgId}/usage
 * - Codex: chatgpt.com/backend-api/wham/usage
 * - Copilot, Gemini, Z.ai, MiniMax also have fetchers
 *
 * Unfortunately this data isn't exposed to plugins via the SDK.
 * We can parse `openclaw models` output to get this data.
 */
export const OPENCLAW_TRACKED_PROVIDERS = [
  "anthropic",
  "openai-codex",
  "google",
  "zai",
  "github-copilot",
] as const;

/**
 * Providers we track ourselves via llm_end hooks.
 * For providers not tracked by OpenClaw or where we need more granular data.
 */
export const SELF_TRACKED_PROVIDERS = [
  "kimi", // No known usage API
] as const;

/**
 * Get a note about how a provider's usage is tracked
 */
export function getTrackingNote(provider: string): string {
  if (hasQuotaFetcher(provider)) {
    return "Usage fetched from API";
  }

  if (SELF_TRACKED_PROVIDERS.includes(provider as (typeof SELF_TRACKED_PROVIDERS)[number])) {
    return "Usage tracked locally via hooks (API unavailable)";
  }

  return "Unknown tracking method";
}
