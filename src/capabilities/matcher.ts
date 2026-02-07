/**
 * Task-to-model matching for openclaw-smart-router
 *
 * Matches task requirements to suitable models based on capabilities
 */

import type {
  TaskProfile,
  TaskCapability,
  ModelCapabilities,
  SmartRouterConfig,
  RouterState,
  ProviderTier,
} from "../types.js";
import { CapabilityScorer } from "./scorer.js";
import { ProviderRegistry, RegisteredProvider } from "../providers/registry.js";
import { log } from "../logger.js";

// =============================================================================
// Task Classification
// =============================================================================

/**
 * Classify a prompt into a task profile
 */
export function classifyPrompt(prompt: string): TaskProfile {
  const lower = prompt.toLowerCase();

  // Detect primary capability
  let primaryCapability: TaskCapability = "instruction";
  let qualityThreshold = 0.7;

  // Coding signals
  const codingSignals = [
    "code",
    "function",
    "class",
    "implement",
    "debug",
    "fix bug",
    "write a script",
    "api",
    "endpoint",
    "database",
    "sql",
    "typescript",
    "javascript",
    "python",
    "```",
  ];

  // Reasoning signals
  const reasoningSignals = [
    "analyze",
    "design",
    "architect",
    "plan",
    "strategy",
    "evaluate",
    "compare",
    "consider",
    "trade-off",
    "pros and cons",
    "reasoning",
    "think through",
    "step by step",
  ];

  // Creative signals
  const creativeSignals = [
    "write",
    "story",
    "blog",
    "article",
    "creative",
    "brainstorm",
    "ideas",
    "suggest",
    "generate content",
    "marketing",
  ];

  // Simple signals (lower quality ok)
  const simpleSignals = [
    "summarize",
    "list",
    "check",
    "status",
    "count",
    "format",
    "convert",
    "extract",
    "parse",
  ];

  // Score each category
  let codingScore = 0;
  let reasoningScore = 0;
  let creativeScore = 0;
  let simpleScore = 0;

  for (const signal of codingSignals) {
    if (lower.includes(signal)) codingScore++;
  }
  for (const signal of reasoningSignals) {
    if (lower.includes(signal)) reasoningScore++;
  }
  for (const signal of creativeSignals) {
    if (lower.includes(signal)) creativeScore++;
  }
  for (const signal of simpleSignals) {
    if (lower.includes(signal)) simpleScore++;
  }

  // Determine primary capability
  const maxScore = Math.max(codingScore, reasoningScore, creativeScore, simpleScore);

  if (maxScore === 0) {
    primaryCapability = "instruction";
    qualityThreshold = 0.6;
  } else if (simpleScore === maxScore && simpleScore >= 2) {
    primaryCapability = "instruction";
    qualityThreshold = 0.4;
  } else if (codingScore === maxScore) {
    primaryCapability = "coding";
    qualityThreshold = 0.8;
  } else if (reasoningScore === maxScore) {
    primaryCapability = "reasoning";
    qualityThreshold = 0.75;
  } else if (creativeScore === maxScore) {
    primaryCapability = "creative";
    qualityThreshold = 0.6;
  }

  // Determine context length
  let contextLength: "short" | "medium" | "long" = "medium";
  if (prompt.length < 500) {
    contextLength = "short";
  } else if (prompt.length > 5000) {
    contextLength = "long";
  }

  // Detect latency sensitivity
  const latencySensitive =
    lower.includes("interactive") ||
    lower.includes("real-time") ||
    lower.includes("quick") ||
    lower.includes("fast response");

  return {
    primaryCapability,
    contextLength,
    latencySensitive,
    qualityThreshold,
  };
}

/**
 * Infer complexity from prompt
 */
export function inferComplexity(
  prompt: string
): "simple" | "moderate" | "complex" {
  const length = prompt.length;
  const lower = prompt.toLowerCase();

  // Complex indicators
  const complexIndicators = [
    "multi-step",
    "complex",
    "detailed",
    "comprehensive",
    "in-depth",
    "first,",
    "then,",
    "after that",
    "step 1",
    "step 2",
    "finally",
  ];

  let complexityScore = 0;
  for (const indicator of complexIndicators) {
    if (lower.includes(indicator)) complexityScore++;
  }

  // Factor in length
  if (length > 3000) complexityScore += 2;
  else if (length > 1000) complexityScore += 1;

  if (complexityScore >= 3) return "complex";
  if (complexityScore >= 1) return "moderate";
  return "simple";
}

// =============================================================================
// Model Matcher
// =============================================================================

export interface ModelMatch {
  model: string;
  provider: string;
  score: number;
  tier: ProviderTier;
  reason: string;
}

