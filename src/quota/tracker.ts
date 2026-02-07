/**
 * Quota tracking for openclaw-smart-router
 *
 * Tracks token/request usage across providers via hooks
 */

import type {
  RouterState,
  SmartRouterConfig,
  UsageRecord,
  QuotaInfo,
} from "../types.js";
import { recordUsage } from "../storage/state.js";
import { log } from "../logger.js";

// =============================================================================
// Usage Extraction
// =============================================================================

interface LLMResponse {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Extract token usage from an LLM response
 */
export function extractUsage(response: unknown): {
  tokensIn: number;
  tokensOut: number;
} | null {
  if (!response || typeof response !== "object") {
    return null;
  }

  const resp = response as LLMResponse;
  if (!resp.usage) {
    return null;
  }

  // OpenAI format
  if (resp.usage.prompt_tokens !== undefined) {
    return {
      tokensIn: resp.usage.prompt_tokens,
      tokensOut: resp.usage.completion_tokens ?? 0,
    };
  }

  // Anthropic format
  if (resp.usage.input_tokens !== undefined) {
    return {
      tokensIn: resp.usage.input_tokens,
      tokensOut: resp.usage.output_tokens ?? 0,
    };
  }

  // Generic total
  if (resp.usage.total_tokens !== undefined) {
    // Assume 50/50 split if we only have total
    const half = Math.floor(resp.usage.total_tokens / 2);
    return {
      tokensIn: half,
      tokensOut: resp.usage.total_tokens - half,
    };
  }

  return null;
}

/**
 * Determine provider from model ID
 */
export function inferProviderFromModel(model: string): string {
  // Check for provider prefix
  if (model.includes("/")) {
    const [provider] = model.split("/");
    return provider;
  }

  // Infer from model name patterns
  if (model.startsWith("claude")) {
    return "anthropic";
  }
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) {
    return "openai";
  }
  if (model.startsWith("gemini")) {
    return "google";
  }
  if (model.startsWith("glm")) {
    return "zai";
  }
  if (model.startsWith("kimi")) {
    return "kimi";
  }

  return "unknown";
}

// =============================================================================
// Quota Tracker
// =============================================================================

export class QuotaTracker {
  private config: SmartRouterConfig;
  private state: RouterState;
  private onStateChange: () => void;

  constructor(
    config: SmartRouterConfig,
    state: RouterState,
    onStateChange: () => void
  ) {
    this.config = config;
    this.state = state;
    this.onStateChange = onStateChange;
  }

  /**
   * Record usage from an LLM call
   */
  record(
    provider: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
    source: "cron" | "agent" | "interactive",
    sourceId?: string,
    cost?: number
  ): void {
    const record: UsageRecord = {
      timestamp: Date.now(),
      provider,
      model,
      tokensIn,
      tokensOut,
      cost,
      source,
      sourceId,
    };

    recordUsage(this.state, record);
    this.onStateChange();

    log.debug(
      `recorded usage: ${provider}/${model} in=${tokensIn} out=${tokensOut} source=${source}`
    );

    // Check for warnings
    this.checkThresholds(provider);
  }

  /**
   * Check if a provider has crossed warning thresholds
   */
  private checkThresholds(provider: string): void {
    const quota = this.state.quotas[provider];
    if (!quota || quota.limit === 0) return;

    const percentUsed = quota.used / quota.limit;

    if (percentUsed >= 1) {
      log.warn(`provider ${provider} has EXHAUSTED its quota`);
    } else if (percentUsed >= this.config.criticalThreshold) {
      log.warn(
        `provider ${provider} quota CRITICAL: ${(percentUsed * 100).toFixed(1)}% used`
      );
    } else if (percentUsed >= this.config.warningThreshold) {
      log.info(
        `provider ${provider} quota warning: ${(percentUsed * 100).toFixed(1)}% used`
      );
    }
  }

  /**
   * Get current quota info for a provider
   */
  getQuotaInfo(provider: string): QuotaInfo | null {
    const quota = this.state.quotas[provider];
    const providerConfig = this.config.providers[provider];

    if (!quota) return null;

    return {
      provider,
      quotaType: providerConfig?.quotaType ?? "tokens",
      limit: quota.limit,
      used: quota.used,
      remaining: Math.max(0, quota.limit - quota.used),
      percentUsed: quota.limit > 0 ? quota.used / quota.limit : 0,
      resetAt: quota.nextReset > 0 ? new Date(quota.nextReset) : undefined,
      lastUpdated: new Date(this.state.lastUpdated),
    };
  }

  /**
   * Get all quota info
   */
  getAllQuotaInfo(): QuotaInfo[] {
    return Object.keys(this.state.quotas)
      .map((p) => this.getQuotaInfo(p))
      .filter((q): q is QuotaInfo => q !== null);
  }

  /**
   * Set manual usage for a provider
   */
  setUsage(provider: string, used: number): void {
    if (!this.state.quotas[provider]) {
      log.warn(`cannot set usage for unknown provider: ${provider}`);
      return;
    }

    this.state.quotas[provider].used = used;
    this.onStateChange();
    this.checkThresholds(provider);
  }

  /**
   * Reset quota for a provider (after quota reset time)
   */
  resetQuota(provider: string): void {
    if (!this.state.quotas[provider]) {
      log.warn(`cannot reset quota for unknown provider: ${provider}`);
      return;
    }

    this.state.quotas[provider].used = 0;
    this.state.quotas[provider].lastReset = Date.now();
    this.onStateChange();

    log.info(`reset quota for ${provider}`);
  }

  /**
   * Calculate average daily usage for a provider
   */
  getAverageDailyUsage(provider: string, days: number = 7): number {
    const windowMs = days * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    const records = this.state.usageHistory.filter(
      (r) => r.provider === provider && r.timestamp >= cutoff
    );

    if (records.length === 0) return 0;

    const totalTokens = records.reduce(
      (sum, r) => sum + r.tokensIn + r.tokensOut,
      0
    );

    // Calculate actual days covered
    const firstRecord = Math.min(...records.map((r) => r.timestamp));
    const daysCovered = Math.max(1, (Date.now() - firstRecord) / (24 * 60 * 60 * 1000));

    return totalTokens / daysCovered;
  }

  /**
   * Get usage trend
   */
  getUsageTrend(
    provider: string
  ): "increasing" | "stable" | "decreasing" {
    const recentAvg = this.getAverageDailyUsage(provider, 3);
    const olderAvg = this.getAverageDailyUsage(provider, 7);

    if (olderAvg === 0) return "stable";

    const ratio = recentAvg / olderAvg;

    if (ratio > 1.2) return "increasing";
    if (ratio < 0.8) return "decreasing";
    return "stable";
  }
}
