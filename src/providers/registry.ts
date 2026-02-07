/**
 * Provider registry for openclaw-smart-router
 *
 * Manages all available providers and their configurations
 */

import type {
  ProviderConfig,
  ProviderTier,
  QuotaInfo,
  BudgetInfo,
  SmartRouterConfig,
  RouterState,
} from "../types.js";
import { log } from "../logger.js";

// =============================================================================
// Known Provider Defaults
// =============================================================================

/**
 * Default configurations for well-known providers
 */
const KNOWN_PROVIDERS: Record<string, Partial<ProviderConfig>> = {
  "anthropic": {
    tier: "premium",
    priority: 100,
    quotaType: "tokens",
  },
  "openai-codex": {
    tier: "premium",
    priority: 95,
    quotaType: "tokens",
  },
  "openai": {
    tier: "standard",
    priority: 80,
    quotaType: "tokens",
  },
  "google": {
    tier: "free",
    priority: 60,
    quotaType: "requests",
  },
  "openrouter": {
    tier: "budget",
    priority: 50,
    quotaType: "tokens",
  },
  "zai": {
    tier: "free",
    priority: 40,
    quotaType: "tokens",
  },
  "kimi": {
    tier: "free",
    priority: 35,
    quotaType: "tokens",
  },
  "local": {
    tier: "local",
    priority: 30,
    quotaSource: "unlimited",
  },
};

// =============================================================================
// Provider Registry
// =============================================================================

export interface RegisteredProvider {
  id: string;
  config: ProviderConfig;
  models: string[];
  isLocal: boolean;
  isAvailable: boolean;
}

export class ProviderRegistry {
  private providers: Map<string, RegisteredProvider> = new Map();
  private config: SmartRouterConfig;

  constructor(config: SmartRouterConfig) {
    this.config = config;
  }

  /**
   * Register a provider
   */
  register(id: string, config: ProviderConfig, models: string[] = []): void {
    const defaults = KNOWN_PROVIDERS[id] ?? {};
    const merged: ProviderConfig = {
      ...defaults,
      ...config,
    };

    this.providers.set(id, {
      id,
      config: merged,
      models,
      isLocal: merged.tier === "local" || merged.local !== undefined,
      isAvailable: true,
    });

    log.debug(`registered provider: ${id} (tier: ${merged.tier})`);
  }

  /**
   * Get a provider by ID
   */
  get(id: string): RegisteredProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Get all registered providers
   */
  getAll(): RegisteredProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get providers by tier
   */
  getByTier(tier: ProviderTier): RegisteredProvider[] {
    return this.getAll().filter((p) => p.config.tier === tier);
  }

  /**
   * Get providers sorted by priority (descending)
   */
  getSortedByPriority(): RegisteredProvider[] {
    return this.getAll().sort(
      (a, b) => (b.config.priority ?? 50) - (a.config.priority ?? 50)
    );
  }

  /**
   * Get available providers (not exhausted)
   */
  getAvailable(state: RouterState): RegisteredProvider[] {
    return this.getAll().filter((p) => {
      if (!p.isAvailable) return false;

      // Check quota
      const quota = state.quotas[p.id];
      if (quota && quota.limit > 0) {
        const percentUsed = quota.used / quota.limit;
        if (percentUsed >= 1) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Get local providers
   */
  getLocal(): RegisteredProvider[] {
    return this.getAll().filter((p) => p.isLocal);
  }

  /**
   * Mark a provider as unavailable
   */
  setAvailable(id: string, available: boolean): void {
    const provider = this.providers.get(id);
    if (provider) {
      provider.isAvailable = available;
      log.debug(`provider ${id} availability: ${available}`);
    }
  }

  /**
   * Add models to a provider
   */
  addModels(id: string, models: string[]): void {
    const provider = this.providers.get(id);
    if (provider) {
      const existing = new Set(provider.models);
      for (const m of models) {
        existing.add(m);
      }
      provider.models = Array.from(existing);
    }
  }

  /**
   * Get quota info for a provider
   */
  getQuotaInfo(id: string, state: RouterState): QuotaInfo | null {
    const provider = this.providers.get(id);
    if (!provider) return null;

    const quota = state.quotas[id];
    if (!quota) return null;

    return {
      provider: id,
      quotaType: provider.config.quotaType ?? "tokens",
      limit: quota.limit,
      used: quota.used,
      remaining: Math.max(0, quota.limit - quota.used),
      percentUsed: quota.limit > 0 ? quota.used / quota.limit : 0,
      resetAt: quota.nextReset > 0 ? new Date(quota.nextReset) : undefined,
      lastUpdated: new Date(state.lastUpdated),
    };
  }

  /**
   * Get budget info for a provider
   */
  getBudgetInfo(id: string, state: RouterState): BudgetInfo | null {
    const provider = this.providers.get(id);
    if (!provider || !provider.config.budget) return null;

    const budget = state.budgets[id];
    if (!budget) return null;

    const monthlyLimit = provider.config.budget.monthlyLimit;
    const currentSpend = budget.currentSpend;

    return {
      provider: id,
      monthlyLimit,
      currentSpend,
      remaining: Math.max(0, monthlyLimit - currentSpend),
      percentUsed: monthlyLimit > 0 ? currentSpend / monthlyLimit : 0,
      lastUpdated: new Date(state.lastUpdated),
    };
  }

  /**
   * Get status for all providers
   */
  getStatus(state: RouterState): Array<{
    id: string;
    tier: ProviderTier;
    isLocal: boolean;
    isAvailable: boolean;
    quota: QuotaInfo | null;
    budget: BudgetInfo | null;
    status: "ok" | "warning" | "critical" | "exhausted";
  }> {
    return this.getAll().map((p) => {
      const quota = this.getQuotaInfo(p.id, state);
      const budget = this.getBudgetInfo(p.id, state);

      let status: "ok" | "warning" | "critical" | "exhausted" = "ok";

      if (quota) {
        if (quota.percentUsed >= 1) {
          status = "exhausted";
        } else if (quota.percentUsed >= this.config.criticalThreshold) {
          status = "critical";
        } else if (quota.percentUsed >= this.config.warningThreshold) {
          status = "warning";
        }
      }

      if (budget && status !== "exhausted") {
        if (budget.percentUsed >= 1) {
          status = "exhausted";
        } else if (budget.percentUsed >= this.config.criticalThreshold) {
          status = "critical";
        } else if (budget.percentUsed >= this.config.warningThreshold && status === "ok") {
          status = "warning";
        }
      }

      return {
        id: p.id,
        tier: p.config.tier ?? "standard",
        isLocal: p.isLocal,
        isAvailable: p.isAvailable,
        quota,
        budget,
        status,
      };
    });
  }
}
