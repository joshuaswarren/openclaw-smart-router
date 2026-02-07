/**
 * Configuration parsing for openclaw-smart-router
 */

import { z } from "zod";
import type {
  SmartRouterConfig,
  ProviderConfig,
  QualityThresholds,
  ResetSchedule,
  BudgetConfig,
  LocalConfig,
  CapabilityConfig,
} from "./types.js";
import { homedir } from "os";
import { join } from "path";

// =============================================================================
// Zod Schemas
// =============================================================================

const ResetScheduleSchema = z.object({
  type: z.enum(["daily", "weekly", "monthly", "fixed"]),
  dayOfWeek: z.number().min(0).max(6).optional(),
  dayOfMonth: z.number().min(1).max(31).optional(),
  fixedDate: z.string().optional(),
  hour: z.number().min(0).max(23).default(0),
  timezone: z.string().default("UTC"),
});

const BudgetConfigSchema = z.object({
  monthlyLimit: z.number().positive(),
  alertThreshold: z.number().min(0).max(1).default(0.8),
  currentSpend: z.number().min(0).optional(),
});

const LocalConfigSchema = z.object({
  type: z.enum(["mlx", "ollama", "vllm", "lmstudio", "generic"]),
  endpoint: z.string(),
  models: z.array(z.string()),
});

const CapabilityConfigSchema = z.object({
  source: z.enum(["huggingface", "manual", "infer"]).default("infer"),
  scores: z.record(z.string(), z.number().min(0).max(1)).optional(),
});

const ProviderConfigSchema = z.object({
  quotaSource: z.enum(["api", "manual", "unlimited"]).default("manual"),
  limit: z.number().positive().optional(),
  quotaType: z.enum(["tokens", "requests"]).default("tokens"),
  resetSchedule: ResetScheduleSchema.optional(),
  budget: BudgetConfigSchema.optional(),
  capabilities: CapabilityConfigSchema.optional(),
  local: LocalConfigSchema.optional(),
  tier: z.enum(["premium", "standard", "budget", "free", "local"]).default("standard"),
  priority: z.number().default(50),
});

const QualityThresholdsSchema = z.object({
  coding: z.number().min(0).max(1).default(0.8),
  reasoning: z.number().min(0).max(1).default(0.75),
  creative: z.number().min(0).max(1).default(0.6),
  simple: z.number().min(0).max(1).default(0.4),
});

const ConfigSchema = z.object({
  mode: z.enum(["manual", "dry-run", "auto"]).default("dry-run"),
  debug: z.boolean().default(false),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  qualityThresholds: QualityThresholdsSchema.default({}),
  predictionHorizonHours: z.number().positive().default(24),
  warningThreshold: z.number().min(0).max(1).default(0.8),
  criticalThreshold: z.number().min(0).max(1).default(0.95),
  optimizationIntervalMinutes: z.number().positive().default(60),
  localModelPreference: z.enum(["never", "simple-only", "when-available", "prefer"]).default("simple-only"),
  stateFile: z.string().optional(),
});

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_STATE_FILE = join(
  homedir(),
  ".openclaw",
  "extensions",
  "openclaw-smart-router",
  "state.json"
);

// =============================================================================
// Parse Configuration
// =============================================================================

export function parseConfig(raw: unknown): SmartRouterConfig {
  const input = raw ?? {};
  const parsed = ConfigSchema.parse(input);

  return {
    mode: parsed.mode,
    debug: parsed.debug,
    providers: parsed.providers as Record<string, ProviderConfig>,
    qualityThresholds: parsed.qualityThresholds as QualityThresholds,
    predictionHorizonHours: parsed.predictionHorizonHours,
    warningThreshold: parsed.warningThreshold,
    criticalThreshold: parsed.criticalThreshold,
    optimizationIntervalMinutes: parsed.optimizationIntervalMinutes,
    localModelPreference: parsed.localModelPreference,
    stateFile: parsed.stateFile ?? DEFAULT_STATE_FILE,
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Resolve environment variables in a string
 * Supports ${VAR_NAME} syntax
 */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] ?? "";
  });
}

/**
 * Get the OpenClaw data directory
 */
export function getOpenClawDir(): string {
  return join(homedir(), ".openclaw");
}

/**
 * Get the cron jobs file path
 */
export function getCronJobsPath(): string {
  return join(getOpenClawDir(), "cron", "jobs.json");
}

/**
 * Get the cron runs directory
 */
export function getCronRunsDir(): string {
  return join(getOpenClawDir(), "cron", "runs");
}

/**
 * Get the agents directory
 */
export function getAgentsDir(): string {
  return join(getOpenClawDir(), "agents");
}

/**
 * Get the openclaw.json path
 */
export function getOpenClawConfigPath(): string {
  return join(getOpenClawDir(), "openclaw.json");
}
