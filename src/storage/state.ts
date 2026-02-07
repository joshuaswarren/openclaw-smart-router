/**
 * Persistent state management for openclaw-smart-router
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { RouterState, UsageRecord } from "../types.js";
import { log } from "../logger.js";

const STATE_VERSION = 1;
const MAX_USAGE_HISTORY = 10000; // Keep last 10k records

/**
 * Create an empty initial state
 */
function createInitialState(): RouterState {
  return {
    version: STATE_VERSION,
    lastUpdated: Date.now(),
    quotas: {},
    budgets: {},
    usageHistory: [],
    capabilities: {},
  };
}

/**
 * Load state from disk
 */
export function loadState(stateFile: string): RouterState {
  try {
    if (!existsSync(stateFile)) {
      log.debug(`state file does not exist, creating: ${stateFile}`);
      const initial = createInitialState();
      saveState(stateFile, initial);
      return initial;
    }

    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as RouterState;

    // Version migration if needed
    if (parsed.version !== STATE_VERSION) {
      log.info(`migrating state from version ${parsed.version} to ${STATE_VERSION}`);
      // For now, just update version - add migration logic as needed
      parsed.version = STATE_VERSION;
    }

    return parsed;
  } catch (err) {
    log.error("failed to load state, creating fresh", err);
    return createInitialState();
  }
}

/**
 * Save state to disk
 */
export function saveState(stateFile: string, state: RouterState): void {
  try {
    // Ensure directory exists
    const dir = dirname(stateFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Trim usage history if too large
    if (state.usageHistory.length > MAX_USAGE_HISTORY) {
      state.usageHistory = state.usageHistory.slice(-MAX_USAGE_HISTORY);
    }

    state.lastUpdated = Date.now();
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
    log.debug("state saved");
  } catch (err) {
    log.error("failed to save state", err);
  }
}

/**
 * Add a usage record to history
 */
export function recordUsage(
  state: RouterState,
  record: UsageRecord
): void {
  state.usageHistory.push(record);

  // Update quota tracking
  const provider = record.provider;
  if (state.quotas[provider]) {
    state.quotas[provider].used += record.tokensIn + record.tokensOut;
  }

  // Update budget tracking
  if (state.budgets[provider] && record.cost) {
    state.budgets[provider].currentSpend += record.cost;
  }
}

/**
 * Get usage records for a time window
 */
export function getUsageInWindow(
  state: RouterState,
  provider: string | null,
  windowMs: number
): UsageRecord[] {
  const cutoff = Date.now() - windowMs;
  return state.usageHistory.filter((r) => {
    if (r.timestamp < cutoff) return false;
    if (provider && r.provider !== provider) return false;
    return true;
  });
}

/**
 * Calculate total tokens used in a time window
 */
export function getTotalTokensInWindow(
  state: RouterState,
  provider: string,
  windowMs: number
): number {
  const records = getUsageInWindow(state, provider, windowMs);
  return records.reduce((sum, r) => sum + r.tokensIn + r.tokensOut, 0);
}

/**
 * Get usage breakdown by source type
 */
export function getUsageBySource(
  state: RouterState,
  provider: string,
  windowMs: number
): Record<string, number> {
  const records = getUsageInWindow(state, provider, windowMs);
  const breakdown: Record<string, number> = {
    cron: 0,
    agent: 0,
    interactive: 0,
  };

  for (const r of records) {
    breakdown[r.source] = (breakdown[r.source] ?? 0) + r.tokensIn + r.tokensOut;
  }

  return breakdown;
}

/**
 * Reset quota counter for a provider
 */
export function resetQuota(state: RouterState, provider: string): void {
  if (state.quotas[provider]) {
    state.quotas[provider].used = 0;
    state.quotas[provider].lastReset = Date.now();
    log.info(`reset quota for ${provider}`);
  }
}

/**
 * Set manual quota usage
 */
export function setQuotaUsage(
  state: RouterState,
  provider: string,
  used: number,
  limit?: number
): void {
  if (!state.quotas[provider]) {
    state.quotas[provider] = {
      used: 0,
      limit: limit ?? 0,
      lastReset: Date.now(),
      nextReset: 0,
    };
  }

  state.quotas[provider].used = used;
  if (limit !== undefined) {
    state.quotas[provider].limit = limit;
  }

  log.debug(`set quota for ${provider}: ${used}/${state.quotas[provider].limit}`);
}

/**
 * Initialize quota tracking for a provider
 */
export function initQuota(
  state: RouterState,
  provider: string,
  limit: number,
  nextReset: number
): void {
  if (!state.quotas[provider]) {
    state.quotas[provider] = {
      used: 0,
      limit,
      lastReset: Date.now(),
      nextReset,
    };
  } else {
    state.quotas[provider].limit = limit;
    state.quotas[provider].nextReset = nextReset;
  }
}

/**
 * Initialize budget tracking for a provider
 */
export function initBudget(
  state: RouterState,
  provider: string,
  monthlyLimit: number
): void {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  if (!state.budgets[provider]) {
    state.budgets[provider] = {
      currentSpend: 0,
      monthStart,
    };
  } else if (state.budgets[provider].monthStart < monthStart) {
    // New month, reset
    state.budgets[provider].currentSpend = 0;
    state.budgets[provider].monthStart = monthStart;
  }
}
