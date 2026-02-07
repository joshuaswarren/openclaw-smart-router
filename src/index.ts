/**
 * openclaw-smart-router
 *
 * Intelligent model routing for OpenClaw with quota prediction,
 * task classification, and automatic optimization.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig, getOpenClawConfigPath } from "./config.js";
import { initLogger, log } from "./logger.js";
import { loadState, saveState, initQuota, initBudget } from "./storage/state.js";
import { ProviderRegistry } from "./providers/registry.js";
import { QuotaTracker, extractUsage, inferProviderFromModel } from "./quota/tracker.js";
import { QuotaPredictor } from "./quota/predictor.js";
import { calculateNextReset } from "./quota/reset.js";
import { CapabilityScorer } from "./capabilities/scorer.js";
import { ModelMatcher } from "./capabilities/matcher.js";
import { Optimizer } from "./optimization/optimizer.js";
import { detectLocalServers } from "./providers/local/detector.js";
import { fetchProviderQuota, hasQuotaFetcher } from "./providers/fetchers/index.js";
import { registerTools } from "./interface/tools.js";
import { registerCli } from "./interface/cli.js";
import { readFileSync, existsSync } from "fs";
import type { SmartRouterConfig, RouterState, LocalModelType } from "./types.js";

// =============================================================================
// Plugin Export
// =============================================================================

export default {
  id: "openclaw-smart-router",
  name: "Smart Router",
  description:
    "Intelligent model routing with quota prediction, task classification, and automatic optimization.",
  kind: "utility" as const,

  register(api: OpenClawPluginApi) {
    // Parse configuration
    const config = parseConfig(api.pluginConfig);
    initLogger(api.logger, config.debug);

    log.info("initializing smart router plugin");

    // Load persistent state
    let state = loadState(config.stateFile);
    const doSaveState = () => saveState(config.stateFile, state);

    // Initialize provider registry
    const registry = new ProviderRegistry(config);

    // Initialize from main OpenClaw config
    initializeFromOpenClawConfig(registry, state, config);

    // Initialize from plugin config
    initializeFromPluginConfig(registry, state, config);

    // Initialize core components
    const tracker = new QuotaTracker(config, state, doSaveState);
    const predictor = new QuotaPredictor(config, state);
    const scorer = new CapabilityScorer();
    const matcher = new ModelMatcher(config, scorer, registry);
    const optimizer = new Optimizer(config, state);

    // Register tools for conversational interface
    registerTools(
      api as unknown as Parameters<typeof registerTools>[0],
      config,
      state,
      registry,
      tracker,
      predictor,
      scorer,
      matcher,
      optimizer,
      doSaveState
    );

    // Register CLI commands
    registerCli(
      api as unknown as Parameters<typeof registerCli>[0],
      config,
      state,
      registry,
      tracker,
      predictor,
      optimizer,
      doSaveState
    );

    // Register hooks for usage tracking
    registerHooks(api, tracker, registry, config, state);

    // Register service for background tasks
    api.registerService({
      id: "openclaw-smart-router",
      start: async () => {
        log.info("smart router service started");

        // Fetch API-based quotas (e.g., OpenRouter)
        await fetchApiBasedQuotas(config, state, doSaveState);

        // Detect local model servers
        if (config.localModelPreference !== "never") {
          await detectAndRegisterLocalModels(registry, state);
        }

        // Start periodic optimization in auto mode
        if (config.mode === "auto") {
          startAutoOptimization(config, state, optimizer, doSaveState);
        }
      },
      stop: () => {
        log.info("smart router service stopped");
        doSaveState();
      },
    });

    log.info(`smart router initialized in ${config.mode} mode`);
  },
};

// =============================================================================
// Initialization Helpers
// =============================================================================

/**
 * Initialize providers from OpenClaw's main config
 */
function initializeFromOpenClawConfig(
  registry: ProviderRegistry,
  state: RouterState,
  config: SmartRouterConfig
): void {
  const configPath = getOpenClawConfigPath();

  if (!existsSync(configPath)) {
    log.debug("openclaw.json not found");
    return;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const openclawConfig = JSON.parse(raw);

    if (openclawConfig.models?.providers) {
      for (const [providerId, providerData] of Object.entries(openclawConfig.models.providers)) {
        const data = providerData as { models?: Array<{ id: string }> };
        const models = data.models?.map((m) => m.id) ?? [];

        // Merge with plugin config if exists
        const pluginProviderConfig = config.providers[providerId] ?? {};

        registry.register(providerId, pluginProviderConfig, models);

        // Initialize quota tracking
        if (pluginProviderConfig.limit) {
          const nextReset = pluginProviderConfig.resetSchedule
            ? calculateNextReset(pluginProviderConfig.resetSchedule).getTime()
            : 0;

          initQuota(state, providerId, pluginProviderConfig.limit, nextReset);
        }

        // Initialize budget tracking
        if (pluginProviderConfig.budget?.monthlyLimit) {
          initBudget(state, providerId, pluginProviderConfig.budget.monthlyLimit);
        }

        log.debug(`registered provider from openclaw.json: ${providerId} (${models.length} models)`);
      }
    }
  } catch (err) {
    log.error("failed to parse openclaw.json", err);
  }
}

/**
 * Initialize providers from plugin config
 */
