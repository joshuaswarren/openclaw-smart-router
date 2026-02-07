/**
 * CLI commands for openclaw-smart-router
 *
 * Uses OpenClaw's registerCli API which integrates with Commander.js
 */

import type {
  SmartRouterConfig,
  RouterState,
} from "../types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { QuotaTracker } from "../quota/tracker.js";
import { QuotaPredictor } from "../quota/predictor.js";
import { Optimizer } from "../optimization/optimizer.js";
import { ActionApplier } from "../optimization/applier.js";
import { analyzeCronJobs, analyzeAgents } from "../optimization/analyzer.js";
import { detectLocalServers } from "../providers/local/detector.js";
import { fetchOpenClawUsage } from "../providers/fetchers/openclaw.js";
import { log } from "../logger.js";

// =============================================================================
// Commander.js Type Definitions
// =============================================================================

interface CommanderCommand {
  command(nameAndArgs: string): CommanderCommand;
  description(str: string): CommanderCommand;
  option(flags: string, description?: string, defaultValue?: string | boolean): CommanderCommand;
  argument(name: string, description?: string): CommanderCommand;
  action(fn: (...args: unknown[]) => void | Promise<void>): CommanderCommand;
  addHelpText(position: "before" | "after", text: string | (() => string)): CommanderCommand;
}

interface CliContext {
  program: CommanderCommand;
  config: unknown;
  workspaceDir: string;
  logger: unknown;
}

interface CliRegistrar {
  registerCli(
    register: (ctx: CliContext) => void,
    opts?: { commands?: string[] }
  ): void;
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
  api.registerCli(
    ({ program }) => {
      const router = program
        .command("router")
        .description("Smart Router: quota tracking, predictions, and optimization")
        .addHelpText("after", () => "\nRun 'openclaw router <command> --help' for command help\n");

      // status - Show current status
      router
        .command("status")
        .description("Show provider status and usage")
        .argument("[provider]", "Specific provider to show")
        .action(async (providerId?: string) => {
          const result = await handleStatus(config, state, registry, predictor, providerId);
          console.log(result);
        });

      // predict - Show exhaustion predictions
      router
        .command("predict")
        .description("Predict quota exhaustion")
        .option("--hours <n>", "Prediction horizon in hours", "48")
        .action(async (opts: { hours?: string }) => {
          const result = await handlePredict(config, state, predictor, opts);
          console.log(result);
        });

      // providers - List providers
      router
        .command("providers")
        .description("List configured providers")
        .action(async () => {
          const result = await handleProviders(registry);
          console.log(result);
        });

      // set-usage - Manually set usage
      router
        .command("set-usage")
        .description("Manually set provider usage")
        .argument("<provider>", "Provider ID")
        .argument("<value>", "Usage value (percentage like 79% or token count)")
        .action(async (providerId: string, value: string) => {
          const result = await handleSetUsage(state, tracker, saveState, providerId, value);
          console.log(result);
        });

      // reset - Reset quota counter
      router
        .command("reset")
        .description("Reset quota counter after provider reset")
        .argument("<provider>", "Provider ID to reset")
        .action(async (providerId: string) => {
          const result = await handleReset(state, tracker, saveState, providerId);
          console.log(result);
        });

      // set-reset-date - Set when a provider's quota resets
      router
        .command("set-reset-date")
        .description("Set provider quota reset date (for manual tracking)")
        .argument("<provider>", "Provider ID")
        .argument("<date>", "Reset date (e.g., 'Feb 12 7AM', '2026-02-12T07:00', 'in 5 days')")
        .action(async (providerId: string, dateStr: string) => {
          const result = await handleSetResetDate(state, saveState, providerId, dateStr);
          console.log(result);
        });

      // analyze - Analyze for optimization opportunities
      router
        .command("analyze")
        .description("Analyze crons and agents for optimization")
        .option("--type <type>", "Analysis type: all, crons, agents", "all")
        .action(async (opts: { type?: string }) => {
          const result = await handleAnalyze(config, state, optimizer, opts);
          console.log(result);
        });

      // optimize - Generate and apply optimizations
      router
        .command("optimize")
        .description("Optimize model usage")
        .option("--apply", "Apply the optimizations", false)
        .option("--safe-only", "Only apply reversible changes", false)
        .action(async (opts: { apply?: boolean; "safe-only"?: boolean }) => {
          const result = await handleOptimize(config, state, optimizer, saveState, opts);
          console.log(result);
        });

      // sync - Sync usage from OpenClaw's built-in tracking
      router
        .command("sync")
        .description("Sync usage from OpenClaw's built-in quota tracking")
        .action(async () => {
          const result = await handleSync(state, tracker, saveState);
          console.log(result);
        });

      // detect-local - Detect local model servers
      router
        .command("detect-local")
        .description("Detect local model servers (MLX, Ollama, etc.)")
        .action(async () => {
          const result = await handleDetectLocal();
          console.log(result);
        });

      // mode - Get or set operation mode
      router
        .command("mode")
        .description("Get or set operation mode")
        .argument("[mode]", "New mode: manual, dry-run, auto")
        .action(async (newMode?: string) => {
          const result = await handleMode(config, newMode);
          console.log(result);
        });
    },
    { commands: ["router"] }
  );

