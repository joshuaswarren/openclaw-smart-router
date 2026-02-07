/**
 * Agent tools for conversational interface
 */

import type {
  SmartRouterConfig,
  RouterState,
  StatusResponse,
  AnalyzeResponse,
  OptimizeResponse,
  LocalModelType,
} from "../types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { QuotaTracker } from "../quota/tracker.js";
import { QuotaPredictor } from "../quota/predictor.js";
import { CapabilityScorer } from "../capabilities/scorer.js";
import { ModelMatcher } from "../capabilities/matcher.js";
import { Optimizer } from "../optimization/optimizer.js";
import { ActionApplier } from "../optimization/applier.js";
import { analyzeCronJobs, analyzeAgents } from "../optimization/analyzer.js";
import { log } from "../logger.js";

// =============================================================================
// Tool Registration Interface
// =============================================================================

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

interface ToolRegistrar {
  registerTool(tool: ToolDefinition): void;
}

// =============================================================================
// Tool Handlers
// =============================================================================

export function registerTools(
  api: ToolRegistrar,
  config: SmartRouterConfig,
  state: RouterState,
  registry: ProviderRegistry,
  tracker: QuotaTracker,
  predictor: QuotaPredictor,
  scorer: CapabilityScorer,
  matcher: ModelMatcher,
  optimizer: Optimizer,
  saveState: () => void
): void {
  // =========================================================================
  // router_status - Get current status
  // =========================================================================
  api.registerTool({
    name: "router_status",
    description:
      "Get the current status of the smart router including provider usage, predictions, and local model availability. Use this when the user asks about token usage, quota status, or model availability.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Optional: get status for a specific provider only",
        },
      },
    },
    handler: async (params) => {
      const providerId = params.provider as string | undefined;

      const allStatus = registry.getStatus(state);
      const predictions = predictor.predictAll();
      const localProviders = registry.getLocal();

      const status: StatusResponse = {
        mode: config.mode,
        providers: providerId
          ? allStatus.filter((p) => p.id === providerId).map((p) => ({
              id: p.id,
              tier: p.tier,
              quotaType: p.quota?.quotaType ?? "tokens",
              limit: p.quota?.limit ?? 0,
              used: p.quota?.used ?? 0,
              percentUsed: p.quota?.percentUsed ?? 0,
              resetAt: p.quota?.resetAt?.toISOString(),
              status: p.status,
            }))
          : allStatus.map((p) => ({
              id: p.id,
              tier: p.tier,
              quotaType: p.quota?.quotaType ?? "tokens",
              limit: p.quota?.limit ?? 0,
              used: p.quota?.used ?? 0,
              percentUsed: p.quota?.percentUsed ?? 0,
              resetAt: p.quota?.resetAt?.toISOString(),
              status: p.status,
            })),
        predictions,
        localModels: {
          available: localProviders.length > 0,
          count: localProviders.reduce((sum, p) => sum + p.models.length, 0),
          types: localProviders.map((p) => p.config.local?.type).filter(Boolean) as LocalModelType[],
        },
        lastOptimization: state.lastOptimization
          ? {
              timestamp: new Date(state.lastOptimization.timestamp).toISOString(),
              savings: 0, // Would need to track this
            }
          : undefined,
      };

      return status;
    },
  });

  // =========================================================================
  // router_predict - Detailed predictions
  // =========================================================================
  api.registerTool({
    name: "router_predict",
    description:
      "Get detailed quota exhaustion predictions. Use when the user asks 'when will I run out of tokens' or wants to know about future quota usage.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Optional: get prediction for a specific provider",
        },
        horizon_hours: {
          type: "number",
          description: "Prediction horizon in hours (default: 24)",
        },
      },
    },
    handler: async (params) => {
      const providerId = params.provider as string | undefined;
      const horizon = (params.horizon_hours as number) ?? config.predictionHorizonHours;

      const allPredictions = predictor.predictAll();
      const filtered = providerId
        ? allPredictions.filter((p) => p.provider === providerId)
        : allPredictions;

      // Filter to those that will exhaust within horizon
      const withinHorizon = filtered.filter((p) => {
        if (!p.willExhaust) return true; // Include non-exhausting for context
        if (!p.hoursUntilExhaustion) return true; // Already exhausted
        return p.hoursUntilExhaustion <= horizon;
      });

      return {
        horizonHours: horizon,
        predictions: withinHorizon,
        summary: withinHorizon.filter((p) => p.willExhaust).length > 0
          ? `${withinHorizon.filter((p) => p.willExhaust).length} provider(s) will exhaust within ${horizon}h`
          : "No providers will exhaust within the prediction horizon",
      };
    },
  });

  // =========================================================================
  // router_analyze - Analyze for optimization opportunities
  // =========================================================================
  api.registerTool({
    name: "router_analyze",
    description:
      "Analyze cron jobs and agents to identify optimization opportunities. Use when the user asks 'which jobs can use cheaper models' or wants to optimize their setup.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["all", "crons", "agents"],
          description: "What to analyze (default: all)",
        },
      },
    },
    handler: async (params) => {
      const analysisType = (params.type as string) ?? "all";

      const response: AnalyzeResponse = {
        cronJobs: [],
        agents: [],
        sessions: [],
        recommendations: [],
        totalPotentialSavings: 0,
      };

      if (analysisType === "all" || analysisType === "crons") {
        response.cronJobs = analyzeCronJobs(config, state);
      }

      if (analysisType === "all" || analysisType === "agents") {
        response.agents = analyzeAgents(config, state);
      }

      // Generate recommendations
      const downgradeableCrons = response.cronJobs.filter((j) => j.canDowngrade);
      const splittableCrons = response.cronJobs.filter((j) => j.canSplit);
      const optimizableAgents = response.agents.filter((a) => a.canUseCheaperDefault);

      if (downgradeableCrons.length > 0) {
        response.recommendations.push(
          `${downgradeableCrons.length} cron job(s) can use cheaper models: ${downgradeableCrons.slice(0, 3).map((j) => j.name).join(", ")}${downgradeableCrons.length > 3 ? "..." : ""}`
        );
      }

      if (splittableCrons.length > 0) {
        response.recommendations.push(
          `${splittableCrons.length} cron job(s) can be split into simpler tasks`
        );
      }

      if (optimizableAgents.length > 0) {
        response.recommendations.push(
          `${optimizableAgents.length} agent(s) can use cheaper defaults`
        );
      }

      response.totalPotentialSavings =
        response.cronJobs.reduce((sum, j) => sum + j.estimatedSavings, 0) +
        response.agents.reduce((sum, a) => sum + (a.canUseCheaperDefault ? 1000 : 0), 0);

      return response;
    },
  });

  // =========================================================================
  // router_optimize - Generate and optionally apply optimizations
  // =========================================================================
  api.registerTool({
    name: "router_optimize",
    description:
      "Generate an optimization plan and optionally apply it. Use when the user says 'optimize my model usage' or wants to reduce costs.",
    parameters: {
      type: "object",
      properties: {
        apply: {
          type: "boolean",
          description: "Whether to apply the optimizations (default: false, dry-run)",
        },
        filter: {
          type: "string",
          enum: ["all", "crons-only", "agents-only", "safe-only"],
          description: "Filter which optimizations to include",
        },
      },
    },
    handler: async (params) => {
      const shouldApply = (params.apply as boolean) ?? false;
      const filter = (params.filter as string) ?? "all";

      // Generate plan
      const plan = optimizer.generatePlan();

      // Filter if needed
      let filteredActions = plan.actions;
      if (filter === "crons-only") {
        filteredActions = plan.actions.filter((a) => a.target.type === "cron");
      } else if (filter === "agents-only") {
        filteredActions = plan.actions.filter((a) => a.target.type === "agent");
      } else if (filter === "safe-only") {
        filteredActions = plan.actions.filter((a) => a.reversible);
      }

      const filteredPlan = { ...plan, actions: filteredActions };

      // Apply if requested
      const applier = new ActionApplier(config, !shouldApply);
      const results = await applier.applyPlan(filteredPlan);

      // Update state
      if (shouldApply) {
        state.lastOptimization = {
          timestamp: Date.now(),
          planId: plan.id,
          applied: true,
        };
        saveState();
      }

      const response: OptimizeResponse = {
        mode: shouldApply ? "applied" : "dry-run",
        plan: filteredPlan,
        actions: results.map((r) => ({
          action: r.action,
          status: r.status === "applied" ? (shouldApply ? "applied" : "pending") : r.status,
          error: r.error,
        })),
      };

      return response;
    },
  });

  // =========================================================================
  // router_set_usage - Manually set usage for a provider
  // =========================================================================
  api.registerTool({
    name: "router_set_usage",
    description:
      "Manually set the usage level for a provider. Use when the user says 'my Anthropic usage is 79%' or wants to update quota tracking.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider ID (e.g., 'anthropic', 'openai-codex')",
        },
        percent: {
          type: "number",
          description: "Usage percentage (0-100)",
        },
        tokens: {
          type: "number",
          description: "Alternative: set usage in tokens",
        },
      },
      required: ["provider"],
    },
    handler: async (params) => {
      const providerId = params.provider as string;
      const percent = params.percent as number | undefined;
      const tokens = params.tokens as number | undefined;

      if (percent === undefined && tokens === undefined) {
        return { error: "Must specify either percent or tokens" };
      }

      const quota = state.quotas[providerId];
      if (!quota) {
        return { error: `Unknown provider: ${providerId}` };
      }

      if (percent !== undefined) {
        const used = (percent / 100) * quota.limit;
        tracker.setUsage(providerId, used);
      } else if (tokens !== undefined) {
        tracker.setUsage(providerId, tokens);
      }

      saveState();

      return {
        provider: providerId,
        used: state.quotas[providerId].used,
        limit: state.quotas[providerId].limit,
        percentUsed: (state.quotas[providerId].used / state.quotas[providerId].limit) * 100,
        message: `Updated ${providerId} usage`,
      };
    },
  });

  // =========================================================================
  // router_shift - Shift workload away from a provider
  // =========================================================================
  api.registerTool({
    name: "router_shift",
    description:
      "Shift workload away from a provider. Use when the user says 'move everything off Anthropic' or wants to reduce load on a specific provider.",
    parameters: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Provider to shift away from",
        },
        to: {
          type: "string",
          description: "Optional: specific provider to shift to",
        },
        apply: {
          type: "boolean",
          description: "Whether to apply changes (default: false)",
        },
      },
      required: ["from"],
    },
    handler: async (params) => {
      const fromProvider = params.from as string;
      const toProvider = params.to as string | undefined;
      const shouldApply = (params.apply as boolean) ?? false;

      // Find all cron jobs and agents using the source provider
      const cronJobs = analyzeCronJobs(config, state);
      const agents = analyzeAgents(config, state);

      const affectedCrons = cronJobs.filter((j) =>
        j.currentModel.includes(fromProvider) ||
        registry.get(fromProvider)?.models.includes(j.currentModel)
      );

      const affectedAgents = agents.filter((a) =>
        a.primaryModel.includes(fromProvider) ||
        registry.get(fromProvider)?.models.includes(a.primaryModel)
      );

      // Find suitable alternatives
      const alternatives = toProvider
        ? [registry.get(toProvider)].filter(Boolean)
        : registry.getAvailable(state).filter((p) => p.id !== fromProvider);

      if (alternatives.length === 0) {
        return {
          error: "No alternative providers available",
          affected: {
            crons: affectedCrons.length,
            agents: affectedAgents.length,
          },
        };
      }

      const targetProvider = alternatives[0];

      return {
        from: fromProvider,
        to: targetProvider.id,
        affected: {
          crons: affectedCrons.map((j) => j.name),
          agents: affectedAgents.map((a) => a.name),
        },
        targetModels: targetProvider.models.slice(0, 3),
        dryRun: !shouldApply,
        message: shouldApply
          ? `Shifted ${affectedCrons.length + affectedAgents.length} items from ${fromProvider} to ${targetProvider.id}`
          : `Would shift ${affectedCrons.length + affectedAgents.length} items from ${fromProvider} to ${targetProvider.id}`,
      };
    },
  });

  log.info("registered 6 router tools");
}
