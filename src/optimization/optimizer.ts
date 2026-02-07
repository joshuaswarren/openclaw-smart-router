/**
 * Optimization plan generation for openclaw-smart-router
 */

import type {
  OptimizationPlan,
  OptimizationCandidate,
  OptimizationAction,
  CronJobAnalysis,
  AgentAnalysis,
  SmartRouterConfig,
  RouterState,
  JobSplitPlan,
} from "../types.js";
import { analyzeCronJobs, analyzeAgents } from "./analyzer.js";
import { log } from "../logger.js";

// =============================================================================
// Optimization Generator
// =============================================================================

export class Optimizer {
  private config: SmartRouterConfig;
  private state: RouterState;

  constructor(config: SmartRouterConfig, state: RouterState) {
    this.config = config;
    this.state = state;
  }

  /**
   * Update state reference
   */
  updateState(state: RouterState): void {
    this.state = state;
  }

  /**
   * Generate an optimization plan
   */
  generatePlan(): OptimizationPlan {
    const cronJobs = analyzeCronJobs(this.config, this.state);
    const agents = analyzeAgents(this.config, this.state);

    const candidates: OptimizationCandidate[] = [];
    const actions: OptimizationAction[] = [];

    // Process cron job candidates
    for (const job of cronJobs) {
      if (job.canDowngrade || job.canSplit) {
        const candidate = this.createCronCandidate(job);
        candidates.push(candidate);

        // Generate actions for this candidate
        const jobActions = this.generateCronActions(job);
        actions.push(...jobActions);
      }
    }

    // Process agent candidates
    for (const agent of agents) {
      if (agent.canUseCheaperDefault) {
        const candidate = this.createAgentCandidate(agent);
        candidates.push(candidate);

        // Generate actions for this candidate
        const agentActions = this.generateAgentActions(agent);
        actions.push(...agentActions);
      }
    }

    // Calculate total savings
    const totalEstimatedSavings = candidates.reduce(
      (sum, c) => sum + c.estimatedSavings,
      0
    );

    // Get affected providers
    const affectedProviders = [...new Set(
      actions.flatMap((a) => {
        const changes = a.changes as { provider?: string; from?: string; to?: string };
        return [changes.provider, changes.from, changes.to].filter(Boolean) as string[];
      })
    )];

    const plan: OptimizationPlan = {
      id: `opt-${Date.now().toString(36)}`,
      createdAt: new Date(),
      candidates,
      totalEstimatedSavings,
      affectedProviders,
      actions,
    };

    log.info(
      `generated optimization plan: ${candidates.length} candidates, ${actions.length} actions, ${totalEstimatedSavings.toFixed(0)} token savings`
    );

    return plan;
  }

  /**
   * Create a candidate from cron job analysis
   */
  private createCronCandidate(job: CronJobAnalysis): OptimizationCandidate {
    let splitPlan: JobSplitPlan | undefined;

    if (job.canSplit && job.splitOpportunities && job.splitOpportunities.length > 0) {
      splitPlan = {
        originalJob: {
          id: job.id,
          prompt: "", // Would need full prompt
          model: job.currentModel,
        },
        proposedSplits: job.splitOpportunities.map((opp, i) => ({
          name: `${job.name}-part-${i + 1}`,
          prompt: opp.description,
          model: opp.suggestedModel,
          schedule: job.schedule,
        })),
        reasoning: `Split complex job into ${job.splitOpportunities.length} simpler tasks`,
        estimatedSavings: job.estimatedSavings,
      };
    }

    return {
      type: "cron",
      id: job.id,
      name: job.name,
      currentModel: job.currentModel,
      complexity: job.promptComplexity,
      estimatedTokensPerRun: job.avgTokensPerRun,
      requiredCapabilities: job.detectedCapabilities,
      canDowngrade: job.canDowngrade,
      suggestedModel: job.suggestedModel,
      canSplit: job.canSplit,
      splitPlan,
      estimatedSavings: job.estimatedSavings,
      qualityRisk: this.assessQualityRisk(job.promptComplexity, job.successRate),
    };
  }

  /**
   * Create a candidate from agent analysis
   */
  private createAgentCandidate(agent: AgentAnalysis): OptimizationCandidate {
    return {
      type: "agent",
      id: agent.id,
      name: agent.name,
      currentModel: agent.primaryModel,
      complexity: "moderate", // Agents are generally moderate
      estimatedTokensPerRun: agent.avgSessionTokens,
      requiredCapabilities: agent.dominantTaskTypes,
      canDowngrade: agent.canUseCheaperDefault,
      suggestedModel: agent.suggestedPrimaryModel,
      canSplit: false,
      estimatedSavings: agent.avgSessionTokens * 0.2, // Estimate 20% savings
      qualityRisk: "low",
    };
  }