  log.info("registered 'router' CLI command with subcommands");
}

// =============================================================================
// Command Handlers
// =============================================================================

async function handleStatus(
  config: SmartRouterConfig,
  state: RouterState,
  registry: ProviderRegistry,
  predictor: QuotaPredictor,
  providerId?: string
): Promise<string> {
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
    // Use stored percentage if available, otherwise calculate from used/limit
    const quota = state.quotas[p.id];
    let pctValue = p.quota?.percentUsed ?? 0;
    let pctSource = "";

    if (quota?.percentUsed !== undefined && quota.limit === 0) {
      // Use synced percentage when we don't have a limit
      pctValue = quota.percentUsed / 100; // Convert to 0-1 for display
      pctSource = quota.percentSource ? ` [${quota.percentSource}]` : "";
    }

    const bar = createProgressBar(pctValue, 20);
    const pct = (pctValue * 100).toFixed(1);
    const statusIcon = {
      ok: "✓",
      warning: "⚠",
      critical: "🔴",
      exhausted: "❌",
    }[p.status];

    lines.push(
      `${statusIcon} ${p.id.padEnd(15)} [${bar}] ${pct.padStart(5)}%${pctSource}  (${p.tier})`
    );

    // Show reset time from quota info or from state
    const stateQuota = state.quotas[p.id];
    if (p.quota?.resetAt) {
      lines.push(`   Resets: ${p.quota.resetAt.toLocaleString()}`);
    } else if (stateQuota?.nextReset && stateQuota.nextReset > Date.now()) {
      const resetDate = new Date(stateQuota.nextReset);
      const hoursUntil = (stateQuota.nextReset - Date.now()) / (1000 * 60 * 60);
      const daysUntil = Math.floor(hoursUntil / 24);
      const remainingHours = Math.round(hoursUntil % 24);
      const timeUntil = daysUntil > 0 ? `${daysUntil}d ${remainingHours}h` : `${remainingHours}h`;

      lines.push(`   Resets: ${resetDate.toLocaleString()} (${timeUntil})`);
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
}

async function handlePredict(
  config: SmartRouterConfig,
  _state: RouterState,
  predictor: QuotaPredictor,
  opts: { hours?: string }
): Promise<string> {
  const horizon = parseInt(opts.hours ?? "", 10) || config.predictionHorizonHours;
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
    lines.push(
      `   Trend: ${pred.trend}, Confidence: ${(pred.confidence * 100).toFixed(0)}%`
    );
    if (pred.recommendation) {
      lines.push(`   → ${pred.recommendation}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function handleProviders(registry: ProviderRegistry): Promise<string> {
  const providers = registry.getAll();

  const lines: string[] = [];
  lines.push("Configured Providers:");
  lines.push("-".repeat(50));

  for (const p of providers) {
    const models =
      p.models.length > 3
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
}

async function handleSetUsage(
  state: RouterState,
  tracker: QuotaTracker,
  saveState: () => void,
  providerId: string,
  valueStr: string
): Promise<string> {
  // Initialize provider if not exists
  if (!state.quotas[providerId]) {
    state.quotas[providerId] = {
      used: 0,
      limit: 0,
      lastReset: Date.now(),
      nextReset: 0,
    };
  }

  const currentLimit = state.quotas[providerId].limit;

  // Handle percentage input (e.g., "79%")
  if (valueStr.endsWith("%")) {
    const percent = parseFloat(valueStr.slice(0, -1));
    if (isNaN(percent) || percent < 0 || percent > 100) {
      return `Invalid percentage: ${valueStr} (must be 0-100)`;
    }

    // Store percentage directly for providers without known limits (like Anthropic)
    state.quotas[providerId].percentUsed = percent;
    state.quotas[providerId].percentSource = "manual";

    if (currentLimit > 0) {
      // If we have a limit, also calculate token usage
      const used = Math.round((percent / 100) * currentLimit);
      tracker.setUsage(providerId, used);
      saveState();
      return `Set ${providerId} to ${percent}% (${used.toLocaleString()} tokens)`;
    }

    saveState();
    return `Set ${providerId} to ${percent}% (manual tracking)`;
  }

  // Handle token count input
  const used = parseInt(valueStr, 10);
  if (isNaN(used) || used < 0) {
    return `Invalid value: ${valueStr}`;
  }

  tracker.setUsage(providerId, used);
  saveState();

  const limit = state.quotas[providerId].limit;
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  return `Set ${providerId} usage to ${used.toLocaleString()} tokens${limit > 0 ? ` (${pct.toFixed(1)}%)` : ""}`;
}

async function handleReset(
  state: RouterState,
  tracker: QuotaTracker,
  saveState: () => void,
  providerId: string
): Promise<string> {
  if (!state.quotas[providerId]) {
    return `Unknown provider: ${providerId}`;
  }

  tracker.resetQuota(providerId);
  saveState();

  return `Reset quota for ${providerId}`;
}

async function handleSetResetDate(
  state: RouterState,
  saveState: () => void,
  providerId: string,
  dateStr: string
): Promise<string> {
  // Initialize provider if not exists
  if (!state.quotas[providerId]) {
    state.quotas[providerId] = {
      used: 0,
      limit: 0,
      lastReset: Date.now(),
      nextReset: 0,
    };
  }

  // Parse the date string
  let resetDate: Date;

  // Handle relative dates like "in 5 days"
  const relativeMatch = dateStr.match(/^in\s+(\d+)\s+(day|hour|minute|week)s?$/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    resetDate = new Date();

    switch (unit) {
      case "minute":
        resetDate.setMinutes(resetDate.getMinutes() + amount);
        break;
      case "hour":
        resetDate.setHours(resetDate.getHours() + amount);
        break;
      case "day":
        resetDate.setDate(resetDate.getDate() + amount);
        break;
      case "week":
        resetDate.setDate(resetDate.getDate() + amount * 7);
        break;
    }
  } else {
    // Try to parse as a date
    resetDate = new Date(dateStr);

    // If that fails, try some common formats
    if (isNaN(resetDate.getTime())) {
      // Try "Feb 12 7AM" format
      const monthDayTime = dateStr.match(
        /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)(?:\s+(\d+)(?::(\d+))?\s*(AM|PM)?)?$/i
      );

      if (monthDayTime) {
        const months: Record<string, number> = {
          jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
          jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
        };
        const month = months[monthDayTime[1].toLowerCase()];
        const day = parseInt(monthDayTime[2], 10);
        let hour = parseInt(monthDayTime[3] ?? "0", 10);
        const minute = parseInt(monthDayTime[4] ?? "0", 10);
        const ampm = monthDayTime[5]?.toUpperCase();

        if (ampm === "PM" && hour !== 12) hour += 12;
        if (ampm === "AM" && hour === 12) hour = 0;

        resetDate = new Date();
        resetDate.setMonth(month, day);
        resetDate.setHours(hour, minute, 0, 0);

        // If the date is in the past, assume next year
        if (resetDate.getTime() < Date.now()) {
          resetDate.setFullYear(resetDate.getFullYear() + 1);
        }
      }
    }
  }

  if (isNaN(resetDate.getTime())) {
    return `Could not parse date: ${dateStr}\n\nExamples:\n  Feb 12 7AM\n  2026-02-12T07:00\n  in 5 days`;
  }

  state.quotas[providerId].nextReset = resetDate.getTime();
  saveState();

  const formattedDate = resetDate.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const hoursUntil = (resetDate.getTime() - Date.now()) / (1000 * 60 * 60);
  const daysUntil = Math.floor(hoursUntil / 24);
  const remainingHours = Math.round(hoursUntil % 24);

  let timeUntil = "";
  if (daysUntil > 0) {
    timeUntil = `${daysUntil}d ${remainingHours}h`;
  } else {
    timeUntil = `${remainingHours}h`;
  }

  return `Set ${providerId} reset date to ${formattedDate} (${timeUntil} from now)`;
}

async function handleAnalyze(
  config: SmartRouterConfig,
  state: RouterState,
  optimizer: Optimizer,
  opts: { type?: string }
): Promise<string> {
  const analysisType = opts.type ?? "all";

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
      lines.push(
        `    Current: ${job.currentModel} → Suggested: ${job.suggestedModel}`
      );
      lines.push(
        `    Complexity: ${job.promptComplexity}, Success: ${(job.successRate * 100).toFixed(0)}%`
      );
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
      lines.push(
        `    Current: ${agent.primaryModel} → Suggested: ${agent.suggestedPrimaryModel}`
      );
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
}

async function handleOptimize(
  config: SmartRouterConfig,
  state: RouterState,
  optimizer: Optimizer,
  saveState: () => void,
  opts: { apply?: boolean; "safe-only"?: boolean }
): Promise<string> {
  const shouldApply = opts.apply === true;
  const safeOnly = opts["safe-only"] === true;

  const plan = optimizer.generatePlan();

  const actions = safeOnly
    ? plan.actions.filter((a) => a.reversible)
    : plan.actions;

  if (actions.length === 0) {
    return "No optimization opportunities found.";
  }

  const lines: string[] = [];
  lines.push(
    shouldApply ? "Applying optimizations..." : "Optimization Plan (dry-run):"
  );
  lines.push("-".repeat(70));

  const applier = new ActionApplier(config, !shouldApply);
  const results = await applier.applyPlan({ ...plan, actions });

  for (const result of results) {
    const icon =
      result.status === "applied"
        ? "✓"
        : result.status === "failed"
          ? "✗"
          : "○";
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
}

async function handleSync(
  state: RouterState,
  tracker: QuotaTracker,
  saveState: () => void
): Promise<string> {
  const lines: string[] = [];
  lines.push("Syncing usage from OpenClaw...");
  lines.push("");

  const usage = await fetchOpenClawUsage();

  // Track which providers we synced
  const syncedProviders = new Set<string>();

  if (usage.length === 0) {
    lines.push("No usage data found from OpenClaw.");
    lines.push("");
    lines.push("This could mean:");
    lines.push("  - No OAuth/token configured for usage-tracked providers");
    lines.push("  - Providers haven't been used recently");
    lines.push("");
    lines.push("Check 'openclaw models' for auth status.");
  } else {
    for (const entry of usage) {
      if (entry.windows.length === 0) continue;

      syncedProviders.add(entry.provider);

      // Find the most critical window (highest usage percentage)
      const criticalWindow = entry.windows.reduce((max, w) =>
        w.usedPercent > max.usedPercent ? w : max
      );

      const percent = criticalWindow.usedPercent;
      const label = criticalWindow.label;

      lines.push(`✓ ${entry.provider}:`);

      // Show all windows with the critical one marked
      for (const w of entry.windows) {
        const isCritical = w === criticalWindow;
        const marker = isCritical ? "→" : " ";
        const remainingStr = w.remainingText ? ` (${w.remainingText} left)` : "";
        lines.push(`  ${marker} ${w.label}: ${w.usedPercent.toFixed(1)}% used${remainingStr}`);
      }

      // Store percentage-based usage
      if (state.quotas[entry.provider]) {
        const quota = state.quotas[entry.provider];

        // Store the percentage directly
        quota.percentUsed = percent;
        quota.percentSource = label;

        if (quota.limit > 0) {
          // If we have a limit, also calculate token usage
          const estimatedUsed = Math.round((percent / 100) * quota.limit);
          tracker.setUsage(entry.provider, estimatedUsed);
          lines.push(`  Synced: ${estimatedUsed.toLocaleString()} tokens (${percent.toFixed(1)}%)`);
        } else {
          lines.push(`  Synced: ${percent.toFixed(1)}% (${label} window)`);
        }
      } else {
        // Initialize quota for this provider
        state.quotas[entry.provider] = {
          used: 0,
          limit: 0,
          lastReset: Date.now(),
          nextReset: 0,
          percentUsed: percent,
          percentSource: label,
        };
        lines.push(`  Synced: ${percent.toFixed(1)}% (${label} window)`);
      }

      lines.push("");
    }
  }

  saveState();

  if (usage.length > 0) {
    lines.push("Sync complete.");
  }

  // Check for Anthropic - needs manual tracking due to API limitations
  if (!syncedProviders.has("anthropic") && state.quotas["anthropic"]) {
    lines.push("");
    lines.push("⚠ Anthropic requires manual tracking:");
    lines.push("  Claude Code tokens only have 'user:inference' scope,");
    lines.push("  not 'user:profile' needed for usage API access.");
    lines.push("");
    const currentAnthropicUsage = state.quotas["anthropic"].percentUsed;
    if (currentAnthropicUsage !== undefined) {
      lines.push(`  Current: ${currentAnthropicUsage.toFixed(1)}% (${state.quotas["anthropic"].percentSource ?? "manual"})`);
    }
    lines.push("");
    lines.push("  To update manually:");
    lines.push("    openclaw router set-usage anthropic 79%");
    lines.push("");
    lines.push("  Check your usage at: https://claude.ai/settings/usage");
  } else if (!syncedProviders.has("anthropic") && !state.quotas["anthropic"]) {
    // Initialize anthropic tracking if it doesn't exist
    lines.push("");
    lines.push("ℹ Anthropic not configured for tracking.");
    lines.push("  To start manual tracking:");
    lines.push("    openclaw router set-usage anthropic 79%");
    lines.push("");
    lines.push("  Check your usage at: https://claude.ai/settings/usage");
  }

  return lines.join("\n");
}

async function handleDetectLocal(): Promise<string> {
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
}

async function handleMode(
  config: SmartRouterConfig,
  newMode?: string
): Promise<string> {
  if (!newMode) {
    return `Current mode: ${config.mode}`;
  }

  if (!["manual", "dry-run", "auto"].includes(newMode)) {
    return "Invalid mode. Use: manual, dry-run, or auto";
  }

  // Note: This would need to update config file
  return `Mode change to '${newMode}' requires updating config in openclaw.json`;
}

// =============================================================================
// Helpers
// =============================================================================

function createProgressBar(percent: number, width: number): string {
  const filled = Math.round(percent * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}
