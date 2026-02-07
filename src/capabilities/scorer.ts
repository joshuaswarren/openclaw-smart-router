/**
 * Model capability scoring for openclaw-smart-router
 *
 * Scores models on various capability dimensions for task matching
 */

import type {
  ModelCapabilities,
  TaskCapability,
  CapabilitySource,
} from "../types.js";
import { log } from "../logger.js";

// =============================================================================
// Default Capability Scores
// =============================================================================

/**
 * Default scores for well-known models
 * Scores are 0-1 where higher is better
 */
const DEFAULT_MODEL_SCORES: Record<string, Partial<Record<TaskCapability, number>>> = {
  // Anthropic
  "claude-opus-4-5": {
    coding: 0.95,
    reasoning: 0.98,
    creative: 0.92,
    instruction: 0.95,
    context: 0.90,
    speed: 0.50,
  },
  "claude-opus-4-6": {
    coding: 0.96,
    reasoning: 0.98,
    creative: 0.93,
    instruction: 0.96,
    context: 0.92,
    speed: 0.55,
  },
  "claude-sonnet-4-5": {
    coding: 0.90,
    reasoning: 0.92,
    creative: 0.88,
    instruction: 0.90,
    context: 0.88,
    speed: 0.75,
  },
  "claude-haiku-4-5": {
    coding: 0.75,
    reasoning: 0.78,
    creative: 0.72,
    instruction: 0.80,
    context: 0.70,
    speed: 0.95,
  },

  // OpenAI
  "gpt-5.3-codex": {
    coding: 0.97,
    reasoning: 0.95,
    creative: 0.85,
    instruction: 0.92,
    context: 0.95,
    speed: 0.60,
  },
  "gpt-5.2": {
    coding: 0.94,
    reasoning: 0.93,
    creative: 0.88,
    instruction: 0.90,
    context: 0.92,
    speed: 0.65,
  },
  "gpt-5-mini": {
    coding: 0.82,
    reasoning: 0.80,
    creative: 0.75,
    instruction: 0.82,
    context: 0.80,
    speed: 0.90,
  },
  "gpt-5-nano": {
    coding: 0.70,
    reasoning: 0.68,
    creative: 0.65,
    instruction: 0.72,
    context: 0.65,
    speed: 0.98,
  },
  "gpt-4o": {
    coding: 0.88,
    reasoning: 0.88,
    creative: 0.85,
    instruction: 0.88,
    context: 0.85,
    speed: 0.80,
  },
  "gpt-4o-mini": {
    coding: 0.78,
    reasoning: 0.75,
    creative: 0.72,
    instruction: 0.78,
    context: 0.72,
    speed: 0.92,
  },

  // Google
  "gemini-2.5-flash": {
    coding: 0.85,
    reasoning: 0.83,
    creative: 0.80,
    instruction: 0.85,
    context: 0.88,
    speed: 0.85,
  },
  "gemini-2.5-flash-lite": {
    coding: 0.72,
    reasoning: 0.70,
    creative: 0.68,
    instruction: 0.72,
    context: 0.70,
    speed: 0.95,
  },
  "gemini-3-flash-preview": {
    coding: 0.88,
    reasoning: 0.86,
    creative: 0.82,
    instruction: 0.88,
    context: 0.90,
    speed: 0.82,
  },

  // Z.ai
  "glm-4.7": {
    coding: 0.65,
    reasoning: 0.62,
    creative: 0.60,
    instruction: 0.65,
    context: 0.75,
    speed: 0.70,
  },

  // Kimi
  "kimi-code/kimi-for-coding": {
    coding: 0.80,
    reasoning: 0.75,
    creative: 0.65,
    instruction: 0.78,
    context: 0.85,
    speed: 0.72,
  },

  // Local models (estimates for typical MLX models)
  "local-default": {
    coding: 0.60,
    reasoning: 0.55,
    creative: 0.50,
    instruction: 0.58,
    context: 0.40,
    speed: 0.98,
  },
};

// =============================================================================
// Capability Scorer
// =============================================================================

export class CapabilityScorer {
  private cache: Map<string, ModelCapabilities> = new Map();