  /**
   * Generate actions for a cron job
   */
  private generateCronActions(job: CronJobAnalysis): OptimizationAction[] {
    const actions: OptimizationAction[] = [];

    if (job.canDowngrade && job.suggestedModel) {
      actions.push({
        type: "change_model",
        target: {
          type: "cron",
          id: job.id,
        },
        description: `Change ${job.name} from ${job.currentModel} to ${job.suggestedModel}`,
        changes: {
          from: job.currentModel,
          to: job.suggestedModel,
        },
        reversible: true,
      });
    }

    if (job.canSplit && job.splitOpportunities) {
      actions.push({
        type: "split_job",
        target: {
          type: "cron",
          id: job.id,
        },
        description: `Split ${job.name} into ${job.splitOpportunities.length} sub-jobs`,
        changes: {
          originalId: job.id,
          splits: job.splitOpportunities.map((opp) => ({
            name: opp.subtask,
            model: opp.suggestedModel,
          })),
        },
        reversible: false, // Splitting creates new jobs
      });
    }

    return actions;
  }

  /**
   * Generate actions for an agent
   */
  private generateAgentActions(agent: AgentAnalysis): OptimizationAction[] {
    const actions: OptimizationAction[] = [];

    if (agent.canUseCheaperDefault && agent.suggestedPrimaryModel) {
      actions.push({
        type: "change_model",
        target: {
          type: "agent",
          id: agent.id,
        },
        description: `Change ${agent.name} default from ${agent.primaryModel} to ${agent.suggestedPrimaryModel}`,
        changes: {
          from: agent.primaryModel,
          to: agent.suggestedPrimaryModel,
        },
        reversible: true,
      });

      // Add the old model as fallback
      if (!agent.fallbackChain.includes(agent.primaryModel)) {
        actions.push({
          type: "add_fallback",
          target: {
            type: "agent",
            id: agent.id,
          },
          description: `Add ${agent.primaryModel} as fallback for ${agent.name}`,
          changes: {
            model: agent.primaryModel,
            position: 0,
          },
          reversible: true,
        });
      }
    }

    return actions;
  }

  /**
   * Assess quality risk for a downgrade
   */
  private assessQualityRisk(
    complexity: "simple" | "moderate" | "complex",
    successRate: number
  ): "none" | "low" | "medium" | "high" {
    if (complexity === "simple" && successRate >= 0.95) {
      return "none";
    }
    if (complexity === "simple" && successRate >= 0.85) {
      return "low";
    }
    if (complexity === "moderate" && successRate >= 0.9) {
      return "low";
    }
    if (complexity === "moderate" && successRate >= 0.8) {
      return "medium";
    }
    return "high";
  }

  /**
   * Get quick recommendations without full plan
   */
  getQuickRecommendations(): string[] {
    const recommendations: string[] = [];

    const cronJobs = analyzeCronJobs(this.config, this.state);
    const agents = analyzeAgents(this.config, this.state);

    // Count optimization opportunities
    const downgradeableJobs = cronJobs.filter((j) => j.canDowngrade);
    const splittableJobs = cronJobs.filter((j) => j.canSplit);
    const optimizableAgents = agents.filter((a) => a.canUseCheaperDefault);

    if (downgradeableJobs.length > 0) {
      recommendations.push(
        `${downgradeableJobs.length} cron job(s) can use cheaper models`
      );
    }

    if (splittableJobs.length > 0) {
      recommendations.push(
        `${splittableJobs.length} cron job(s) can be split into simpler tasks`
      );
    }

    if (optimizableAgents.length > 0) {
      recommendations.push(
        `${optimizableAgents.length} agent(s) can use cheaper default models`
      );
    }

    // Add provider-specific recommendations based on state
    for (const [provider, quota] of Object.entries(this.state.quotas)) {
      const percentUsed = quota.limit > 0 ? quota.used / quota.limit : 0;

      if (percentUsed >= this.config.criticalThreshold) {
        recommendations.push(
          `CRITICAL: ${provider} at ${(percentUsed * 100).toFixed(0)}% - shift workload now`
        );
      } else if (percentUsed >= this.config.warningThreshold) {
        recommendations.push(
          `WARNING: ${provider} at ${(percentUsed * 100).toFixed(0)}% - consider alternatives`
        );
      }
    }

    if (recommendations.length === 0) {
      recommendations.push("No optimization opportunities found");
    }

    return recommendations;
  }
}