function initializeFromPluginConfig(
  registry: ProviderRegistry,
  state: RouterState,
  config: SmartRouterConfig
): void {
  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    // Skip if already registered from openclaw.json
    if (registry.get(providerId)) {
      continue;
    }

    // Register provider
    const models = providerConfig.local?.models ?? [];
    registry.register(providerId, providerConfig, models);

    // Initialize quota tracking
    if (providerConfig.limit) {
      const nextReset = providerConfig.resetSchedule
        ? calculateNextReset(providerConfig.resetSchedule).getTime()
        : 0;

      initQuota(state, providerId, providerConfig.limit, nextReset);
    }

    // Initialize budget tracking
    if (providerConfig.budget?.monthlyLimit) {
      initBudget(state, providerId, providerConfig.budget.monthlyLimit);
    }

    log.debug(`registered provider from plugin config: ${providerId}`);
  }
}

/**
 * Detect and register local model servers
 */
async function detectAndRegisterLocalModels(
  registry: ProviderRegistry,
  state: RouterState
): Promise<void> {
  try {
    const servers = await detectLocalServers();

    for (const server of servers) {
      const providerId = `local-${server.type}`;

      registry.register(
        providerId,
        {
          quotaSource: "unlimited",
          tier: "local",
          priority: 30,
          local: {
            type: server.type,
            endpoint: server.endpoint,
            models: server.models,
          },
        },
        server.models
      );

      log.info(`registered local provider: ${providerId} (${server.models.length} models)`);
    }

    // Cache detection results
    state.localModels = {
      lastCheck: Date.now(),
      detected: servers.map((s) => ({
        type: s.type,
        endpoint: s.endpoint,
        models: s.models,
      })),
    };
  } catch (err) {
    log.error("failed to detect local models", err);
  }
}

/**
 * Fetch quota data from providers that support API-based tracking
 */
async function fetchApiBasedQuotas(
  config: SmartRouterConfig,
  state: RouterState,
  saveState: () => void
): Promise<void> {
  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    // Only fetch for providers with quotaSource: "api"
    if (providerConfig.quotaSource !== "api") continue;

    // Check if we have a fetcher for this provider
    if (!hasQuotaFetcher(providerId)) {
      log.warn(`provider ${providerId} has quotaSource: api but no fetcher available`);
      continue;
    }

    // Get API key from environment (common patterns)
    const envVarNames = [
      `${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`,
      `${providerId.toUpperCase()}_API_KEY`,
    ];

    let apiKey: string | undefined;
    for (const envVar of envVarNames) {
      if (process.env[envVar]) {
        apiKey = process.env[envVar];
        break;
      }
    }

    if (!apiKey) {
      log.debug(`no API key found for ${providerId} (tried: ${envVarNames.join(", ")})`);
      continue;
    }

    try {
      log.debug(`fetching quota for ${providerId}...`);
      const result = await fetchProviderQuota(providerId, apiKey);

      if (result.success && result.quota) {
        // Update state with fetched quota
        if (!state.quotas[providerId]) {
          state.quotas[providerId] = {
            limit: 0,
            used: 0,
            lastReset: 0,
            nextReset: 0,
          };
        }

        state.quotas[providerId].limit = result.quota.limit;
        state.quotas[providerId].used = result.quota.used;
        state.lastUpdated = Date.now();

        log.info(
          `${providerId}: fetched quota - ${result.quota.remaining}/${result.quota.limit} remaining`
        );

        saveState();
      } else {
        log.warn(`failed to fetch quota for ${providerId}: ${result.error}`);
      }
    } catch (err) {
      log.error(`error fetching quota for ${providerId}`, err);
    }
  }
}

/**
 * Register hooks for usage tracking
 */
function registerHooks(
  api: OpenClawPluginApi,
  tracker: QuotaTracker,
  registry: ProviderRegistry,
  config: SmartRouterConfig,
  state: RouterState
): void {
  // Hook into LLM completions to track usage
  api.on("llm_end", (event: { model?: string; response?: unknown; source?: string; sourceId?: string }) => {
    const usage = extractUsage(event.response);
    if (!usage) return;

    const model = event.model ?? "unknown";
    const provider = inferProviderFromModel(model);
    const source = (event.source ?? "interactive") as "cron" | "agent" | "interactive";

    tracker.record(
      provider,
      model,
      usage.tokensIn,
      usage.tokensOut,
      source,
      event.sourceId
    );
  });

  // Hook into session end to track session-level stats
  api.on("session_end", (event: { agentId?: string; tokensUsed?: number }) => {
    log.debug(`session ended: agent=${event.agentId}, tokens=${event.tokensUsed}`);
  });
}

/**
 * Start periodic optimization in auto mode
 */
function startAutoOptimization(
  config: SmartRouterConfig,
  state: RouterState,
  optimizer: Optimizer,
  saveState: () => void
): void {
  const intervalMs = config.optimizationIntervalMinutes * 60 * 1000;

  setInterval(async () => {
    log.debug("running auto-optimization check");

    const plan = optimizer.generatePlan();

    if (plan.actions.length === 0) {
      log.debug("no optimization opportunities");
      return;
    }

    // In auto mode, apply safe (reversible) optimizations
    const safeActions = plan.actions.filter((a) => a.reversible);

    if (safeActions.length > 0) {
      log.info(`auto-applying ${safeActions.length} optimizations`);
      // Import dynamically to avoid circular dependency
      const { ActionApplier } = await import("./optimization/applier.js");
      const applier = new ActionApplier(config, false);
      await applier.applyPlan({ ...plan, actions: safeActions });

      state.lastOptimization = {
        timestamp: Date.now(),
        planId: plan.id,
        applied: true,
      };
      saveState();
    }
  }, intervalMs);

  log.info(`auto-optimization scheduled every ${config.optimizationIntervalMinutes} minutes`);
}
