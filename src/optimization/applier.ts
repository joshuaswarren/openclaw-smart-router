/**
 * Optimization action applier for openclaw-smart-router
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type {
  OptimizationPlan,
  OptimizationAction,
  SmartRouterConfig,
} from "../types.js";
import { getCronJobsPath, getAgentsDir } from "../config.js";
import { log } from "../logger.js";

// =============================================================================
// Action Results
// =============================================================================

export interface ActionResult {
  action: OptimizationAction;
  status: "applied" | "failed" | "skipped";
  error?: string;
  rollbackInfo?: unknown;
}

// =============================================================================
// Action Applier
// =============================================================================

export class ActionApplier {
  private config: SmartRouterConfig;
  private dryRun: boolean;

  constructor(config: SmartRouterConfig, dryRun: boolean = true) {
    this.config = config;
    this.dryRun = dryRun;
  }

  /**
   * Apply all actions in a plan
   */
  async applyPlan(plan: OptimizationPlan): Promise<ActionResult[]> {
    const results: ActionResult[] = [];

    for (const action of plan.actions) {
      const result = await this.applyAction(action);
      results.push(result);

      // Stop on first failure if not in dry-run mode
      if (!this.dryRun && result.status === "failed") {
        log.error(`action failed, stopping: ${result.error}`);
        break;
      }
    }

    return results;
  }

  /**
   * Apply a single action
   */
  async applyAction(action: OptimizationAction): Promise<ActionResult> {
    try {
      switch (action.type) {
        case "change_model":
          return await this.applyChangeModel(action);
        case "add_fallback":
          return await this.applyAddFallback(action);
        case "remove_fallback":
          return await this.applyRemoveFallback(action);
        case "split_job":
          return await this.applySplitJob(action);
        case "route_to_local":
          return await this.applyRouteToLocal(action);
        default:
          return {
            action,
            status: "skipped",
            error: `Unknown action type: ${action.type}`,
          };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        action,
        status: "failed",
        error,
      };
    }
  }

  /**
   * Apply a model change action
   */
  private async applyChangeModel(action: OptimizationAction): Promise<ActionResult> {
    const { target, changes } = action;
    const { from, to } = changes as { from: string; to: string };

    if (target.type === "cron") {
      return await this.changeCronModel(target.id, from, to);
    } else if (target.type === "agent") {
      return await this.changeAgentModel(target.id, from, to);
    }

    return {
      action,
      status: "skipped",
      error: `Unknown target type: ${target.type}`,
    };
  }

  /**
   * Change model for a cron job
   */
  private async changeCronModel(
    jobId: string,
    from: string,
    to: string
  ): Promise<ActionResult> {
    const path = getCronJobsPath();

    if (!existsSync(path)) {
      return {
        action: { type: "change_model", target: { type: "cron", id: jobId }, description: "", changes: {}, reversible: true },
        status: "failed",
        error: "Cron jobs file not found",
      };
    }

    if (this.dryRun) {
      log.info(`[DRY-RUN] Would change ${jobId} model from ${from} to ${to}`);
      return {
        action: { type: "change_model", target: { type: "cron", id: jobId }, description: "", changes: { from, to }, reversible: true },
        status: "applied",
        rollbackInfo: { from, to },
      };
    }

    try {
      const content = readFileSync(path, "utf-8");
      const jobs = JSON.parse(content);

      // Find and update the job
      let found = false;

      if (Array.isArray(jobs)) {
        const job = jobs.find((j: { id: string }) => j.id === jobId);
        if (job) {
          job.model = to;
          found = true;
        }
      } else if (jobs.jobs && Array.isArray(jobs.jobs)) {
        const job = jobs.jobs.find((j: { id: string }) => j.id === jobId);
        if (job) {
          job.model = to;
          found = true;
        }
      } else if (jobs[jobId]) {
        jobs[jobId].model = to;
        found = true;
      }

      if (!found) {
        return {
          action: { type: "change_model", target: { type: "cron", id: jobId }, description: "", changes: { from, to }, reversible: true },
          status: "failed",
          error: `Job not found: ${jobId}`,
        };
      }

      writeFileSync(path, JSON.stringify(jobs, null, 2));
      log.info(`changed ${jobId} model from ${from} to ${to}`);

      return {
        action: { type: "change_model", target: { type: "cron", id: jobId }, description: "", changes: { from, to }, reversible: true },
        status: "applied",
        rollbackInfo: { from, to },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        action: { type: "change_model", target: { type: "cron", id: jobId }, description: "", changes: { from, to }, reversible: true },
        status: "failed",
        error,
      };
    }
  }

  /**
   * Change model for an agent
   */
  private async changeAgentModel(
    agentId: string,
    from: string,
    to: string
  ): Promise<ActionResult> {
    const modelsPath = join(getAgentsDir(), agentId, "agent", "models.json");

    if (!existsSync(modelsPath)) {
      return {
        action: { type: "change_model", target: { type: "agent", id: agentId }, description: "", changes: { from, to }, reversible: true },
        status: "failed",
        error: `Agent models file not found: ${modelsPath}`,
      };
    }

    if (this.dryRun) {
      log.info(`[DRY-RUN] Would change ${agentId} model from ${from} to ${to}`);
      return {
        action: { type: "change_model", target: { type: "agent", id: agentId }, description: "", changes: { from, to }, reversible: true },
        status: "applied",
        rollbackInfo: { from, to },
      };
    }

    try {
      const content = readFileSync(modelsPath, "utf-8");
      const models = JSON.parse(content);

      models.primary = to;
      // Add old model as first fallback if not already there
      if (!models.fallbacks) {
        models.fallbacks = [];
      }
      if (!models.fallbacks.includes(from)) {
        models.fallbacks.unshift(from);
      }

      writeFileSync(modelsPath, JSON.stringify(models, null, 2));
      log.info(`changed ${agentId} model from ${from} to ${to}`);

      return {
        action: { type: "change_model", target: { type: "agent", id: agentId }, description: "", changes: { from, to }, reversible: true },
        status: "applied",
        rollbackInfo: { from, to },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        action: { type: "change_model", target: { type: "agent", id: agentId }, description: "", changes: { from, to }, reversible: true },
        status: "failed",
        error,
      };
    }
  }

  /**
   * Add a fallback model
   */
  private async applyAddFallback(action: OptimizationAction): Promise<ActionResult> {
    const { target, changes } = action;
    const { model, position } = changes as { model: string; position: number };

    if (target.type !== "agent") {
      return {
        action,
        status: "skipped",
        error: "Add fallback only supported for agents",
      };
    }

    const modelsPath = join(getAgentsDir(), target.id, "agent", "models.json");

    if (!existsSync(modelsPath)) {
      return { action, status: "failed", error: "Models file not found" };
    }

    if (this.dryRun) {
      log.info(`[DRY-RUN] Would add ${model} as fallback for ${target.id}`);
      return { action, status: "applied" };
    }

    try {
      const content = readFileSync(modelsPath, "utf-8");
      const models = JSON.parse(content);

      if (!models.fallbacks) {
        models.fallbacks = [];
      }

      if (!models.fallbacks.includes(model)) {
        models.fallbacks.splice(position ?? 0, 0, model);
        writeFileSync(modelsPath, JSON.stringify(models, null, 2));
        log.info(`added ${model} as fallback for ${target.id}`);
      }

      return { action, status: "applied" };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { action, status: "failed", error };
    }
  }

  /**
   * Remove a fallback model
   */
  private async applyRemoveFallback(action: OptimizationAction): Promise<ActionResult> {
    const { target, changes } = action;
    const { model } = changes as { model: string };

    if (target.type !== "agent") {
      return { action, status: "skipped", error: "Remove fallback only for agents" };
    }

    const modelsPath = join(getAgentsDir(), target.id, "agent", "models.json");

    if (this.dryRun) {
      log.info(`[DRY-RUN] Would remove ${model} from ${target.id} fallbacks`);
      return { action, status: "applied" };
    }

    try {
      const content = readFileSync(modelsPath, "utf-8");
      const models = JSON.parse(content);

      if (models.fallbacks) {
        models.fallbacks = models.fallbacks.filter((f: string) => f !== model);
        writeFileSync(modelsPath, JSON.stringify(models, null, 2));
        log.info(`removed ${model} from ${target.id} fallbacks`);
      }

      return { action, status: "applied" };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { action, status: "failed", error };
    }
  }

  /**
   * Split a cron job into multiple smaller jobs
   */
  private async applySplitJob(action: OptimizationAction): Promise<ActionResult> {
    // Job splitting is complex and potentially destructive
    // For now, just log what would be done
    const { target, changes } = action;
    const { splits } = changes as { originalId: string; splits: Array<{ name: string; model: string }> };

    if (this.dryRun) {
      log.info(`[DRY-RUN] Would split ${target.id} into ${splits.length} sub-jobs:`);
      for (const split of splits) {
        log.info(`  - ${split.name} (${split.model})`);
      }
      return { action, status: "applied" };
    }

    // TODO: Implement actual job splitting
    // This would involve:
    // 1. Creating new job entries in jobs.json
    // 2. Potentially creating dependencies between them
    // 3. Disabling the original job

    return {
      action,
      status: "skipped",
      error: "Job splitting not yet implemented - manual intervention required",
    };
  }

  /**
   * Route a job to local model
   */
  private async applyRouteToLocal(action: OptimizationAction): Promise<ActionResult> {
    const { target, changes } = action;
    const { localModel } = changes as { localModel: string };

    // Route to local is similar to change_model, but specifically for local models
    return await this.changeCronModel(target.id, "current", localModel);
  }

  /**
   * Rollback an applied action
   */
  async rollback(result: ActionResult): Promise<boolean> {
    if (result.status !== "applied" || !result.rollbackInfo || !result.action.reversible) {
      return false;
    }

    const { action, rollbackInfo } = result;
    const { from, to } = rollbackInfo as { from: string; to: string };

    // Swap from/to to rollback
    const rollbackAction: OptimizationAction = {
      ...action,
      changes: { from: to, to: from },
    };

    const savedDryRun = this.dryRun;
    this.dryRun = false;

    try {
      const rollbackResult = await this.applyAction(rollbackAction);
      return rollbackResult.status === "applied";
    } finally {
      this.dryRun = savedDryRun;
    }
  }
}
