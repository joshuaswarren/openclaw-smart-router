/**
 * Cron job and agent analyzer for openclaw-smart-router
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import type {
  CronJobAnalysis,
  AgentAnalysis,
  TaskCapability,
  SplitOpportunity,
  SmartRouterConfig,
  RouterState,
} from "../types.js";
import {
  getCronJobsPath,
  getCronRunsDir,
  getAgentsDir,
} from "../config.js";
import { classifyPrompt, inferComplexity } from "../capabilities/matcher.js";
import { log } from "../logger.js";

// =============================================================================
// Cron Job Analysis
// =============================================================================

interface CronJob {
  id: string;
  name?: string;
  schedule: string;
  model?: string;
  prompt?: string;
  enabled?: boolean;
  state?: {
    lastRunAtMs?: number;
    nextRunAtMs?: number;
  };
}

interface RunRecord {
  timestamp: number;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
}

/**
 * Load cron jobs from jobs.json
 */
function loadCronJobs(): CronJob[] {
  const path = getCronJobsPath();

  if (!existsSync(path)) {
    log.debug("cron jobs.json not found");
    return [];
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);

    // Handle both array and object formats
    if (Array.isArray(data)) {
      return data;
    }

    if (data.jobs && Array.isArray(data.jobs)) {
      return data.jobs;
    }

    // Jobs might be keyed by ID
    return Object.values(data).filter(
      (v): v is CronJob => typeof v === "object" && v !== null && "id" in v
    );
  } catch (err) {
    log.error("failed to load cron jobs", err);
    return [];
  }
}

/**
 * Load run history for a job
 */
function loadRunHistory(jobId: string): RunRecord[] {
  const runsDir = getCronRunsDir();

  if (!existsSync(runsDir)) {
    return [];
  }

  try {
    const files = readdirSync(runsDir);
    const jobFile = files.find((f) => f.includes(jobId) && f.endsWith(".jsonl"));

    if (!jobFile) {
      return [];
    }

    const content = readFileSync(join(runsDir, jobFile), "utf-8");
    const lines = content.trim().split("\n");

    return lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((r): r is RunRecord => r !== null);
  } catch (err) {
    log.debug(`failed to load run history for ${jobId}`, err);
    return [];
  }
}

/**
 * Detect tools used in a prompt
 */
