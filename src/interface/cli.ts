/**
 * CLI commands for openclaw-smart-router
 */

import type {
  SmartRouterConfig,
  RouterState,
  ProviderTier,
} from "../types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { QuotaTracker } from "../quota/tracker.js";
import { QuotaPredictor } from "../quota/predictor.js";
import { Optimizer } from "../optimization/optimizer.js";
import { ActionApplier } from "../optimization/applier.js";
import { analyzeCronJobs, analyzeAgents } from "../optimization/analyzer.js";
import { detectLocalServers } from "../providers/local/detector.js";
import { log } from "../logger.js";

// =============================================================================
// CLI Registration Interface
// =============================================================================

interface CliCommand {
  name: string;
  description: string;
  usage?: string;
  handler: (args: string[], options: Record<string, string | boolean>) => Promise<string>;
}

interface CliRegistrar {
  registerCommand(namespace: string, command: CliCommand): void;
}

// =============================================================================
// CLI Command Registration
// =============================================================================

export function registerCli(
  api: CliRegistrar,
  config: SmartRouterConfig,
  state: RouterState,
  registry: ProviderRegistry,
  tracker: QuotaTracker,
  predictor: QuotaPredictor,
  optimizer: Optimizer,
  saveState: () => void
): void {
  const NS = "router";

  // =========================================================================
  // status - Show current status
  // =========================================================================
  api.registerCommand(NS, {
    name: "status",
    description: "Show provider status and usage",
    usage: "openclaw router status [provider]",
    handler: async (args) => {
      const providerId = args[0];
      const allStatus = registry.getStatus(state);
      const filtered = providerId
        ? allStatus.filter((p) => p.id === providerId)
        : allStatus;

      if (filtered.length === 0) {
        return providerId
          ? `Provider not found: ${providerId}`
          : "No providers configured";
      }

      const lines: string[] = [];
      lines.push(`Mode: ${config.mode}`);
      lines.push("");
      lines.push("Providers:");
      lines.push("-".repeat(70));

      for (const p of filtered) {
        const bar = createProgressBar(p.quota?.percentUsed ?? 0, 20);
        const pct = ((p.quota?.percentUsed ?? 0) * 100).toFixed(1);
        const statusIcon = {
          ok: "✓",
          warning: "⚠",
          critical: "🔴",
          exhausted: "❌",
        }[p.status];

        lines.push(
          `${statusIcon} ${p.id.padEnd(15)} [${bar}] ${pct.padStart(5)}%  (${p.tier})`
        );

        if (p.quota?.resetAt) {
          lines.push(`   Resets: ${p.quota.resetAt.toLocaleString()}`);
        }
      }

      // Add predictions summary
      const needsAttention = predictor.getProvidersNeedingAttention();
      if (needsAttention.length > 0) {
        lines.push("");
        lines.push("⚠ Attention Needed:");
        for (const pred of needsAttention) {
          lines.push(`  ${pred.provider}: ${pred.recommendation}`);
        }
      }

      return lines.join("\n");
    },
  });

  // =========================================================================
  // predict - Show exhaustion predictions
  // =========================================================================
  api.registerCommand(NS, {
    name: "predict",
    description: "Predict quota exhaustion",
    usage: "openclaw router predict [--hours=24]",
    handler: async (_args, options) => {
      const horizon = parseInt(options.hours as string, 10) || config.predictionHorizonHours;
      const predictions = predictor.predictAll();

      const lines: string[] = [];
      lines.push(`Predictions (${horizon}h horizon):`);
      lines.push("-".repeat(70));

      for (const pred of predictions) {
        const status = pred.willExhaust
          ? pred.hoursUntilExhaustion !== undefined
            ? `🔴 Exhausts in ${pred.hoursUntilExhaustion.toFixed(1)}h`
            : "❌ Already exhausted"
          : "✓ OK";

        lines.push(`${pred.provider.padEnd(15)} ${status}`);
        lines.push(`   Trend: ${pred.trend}, Confidence: ${(pred.confidence * 100).toFixed(0)}%`);
        if (pred.recommendation) {
          lines.push(`   → ${pred.recommendation}`);
        }
        lines.push("");
      }

      return lines.join("\n");
    },
  });

  // =========================================================================
  // providers - List providers
  // =========================================================================
  api.registerCommand(NS, {
    name: "providers",
    description: "List configured providers",
    handler: async () => {
      const providers = registry.getAll();

      const lines: string[] = [];
      lines.push("Configured Providers:");
      lines.push("-".repeat(50));

      for (const p of providers) {
        const models = p.models.length > 3
          ? p.models.slice(0, 3).join(", ") + `... (+${p.models.length - 3})`
          : p.models.join(", ");

        lines.push(`${p.id}`);
        lines.push(`  Tier: ${p.config.tier ?? "standard"}`);
        lines.push(`  Local: ${p.isLocal ? "yes" : "no"}`);
        lines.push(`  Available: ${p.isAvailable ? "yes" : "no"}`);
        lines.push(`  Models: ${models || "(none)"}`);
        lines.push("");
      }

      return lines.join("\n");
    },
  });

  // =========================================================================
  // set-usage - Manually set usage
  // =========================================================================
  api.registerCommand(NS, {
    name: "set-usage",
    description: "Manually set provider usage",
    usage: "openclaw router set-usage <provider> <percent|tokens>",
    handler: async (args) => {
      if (args.length < 2) {
        return "Usage: openclaw router set-usage <provider> <value>\nValue can be percentage (e.g., 79%) or tokens (e.g., 1000000)";
      }

      const providerId = args[0];
      const valueStr = args[1];

      if (!state.quotas[providerId]) {
        return `Unknown provider: ${providerId}`;
      }

      let used: number;
      if (valueStr.endsWith("%")) {
        const percent = parseFloat(valueStr.slice(0, -1));
        used = (percent / 100) * state.quotas[providerId].limit;
      } else {
        used = parseInt(valueStr, 10);
      }

      tracker.setUsage(providerId, used);
      saveState();

      const pct = (used / state.quotas[providerId].limit) * 100;
      return `Set ${providerId} usage to ${used.toLocaleString()} tokens (${pct.toFixed(1)}%)`;
    },
  });

  // =========================================================================
  // reset - Reset quota counter
  // =========================================================================
  api.registerCommand(NS, {
    name: "reset",
    description: "Reset quota counter after provider reset",
    usage: "openclaw router reset <provider>",
    handler: async (args) => {
      if (args.length < 1) {
        return "Usage: openclaw router reset <provider>";
      }

      const providerId = args[0];
      if (!state.quotas[providerId]) {
        return `Unknown provider: ${providerId}`;
      }

      tracker.resetQuota(providerId);
      saveState();

      return `Reset quota for ${providerId}`;
    },
  });

  // =========================================================================
  // analyze - Analyze for optimization opportunities
  // =========================================================================
  api.registerCommand(NS, {
    name: "analyze",
    description: "Analyze crons and agents for optimization",
    usage: "openclaw router analyze [--type=all|crons|agents]",
    handler: async (_args, options) => {
      const analysisType = (options.type as string) ?? "all";

      const lines: string[] = [];

      if (analysisType === "all" || analysisType === "crons") {
        const cronJobs = analyzeCronJobs(config, state);
        lines.push("Cron Jobs Analysis:");
        lines.push("-".repeat(70));

        const downgradeableJobs = cronJobs.filter((j) => j.canDowngrade);
        const splittableJobs = cronJobs.filter((j) => j.canSplit);

        lines.push(`Total jobs: ${cronJobs.length}`);
        lines.push(`Can downgrade: ${downgradeableJobs.length}`);
        lines.push(`Can split: ${splittableJobs.length}`);
        lines.push("");

        for (const job of downgradeableJobs.slice(0, 5)) {
          lines.push(`  ${job.name}`);
          lines.push(`    Current: ${job.currentModel} → Suggested: ${job.suggestedModel}`);
          lines.push(`    Complexity: ${job.promptComplexity}, Success: ${(job.successRate * 100).toFixed(0)}%`);
          lines.push(`    Est. savings: ${job.estimatedSavings.toFixed(0)} tokens/run`);
        }

        if (downgradeableJobs.length > 5) {
          lines.push(`  ... and ${downgradeableJobs.length - 5} more`);
        }

        lines.push("");
      }

      if (analysisType === "all" || analysisType === "agents") {
        const agents = analyzeAgents(config, state);
        lines.push("Agents Analysis:");
        lines.push("-".repeat(70));

        const optimizableAgents = agents.filter((a) => a.canUseCheaperDefault);

        lines.push(`Total agents: ${agents.length}`);
        lines.push(`Can optimize: ${optimizableAgents.length}`);
        lines.push("");

        for (const agent of optimizableAgents) {
          lines.push(`  ${agent.name}`);
          lines.push(`    Current: ${agent.primaryModel} → Suggested: ${agent.suggestedPrimaryModel}`);
          lines.push(`    Reason: ${agent.reasoning}`);
        }
      }

      // Add recommendations
      const recommendations = optimizer.getQuickRecommendations();
      if (recommendations.length > 0) {
        lines.push("");
        lines.push("Recommendations:");
        for (const rec of recommendations) {
          lines.push(`  → ${rec}`);
        }
      }

      return lines.join("\n");
    },
  });

  // =========================================================================
  // optimize - Generate and apply optimizations
  // =========================================================================
  api.registerCommand(NS, {
    name: "optimize",
    description: "Optimize model usage",
    usage: "openclaw router optimize [--apply] [--safe-only]",
    handler: async (_args, options) => {
      const shouldApply = options.apply === true;
      const safeOnly = options["safe-only"] === true;

      const plan = optimizer.generatePlan();

      const actions = safeOnly
        ? plan.actions.filter((a) => a.reversible)
        : plan.actions;

      if (actions.length === 0) {
        return "No optimization opportunities found.";
      }

      const lines: string[] = [];
      lines.push(shouldApply ? "Applying optimizations..." : "Optimization Plan (dry-run):");
      lines.push("-".repeat(70));

      const applier = new ActionApplier(config, !shouldApply);
      const results = await applier.applyPlan({ ...plan, actions });

      for (const result of results) {
        const icon = result.status === "applied" ? "✓" : result.status === "failed" ? "✗" : "○";
        lines.push(`${icon} ${result.action.description}`);
        if (result.error) {
          lines.push(`  Error: ${result.error}`);
        }
      }

      if (shouldApply) {
        state.lastOptimization = {
          timestamp: Date.now(),
          planId: plan.id,
          applied: true,
        };
        saveState();
        lines.push("");
        lines.push("Optimizations applied. Restart gateway to take effect.");
      } else {
        lines.push("");
        lines.push("Run with --apply to execute these changes.");
      }

      return lines.join("\n");
    },
  });

  // =========================================================================
  // detect-local - Detect local model servers
  // =========================================================================
  api.registerCommand(NS, {
    name: "detect-local",
    description: "Detect local model servers (MLX, Ollama, etc.)",
    handler: async () => {
      const lines: string[] = [];
      lines.push("Detecting local model servers...");
      lines.push("");

      const detected = await detectLocalServers();

      if (detected.length === 0) {
        lines.push("No local model servers detected.");
        lines.push("");
        lines.push("Supported servers:");
        lines.push("  - Ollama (port 11434)");
        lines.push("  - MLX-LM (port 8080)");
        lines.push("  - LM Studio (port 1234)");
        lines.push("  - vLLM (port 8000)");
        return lines.join("\n");
      }

      for (const server of detected) {
        lines.push(`✓ ${server.type} at ${server.endpoint}`);
        lines.push(`  Models: ${server.models.join(", ") || "(none detected)"}`);
        lines.push("");
      }

      return lines.join("\n");
    },
  });

  // =========================================================================
  // mode - Get or set operation mode
  // =========================================================================
  api.registerCommand(NS, {
    name: "mode",
    description: "Get or set operation mode",
    usage: "openclaw router mode [manual|dry-run|auto]",
    handler: async (args) => {
      if (args.length === 0) {
        return `Current mode: ${config.mode}`;
      }

      const newMode = args[0];
      if (!["manual", "dry-run", "auto"].includes(newMode)) {
        return "Invalid mode. Use: manual, dry-run, or auto";
      }

      // Note: This would need to update config file
      return `Mode change to '${newMode}' requires updating config in openclaw.json`;
    },
  });

  log.info("registered 9 CLI commands under 'router' namespace");
}

// =============================================================================
// Helpers
// =============================================================================

function createProgressBar(percent: number, width: number): string {
  const filled = Math.round(percent * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}