  /**
   * Get capability scores for a model
   */
  getCapabilities(
    modelId: string,
    provider: string,
    manualScores?: Record<string, number>
  ): ModelCapabilities {
    const cacheKey = `${provider}/${modelId}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Try to find default scores
    const defaultScores = this.findDefaultScores(modelId);

    // Merge with manual scores
    const scores = this.mergeScores(defaultScores, manualScores);

    const capabilities: ModelCapabilities = {
      modelId,
      provider,
      scores,
      contextWindow: this.estimateContextWindow(modelId),
      maxTokens: this.estimateMaxTokens(modelId),
      latencyClass: this.inferLatencyClass(scores.speed ?? 0.5),
      source: manualScores ? "manual" : defaultScores ? "infer" : "infer",
      lastUpdated: new Date(),
    };

    this.cache.set(cacheKey, capabilities);
    return capabilities;
  }

  /**
   * Find default scores for a model
   */
  private findDefaultScores(
    modelId: string
  ): Partial<Record<TaskCapability, number>> | null {
    // Exact match
    if (DEFAULT_MODEL_SCORES[modelId]) {
      return DEFAULT_MODEL_SCORES[modelId];
    }

    // Try normalized ID (remove version suffix, provider prefix)
    const normalized = modelId
      .replace(/^[^/]+\//, "") // Remove provider prefix
      .replace(/-\d{8}$/, "") // Remove date suffix
      .replace(/-\d+$/, ""); // Remove version suffix

    if (DEFAULT_MODEL_SCORES[normalized]) {
      return DEFAULT_MODEL_SCORES[normalized];
    }

    // Try partial match
    for (const [key, scores] of Object.entries(DEFAULT_MODEL_SCORES)) {
      if (modelId.includes(key) || key.includes(modelId)) {
        return scores;
      }
    }

    log.debug(`no default scores for model: ${modelId}`);
    return null;
  }

  /**
   * Merge default scores with manual overrides
   */
  private mergeScores(
    defaults: Partial<Record<TaskCapability, number>> | null,
    manual?: Record<string, number>
  ): Record<TaskCapability, number> {
    const capabilities: TaskCapability[] = [
      "coding",
      "reasoning",
      "creative",
      "instruction",
      "context",
      "speed",
    ];

    const result: Record<TaskCapability, number> = {
      coding: 0.5,
      reasoning: 0.5,
      creative: 0.5,
      instruction: 0.5,
      context: 0.5,
      speed: 0.5,
    };

    // Apply defaults
    if (defaults) {
      for (const cap of capabilities) {
        if (defaults[cap] !== undefined) {
          result[cap] = defaults[cap];
        }
      }
    }

    // Apply manual overrides
    if (manual) {
      for (const cap of capabilities) {
        if (manual[cap] !== undefined) {
          result[cap] = manual[cap];
        }
      }
    }

    return result;
  }

  /**
   * Estimate context window from model name
   */
  private estimateContextWindow(modelId: string): number {
    const id = modelId.toLowerCase();

    if (id.includes("128k")) return 128000;
    if (id.includes("200k")) return 200000;
    if (id.includes("1m")) return 1000000;
    if (id.includes("2m")) return 2000000;

    // Defaults by model family
    if (id.includes("claude")) return 200000;
    if (id.includes("gpt-5")) return 128000;
    if (id.includes("gpt-4")) return 128000;
    if (id.includes("gemini")) return 1000000;

    return 32000; // Conservative default
  }

  /**
   * Estimate max output tokens from model name
   */
  private estimateMaxTokens(modelId: string): number {
    const id = modelId.toLowerCase();

    if (id.includes("opus")) return 8192;
    if (id.includes("sonnet")) return 8192;
    if (id.includes("haiku")) return 4096;
    if (id.includes("gpt-5")) return 16384;
    if (id.includes("gpt-4")) return 16384;
    if (id.includes("gemini")) return 8192;

    return 4096; // Conservative default
  }

  /**
   * Infer latency class from speed score
   */
  private inferLatencyClass(speedScore: number): "fast" | "medium" | "slow" {
    if (speedScore >= 0.85) return "fast";
    if (speedScore >= 0.6) return "medium";
    return "slow";
  }

  /**
   * Compare two models for a specific capability
   */
  compare(
    modelA: string,
    modelB: string,
    capability: TaskCapability
  ): number {
    const capsA = this.getCapabilities(modelA, "unknown");
    const capsB = this.getCapabilities(modelB, "unknown");

    return capsA.scores[capability] - capsB.scores[capability];
  }

  /**
   * Get overall score for a model (weighted average)
   */
  getOverallScore(modelId: string, provider: string): number {
    const caps = this.getCapabilities(modelId, provider);
    const weights = {
      coding: 0.25,
      reasoning: 0.25,
      creative: 0.15,
      instruction: 0.20,
      context: 0.10,
      speed: 0.05,
    };

    let score = 0;
    for (const [cap, weight] of Object.entries(weights)) {
      score += caps.scores[cap as TaskCapability] * weight;
    }

    return score;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
    log.debug("capability cache cleared");
  }

  /**
   * Update cache with external data (e.g., from HuggingFace)
   */
  updateFromExternal(
    modelId: string,
    provider: string,
    scores: Partial<Record<TaskCapability, number>>,
    source: CapabilitySource
  ): void {
    const existing = this.getCapabilities(modelId, provider);
    const updated: ModelCapabilities = {
      ...existing,
      scores: { ...existing.scores, ...scores },
      source,
      lastUpdated: new Date(),
    };

    const cacheKey = `${provider}/${modelId}`;
    this.cache.set(cacheKey, updated);
    log.debug(`updated capabilities for ${cacheKey} from ${source}`);
  }
}
