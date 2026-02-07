/**
 * Quota exhaustion prediction for openclaw-smart-router
 */

import type {
  RouterState,
  SmartRouterConfig,
  ExhaustionPrediction,
} from "../types.js";
import { log } from "../logger.js";

// =============================================================================
// Prediction Engine
// =============================================================================

export class QuotaPredictor {
  private config: SmartRouterConfig;
  private state: RouterState;

  constructor(config: SmartRouterConfig, state: RouterState) {
    this.config = config;
    this.state = state;
  }

  /**
   * Update state reference (after state changes)
   */
  updateState(state: RouterState): void {
    this.state = state;
  }

  /**
   * Predict when a provider's quota will be exhausted
   */
  predict(provider: string): ExhaustionPrediction {
    const quota = this.state.quotas[provider];

    if (!quota) {
      return {
        provider,
        willExhaust: false,
        confidence: 0,
        trend: "stable",
        recommendation: `No quota tracking for ${provider}`,
      };
    }

    // If already exhausted
    if (quota.used >= quota.limit) {
      const resetDate = quota.nextReset > 0 ? new Date(quota.nextReset) : undefined;
      return {
        provider,
        willExhaust: true,
        predictedExhaustionTime: new Date(),
        hoursUntilExhaustion: 0,
        confidence: 1,
        trend: "stable",
        recommendation: resetDate
          ? `Quota exhausted. Resets at ${resetDate.toLocaleString()}`
          : "Quota exhausted. Consider upgrading or using fallback providers.",
      };
    }

    // Calculate usage rate
    const usageRate = this.calculateUsageRate(provider);
    const trend = this.getUsageTrend(provider);

    if (usageRate.tokensPerHour === 0) {
      return {
        provider,
        willExhaust: false,
        confidence: 0.5,
        trend: "stable",
        recommendation: "No recent usage to predict from",
      };
    }

    // Calculate time until exhaustion
    const remaining = quota.limit - quota.used;
    const hoursUntilExhaustion = remaining / usageRate.tokensPerHour;
    const predictedExhaustionTime = new Date(
      Date.now() + hoursUntilExhaustion * 60 * 60 * 1000
    );

    // Check if exhaustion is before reset
    const willExhaustBeforeReset =
      quota.nextReset === 0 || predictedExhaustionTime.getTime() < quota.nextReset;

    // Generate recommendation
    let recommendation: string;
    if (!willExhaustBeforeReset) {
      recommendation = `Quota will reset before exhaustion`;
    } else if (hoursUntilExhaustion < 1) {
      recommendation = `CRITICAL: Less than 1 hour until exhaustion. Shift workload now.`;
    } else if (hoursUntilExhaustion < 6) {
      recommendation = `WARNING: ~${hoursUntilExhaustion.toFixed(1)}h until exhaustion. Consider routing to alternatives.`;
    } else if (hoursUntilExhaustion < 24) {
      recommendation = `Will exhaust in ~${hoursUntilExhaustion.toFixed(0)}h. Monitor usage.`;
    } else {
      recommendation = `On track to exhaust in ${(hoursUntilExhaustion / 24).toFixed(1)} days.`;
    }

    return {
      provider,
      willExhaust: willExhaustBeforeReset,
      predictedExhaustionTime: willExhaustBeforeReset
        ? predictedExhaustionTime
        : undefined,
      hoursUntilExhaustion: willExhaustBeforeReset
        ? hoursUntilExhaustion
        : undefined,
      confidence: usageRate.confidence,
      trend,
      recommendation,
    };
  }

  /**
   * Get predictions for all providers
   */
  predictAll(): ExhaustionPrediction[] {
    return Object.keys(this.state.quotas).map((p) => this.predict(p));
  }

  /**
   * Get providers that need attention (will exhaust soon)
   */
  getProvidersNeedingAttention(): ExhaustionPrediction[] {
    const horizonMs = this.config.predictionHorizonHours * 60 * 60 * 1000;
    const cutoff = Date.now() + horizonMs;

    return this.predictAll().filter((p) => {
      if (!p.willExhaust) return false;
      if (!p.predictedExhaustionTime) return true; // Already exhausted
      return p.predictedExhaustionTime.getTime() < cutoff;
    });
  }

  /**
   * Calculate usage rate for a provider
   */
  private calculateUsageRate(provider: string): {
    tokensPerHour: number;
    confidence: number;
  } {
    // Look at last 24 hours of usage
    const windowMs = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    const records = this.state.usageHistory.filter(
      (r) => r.provider === provider && r.timestamp >= cutoff
    );

    if (records.length === 0) {
      return { tokensPerHour: 0, confidence: 0 };
    }

    // Calculate total tokens and time span
    const totalTokens = records.reduce(
      (sum, r) => sum + r.tokensIn + r.tokensOut,
      0
    );

    const firstTimestamp = Math.min(...records.map((r) => r.timestamp));
    const timeSpanHours = (Date.now() - firstTimestamp) / (60 * 60 * 1000);

    if (timeSpanHours < 0.1) {
      // Less than 6 minutes of data
      return { tokensPerHour: 0, confidence: 0.1 };
    }

    const tokensPerHour = totalTokens / timeSpanHours;

    // Confidence based on data points and time span
    const dataPointConfidence = Math.min(1, records.length / 10);
    const timeSpanConfidence = Math.min(1, timeSpanHours / 6);
    const confidence = (dataPointConfidence + timeSpanConfidence) / 2;

    return { tokensPerHour, confidence };
  }

  /**
   * Determine usage trend
   */
  private getUsageTrend(
    provider: string
  ): "increasing" | "stable" | "decreasing" {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;

    // Compare last 4 hours to previous 4 hours
    const recentRecords = this.state.usageHistory.filter(
      (r) =>
        r.provider === provider &&
        r.timestamp >= now - 4 * hourMs &&
        r.timestamp < now
    );

    const olderRecords = this.state.usageHistory.filter(
      (r) =>
        r.provider === provider &&
        r.timestamp >= now - 8 * hourMs &&
        r.timestamp < now - 4 * hourMs
    );

    if (recentRecords.length < 3 || olderRecords.length < 3) {
      return "stable";
    }

    const recentTotal = recentRecords.reduce(
      (sum, r) => sum + r.tokensIn + r.tokensOut,
      0
    );
    const olderTotal = olderRecords.reduce(
      (sum, r) => sum + r.tokensIn + r.tokensOut,
      0
    );

    if (olderTotal === 0) return "stable";

    const ratio = recentTotal / olderTotal;

    if (ratio > 1.3) return "increasing";
    if (ratio < 0.7) return "decreasing";
    return "stable";
  }

  /**
   * Estimate tokens needed until next reset
   */
  estimateTokensUntilReset(provider: string): number {
    const quota = this.state.quotas[provider];
    if (!quota || quota.nextReset === 0) return 0;

    const hoursUntilReset = (quota.nextReset - Date.now()) / (60 * 60 * 1000);
    if (hoursUntilReset <= 0) return 0;

    const rate = this.calculateUsageRate(provider);
    return rate.tokensPerHour * hoursUntilReset;
  }

  /**
   * Get recommendation for a provider
   */
  getRecommendation(provider: string): string {
    const prediction = this.predict(provider);
    return prediction.recommendation ?? "No recommendation available";
  }
}