function detectToolsUsed(prompt: string): string[] {
  const tools: string[] = [];
  const lower = prompt.toLowerCase();

  const toolPatterns = [
    { pattern: /\bmessage\s*\(/, name: "message" },
    { pattern: /\bread\s*\(/, name: "read" },
    { pattern: /\bwrite\s*\(/, name: "write" },
    { pattern: /\bexec\s*\(/, name: "exec" },
    { pattern: /\bfetch\s*\(/, name: "fetch" },
    { pattern: /\bsearch\s*\(/, name: "search" },
    { pattern: /use the message tool/i, name: "message" },
    { pattern: /use the read tool/i, name: "read" },
    { pattern: /use the write tool/i, name: "write" },
  ];

  for (const { pattern, name } of toolPatterns) {
    if (pattern.test(lower)) {
      tools.push(name);
    }
  }

  return [...new Set(tools)];
}

/**
 * Identify split opportunities in a prompt
 */
function identifySplitOpportunities(
  prompt: string,
  complexity: "simple" | "moderate" | "complex"
): SplitOpportunity[] {
  if (complexity === "simple") {
    return [];
  }

  const opportunities: SplitOpportunity[] = [];
  const lower = prompt.toLowerCase();

  // Look for multi-step patterns
  const stepPatterns = [
    /first[,\s]+([^.]+)/gi,
    /then[,\s]+([^.]+)/gi,
    /after that[,\s]+([^.]+)/gi,
    /finally[,\s]+([^.]+)/gi,
    /step \d+[:\s]+([^.]+)/gi,
    /\d+\.\s+([^.]+)/gi,
  ];

  for (const pattern of stepPatterns) {
    const matches = lower.matchAll(pattern);
    for (const match of matches) {
      if (match[1] && match[1].length > 20) {
        opportunities.push({
          subtask: match[1].slice(0, 50) + "...",
          description: `Identified sub-step: "${match[1].slice(0, 100)}"`,
          suggestedModel: "gemini-2.5-flash-lite", // Default cheaper model
          complexity: "simple",
          estimatedTokens: 500,
        });
      }
    }
  }

  // Look for distinct functional areas
  if (lower.includes("read") && lower.includes("write")) {
    opportunities.push({
      subtask: "Data retrieval phase",
      description: "Separate read operations from write operations",
      suggestedModel: "gemini-2.5-flash-lite",
      complexity: "simple",
      estimatedTokens: 300,
    });
  }

  if (lower.includes("summarize") && lower.includes("analyze")) {
    opportunities.push({
      subtask: "Summary generation",
      description: "Simple summarization can use cheaper model",
      suggestedModel: "gpt-5-nano",
      complexity: "simple",
      estimatedTokens: 400,
    });
  }

  return opportunities.slice(0, 5); // Limit to 5 opportunities
}

/**
 * Analyze all cron jobs
 */
export function analyzeCronJobs(
  config: SmartRouterConfig,
  state: RouterState
): CronJobAnalysis[] {
  const jobs = loadCronJobs();
  const analyses: CronJobAnalysis[] = [];

  for (const job of jobs) {
    if (!job.enabled && job.enabled !== undefined) {
      continue; // Skip disabled jobs
    }

    const prompt = job.prompt ?? "";
    const taskProfile = classifyPrompt(prompt);
    const complexity = inferComplexity(prompt);
    const history = loadRunHistory(job.id);

    // Calculate historical metrics
    const successfulRuns = history.filter((r) => r.success !== false);
    const avgTokensPerRun =
      successfulRuns.length > 0
        ? successfulRuns.reduce(
            (sum, r) => sum + (r.tokensIn ?? 0) + (r.tokensOut ?? 0),
            0
          ) / successfulRuns.length
        : 500; // Default estimate

    const avgDurationMs =
      successfulRuns.length > 0
        ? successfulRuns.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) /
          successfulRuns.length
        : 30000;

    const successRate =
      history.length > 0 ? successfulRuns.length / history.length : 1;

    // Calculate run frequency (runs per day)
    const runFrequency = estimateRunFrequency(job.schedule);

    // Determine if can downgrade
    const canDowngrade = complexity !== "complex" && successRate > 0.9;

    // Get split opportunities
    const splitOpportunities = identifySplitOpportunities(prompt, complexity);

    const analysis: CronJobAnalysis = {
      id: job.id,
      name: job.name ?? job.id,
      schedule: job.schedule,
      currentModel: job.model ?? "default",
      promptLength: prompt.length,
      promptComplexity: complexity,
      detectedCapabilities: [taskProfile.primaryCapability],
      toolsUsed: detectToolsUsed(prompt),
      avgTokensPerRun,
      avgDurationMs,
      successRate,
      lastRunAt: job.state?.lastRunAtMs,
      runFrequency,
      dailyTokenCost: avgTokensPerRun * runFrequency,
      monthlyProjectedCost: avgTokensPerRun * runFrequency * 30,
      currentProviderShare: 0, // TODO: Calculate from state
      canDowngrade,
      downgradeReason: canDowngrade
        ? `${complexity} complexity with ${(successRate * 100).toFixed(0)}% success rate`
        : `Complex task or low success rate`,
      suggestedModel: canDowngrade ? suggestCheaperModel(job.model ?? "default") : undefined,
      estimatedSavings: canDowngrade ? avgTokensPerRun * 0.3 : 0,
      canSplit: splitOpportunities.length > 0,
      splitOpportunities,
    };

    analyses.push(analysis);
  }

  return analyses;
}

/**
 * Estimate runs per day from cron schedule
 */
function estimateRunFrequency(schedule: string): number {
  // Parse cron expression (simplified)
  const parts = schedule.split(" ");

  if (parts.length !== 5) {
    return 1; // Default to once daily
  }

  const [minute, hour, , , ] = parts;

  // Check for every N minutes pattern
  const everyMinutes = minute.match(/\*\/(\d+)/);
  if (everyMinutes) {
    return (24 * 60) / parseInt(everyMinutes[1], 10);
  }

  // Check for every N hours pattern
  const everyHours = hour.match(/\*\/(\d+)/);
  if (everyHours) {
    return 24 / parseInt(everyHours[1], 10);
  }

  // Count specific hours
  if (hour !== "*") {
    const hours = hour.split(",");
    return hours.length;
  }

  // Count specific minutes per hour
  if (minute !== "*") {
    const minutes = minute.split(",");
    return minutes.length * 24;
  }

  return 24 * 60; // Every minute (worst case)
}

/**
 * Suggest a cheaper model alternative
 */
function suggestCheaperModel(currentModel: string): string {
  const downgrades: Record<string, string> = {
    "claude-opus-4-5": "claude-sonnet-4-5",
    "claude-opus-4-6": "claude-sonnet-4-5",
    "claude-sonnet-4-5": "claude-haiku-4-5",
    "gpt-5.3-codex": "gpt-5.2",
    "gpt-5.2": "gpt-5-mini",
    "gpt-5-mini": "gpt-5-nano",
    "gemini-3-flash-preview": "gemini-2.5-flash",
    "gemini-2.5-flash": "gemini-2.5-flash-lite",
  };

  return downgrades[currentModel] ?? "gemini-2.5-flash-lite";
}

// =============================================================================
// Agent Analysis
// =============================================================================

/**
 * Analyze all agents
 */
export function analyzeAgents(
  config: SmartRouterConfig,
  state: RouterState
): AgentAnalysis[] {
  const agentsDir = getAgentsDir();
  const analyses: AgentAnalysis[] = [];

  if (!existsSync(agentsDir)) {
    log.debug("agents directory not found");
    return [];
  }

  try {
    const agentIds = readdirSync(agentsDir).filter((f) => {
      const agentPath = join(agentsDir, f, "agent");
      return existsSync(agentPath);
    });

    for (const agentId of agentIds) {
      const analysis = analyzeAgent(agentId, config, state);
      if (analysis) {
        analyses.push(analysis);
      }
    }
  } catch (err) {
    log.error("failed to analyze agents", err);
  }

  return analyses;
}

/**
 * Analyze a single agent
 */
function analyzeAgent(
  agentId: string,
  config: SmartRouterConfig,
  state: RouterState
): AgentAnalysis | null {
  const agentDir = join(getAgentsDir(), agentId, "agent");

  if (!existsSync(agentDir)) {
    return null;
  }

  try {
    // Load agent config
    const modelsPath = join(agentDir, "models.json");
    let primaryModel = "default";
    let fallbackChain: string[] = [];

    if (existsSync(modelsPath)) {
      const modelsData = JSON.parse(readFileSync(modelsPath, "utf-8"));
      primaryModel = modelsData.primary ?? modelsData.model ?? "default";
      fallbackChain = modelsData.fallbacks ?? [];
    }

    // Load auth profiles
    const authPath = join(agentDir, "auth-profiles.json");
    let availableProviders: string[] = [];
    let providersInCooldown: string[] = [];

    if (existsSync(authPath)) {
      const authData = JSON.parse(readFileSync(authPath, "utf-8"));
      for (const [key, value] of Object.entries(authData)) {
        const provider = key.split(":")[0];
        if (!availableProviders.includes(provider)) {
          availableProviders.push(provider);
        }
        const profile = value as { inCooldown?: boolean };
        if (profile.inCooldown) {
          providersInCooldown.push(provider);
        }
      }
    }

    // Count active sessions
    const sessionsDir = join(getAgentsDir(), agentId, "sessions");
    let activeSessionCount = 0;

    if (existsSync(sessionsDir)) {
      const sessions = readdirSync(sessionsDir).filter((f) =>
        f.endsWith(".jsonl")
      );
      activeSessionCount = sessions.length;
    }

    // Determine if can use cheaper default
    const canUseCheaperDefault = !primaryModel.includes("opus") && activeSessionCount < 5;

    return {
      id: agentId,
      name: agentId,
      isDefault: agentId === "generalist" || agentId === "main",
      primaryModel,
      fallbackChain,
      activeSessionCount,
      avgSessionTokens: 0, // TODO: Calculate from session data
      dominantTaskTypes: ["instruction"], // TODO: Infer from sessions
      availableProviders,
      providersInCooldown,
      canUseCheaperDefault,
      suggestedPrimaryModel: canUseCheaperDefault
        ? suggestCheaperModel(primaryModel)
        : undefined,
      reasoning: canUseCheaperDefault
        ? "Low session count allows cheaper model"
        : "Current model appropriate for workload",
    };
  } catch (err) {
    log.error(`failed to analyze agent ${agentId}`, err);
    return null;
  }
}