export class ModelMatcher {
  private config: SmartRouterConfig;
  private scorer: CapabilityScorer;
  private registry: ProviderRegistry;

  constructor(
    config: SmartRouterConfig,
    scorer: CapabilityScorer,
    registry: ProviderRegistry
  ) {
    this.config = config;
    this.scorer = scorer;
    this.registry = registry;
  }

  /**
   * Find models suitable for a task profile
   */
  findSuitableModels(
    task: TaskProfile,
    state: RouterState,
    preferredTiers?: ProviderTier[]
  ): ModelMatch[] {
    const matches: ModelMatch[] = [];

    // Get available providers
    const providers = this.registry.getAvailable(state);

    for (const provider of providers) {
      // Check tier preference
      if (
        preferredTiers &&
        preferredTiers.length > 0 &&
        !preferredTiers.includes(provider.config.tier ?? "standard")
      ) {
        continue;
      }

      // Score each model
      for (const modelId of provider.models) {
        const caps = this.scorer.getCapabilities(modelId, provider.id);
        const score = this.scoreModelForTask(caps, task);

        if (score >= task.qualityThreshold) {
          matches.push({
            model: modelId,
            provider: provider.id,
            score,
            tier: provider.config.tier ?? "standard",
            reason: this.explainMatch(caps, task, score),
          });
        }
      }
    }

    // Sort by score descending, then by tier preference
    matches.sort((a, b) => {
      // Higher score first
      if (b.score !== a.score) return b.score - a.score;
      // Prefer cheaper tiers for equal scores
      const tierOrder: ProviderTier[] = ["local", "free", "budget", "standard", "premium"];
      return tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier);
    });

    return matches;
  }

  /**
   * Score a model for a specific task
   */
  private scoreModelForTask(
    caps: ModelCapabilities,
    task: TaskProfile
  ): number {
    // Primary capability is most important
    let score = caps.scores[task.primaryCapability] * 0.6;

    // Add secondary capabilities
    if (task.secondaryCapabilities) {
      const secondaryAvg =
        task.secondaryCapabilities.reduce(
          (sum, cap) => sum + caps.scores[cap],
          0
        ) / task.secondaryCapabilities.length;
      score += secondaryAvg * 0.2;
    }

    // Context handling
    if (task.contextLength === "long" && caps.scores.context < 0.7) {
      score *= 0.8; // Penalty for poor context handling
    }

    // Latency sensitivity
    if (task.latencySensitive) {
      score *= 0.8 + caps.scores.speed * 0.2;
    }

    return Math.min(1, score);
  }

  /**
   * Generate explanation for a match
   */
  private explainMatch(
    caps: ModelCapabilities,
    task: TaskProfile,
    score: number
  ): string {
    const primary = task.primaryCapability;
    const primaryScore = caps.scores[primary];

    const parts = [];
    parts.push(`${(primaryScore * 100).toFixed(0)}% ${primary}`);

    if (task.latencySensitive && caps.latencyClass === "fast") {
      parts.push("fast");
    }

    if (task.contextLength === "long" && caps.scores.context >= 0.8) {
      parts.push("good context");
    }

    return parts.join(", ");
  }

  /**
   * Find the best model for a task
   */
  findBestModel(
    task: TaskProfile,
    state: RouterState
  ): ModelMatch | null {
    const matches = this.findSuitableModels(task, state);
    return matches[0] ?? null;
  }

  /**
   * Find a cheaper alternative for a task
   */
  findCheaperAlternative(
    currentModel: string,
    task: TaskProfile,
    state: RouterState
  ): ModelMatch | null {
    // Get current model's tier
    const providers = this.registry.getAll();
    let currentTier: ProviderTier = "standard";

    for (const provider of providers) {
      if (provider.models.includes(currentModel)) {
        currentTier = provider.config.tier ?? "standard";
        break;
      }
    }

    // Find cheaper tiers
    const tierOrder: ProviderTier[] = ["local", "free", "budget", "standard", "premium"];
    const currentIndex = tierOrder.indexOf(currentTier);
    const cheaperTiers = tierOrder.slice(0, currentIndex);

    if (cheaperTiers.length === 0) {
      return null;
    }

    const matches = this.findSuitableModels(task, state, cheaperTiers);
    return matches[0] ?? null;
  }

  /**
   * Check if a model meets quality requirements
   */
  meetsQualityRequirements(
    modelId: string,
    provider: string,
    task: TaskProfile
  ): boolean {
    const caps = this.scorer.getCapabilities(modelId, provider);
    const score = this.scoreModelForTask(caps, task);
    return score >= task.qualityThreshold;
  }
}
