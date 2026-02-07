/**
 * openclaw-smart-router type definitions
 */

// =============================================================================
// Reset Schedule Types
// =============================================================================

export type ResetScheduleType = "daily" | "weekly" | "monthly" | "fixed";

export interface ResetSchedule {
  type: ResetScheduleType;
  dayOfWeek?: number;      // 0-6 for weekly
  dayOfMonth?: number;     // 1-31 for monthly
  fixedDate?: string;      // ISO date for fixed
  hour?: number;           // 0-23
  timezone?: string;       // e.g., "America/Chicago"
}

// =============================================================================
// Provider Configuration
// =============================================================================

export type QuotaSource = "api" | "manual" | "unlimited";
export type QuotaType = "tokens" | "requests";
export type ProviderTier = "premium" | "standard" | "budget" | "free" | "local";
export type LocalModelType = "mlx" | "ollama" | "vllm" | "lmstudio" | "generic";
export type CapabilitySource = "huggingface" | "manual" | "infer";

export interface BudgetConfig {
  monthlyLimit: number;
  alertThreshold?: number;
  currentSpend?: number;
}

export interface LocalConfig {
  type: LocalModelType;
  endpoint: string;
  models: string[];
}

export interface CapabilityConfig {
  source: CapabilitySource;
  scores?: Record<string, number>;
}

export interface ProviderConfig {
  quotaSource: QuotaSource;
  limit?: number;
  quotaType?: QuotaType;
  resetSchedule?: ResetSchedule;
  budget?: BudgetConfig;
  capabilities?: CapabilityConfig;
  local?: LocalConfig;
  tier?: ProviderTier;
  priority?: number;
}

// =============================================================================
// Quality Thresholds
// =============================================================================

export interface QualityThresholds {
  coding: number;
  reasoning: number;
  creative: number;
  simple: number;
}

// =============================================================================
// Plugin Configuration
// =============================================================================

export type OperationMode = "manual" | "dry-run" | "auto";
export type LocalModelPreference = "never" | "simple-only" | "when-available" | "prefer";

export interface SmartRouterConfig {
  mode: OperationMode;
  debug: boolean;
  providers: Record<string, ProviderConfig>;
  qualityThresholds: QualityThresholds;
  predictionHorizonHours: number;
  warningThreshold: number;
  criticalThreshold: number;
  optimizationIntervalMinutes: number;
  localModelPreference: LocalModelPreference;
  stateFile: string;
}

// =============================================================================
// Quota Tracking
// =============================================================================

export interface QuotaInfo {
  provider: string;
  quotaType: QuotaType;
  limit: number;
  used: number;
  remaining: number;
  percentUsed: number;
  resetAt?: Date;
  lastUpdated: Date;
}

export interface BudgetInfo {
  provider: string;
  monthlyLimit: number;
  currentSpend: number;
  remaining: number;
  percentUsed: number;
  projectedMonthlySpend?: number;
  lastUpdated: Date;
}

export interface UsageRecord {
  timestamp: number;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost?: number;
  source: "cron" | "agent" | "interactive";
  sourceId?: string;
}

// =============================================================================
// Prediction
// =============================================================================

export interface ExhaustionPrediction {
  provider: string;
  willExhaust: boolean;
  predictedExhaustionTime?: Date;
  hoursUntilExhaustion?: number;
  confidence: number;
  trend: "increasing" | "stable" | "decreasing";
  recommendation?: string;
}

// =============================================================================
// Capability Scoring
// =============================================================================

export type TaskCapability = "coding" | "reasoning" | "creative" | "instruction" | "context" | "speed";

export interface ModelCapabilities {
  modelId: string;
  provider: string;
  scores: Record<TaskCapability, number>;
  contextWindow: number;
  maxTokens: number;
  latencyClass: "fast" | "medium" | "slow";
  source: CapabilitySource;
  lastUpdated: Date;
}

export interface TaskProfile {
  primaryCapability: TaskCapability;
  secondaryCapabilities?: TaskCapability[];
  contextLength: "short" | "medium" | "long";
  latencySensitive: boolean;
  qualityThreshold: number;
}

// =============================================================================
// Analysis
// =============================================================================

export interface CronJobAnalysis {
  id: string;
  name: string;
  schedule: string;
  currentModel: string;
  promptLength: number;
  promptComplexity: "simple" | "moderate" | "complex";
  detectedCapabilities: TaskCapability[];
  toolsUsed: string[];
  avgTokensPerRun: number;
  avgDurationMs: number;
  successRate: number;
  lastRunAt?: number;
  runFrequency: number;
  dailyTokenCost: number;
  monthlyProjectedCost: number;
  currentProviderShare: number;
  canDowngrade: boolean;
  downgradeReason?: string;
  suggestedModel?: string;
  estimatedSavings: number;
  canSplit: boolean;
  splitOpportunities?: SplitOpportunity[];
}

export interface SplitOpportunity {
  subtask: string;
  description: string;
  suggestedModel: string;
  complexity: "simple" | "moderate" | "complex";
  estimatedTokens: number;
}

export interface AgentAnalysis {
  id: string;
  name: string;
  isDefault: boolean;
  primaryModel: string;
  fallbackChain: string[];
  activeSessionCount: number;
  avgSessionTokens: number;
  dominantTaskTypes: TaskCapability[];
  availableProviders: string[];
  providersInCooldown: string[];
  canUseCheaperDefault: boolean;
  suggestedPrimaryModel?: string;
  suggestedFallbacks?: string[];
  reasoning: string;
}

export interface SessionAnalysis {
  sessionKey: string;
  sessionType: "cron" | "discord" | "slack" | "telegram" | "interactive";
  source: {
    type: string;
    channelId?: string;
    jobId?: string;
    guildName?: string;
  };
  messageCount: number;
  totalTokensUsed: number;
  avgTokensPerTurn: number;
  modelsUsed: string[];
  currentModel: string;
  isInteractive: boolean;
  canRouteToLocal: boolean;
  suggestedModel?: string;
}

// =============================================================================
// Optimization
// =============================================================================

export interface OptimizationCandidate {
  type: "cron" | "agent";
  id: string;
  name: string;
  currentModel: string;
  complexity: "simple" | "moderate" | "complex";
  estimatedTokensPerRun: number;
  requiredCapabilities: TaskCapability[];
  canDowngrade: boolean;
  suggestedModel?: string;
  canSplit: boolean;
  splitPlan?: JobSplitPlan;
  estimatedSavings: number;
  qualityRisk: "none" | "low" | "medium" | "high";
}

export interface JobSplitPlan {
  originalJob: {
    id: string;
    prompt: string;
    model: string;
  };
  proposedSplits: Array<{
    name: string;
    prompt: string;
    model: string;
    schedule: string;
    dependsOn?: string;
  }>;
  reasoning: string;
  estimatedSavings: number;
}

export interface OptimizationPlan {
  id: string;
  createdAt: Date;
  candidates: OptimizationCandidate[];
  totalEstimatedSavings: number;
  affectedProviders: string[];
  actions: OptimizationAction[];
}

export type OptimizationActionType =
  | "change_model"
  | "add_fallback"
  | "remove_fallback"
  | "split_job"
  | "merge_jobs"
  | "route_to_local";

export interface OptimizationAction {
  type: OptimizationActionType;
  target: {
    type: "cron" | "agent" | "config";
    id: string;
  };
  description: string;
  changes: Record<string, unknown>;
  reversible: boolean;
}

// =============================================================================
// Routing
// =============================================================================

export interface RoutingDecision {
  originalModel: string;
  selectedModel: string;
  selectedProvider: string;
  reason: string;
  alternatives: Array<{
    model: string;
    provider: string;
    score: number;
    reason: string;
  }>;
  quotaImpact: {
    provider: string;
    tokensEstimate: number;
    newUsagePercent: number;
  };
}

// =============================================================================
// Persistent State
// =============================================================================

export interface RouterState {
  version: number;
  lastUpdated: number;

  // Quota tracking
  quotas: Record<string, {
    used: number;
    limit: number;
    lastReset: number;
    nextReset: number;
  }>;

  // Budget tracking
  budgets: Record<string, {
    currentSpend: number;
    monthStart: number;
  }>;

  // Usage history (rolling window)
  usageHistory: UsageRecord[];

  // Model capabilities cache
  capabilities: Record<string, ModelCapabilities>;

  // Last optimization run
  lastOptimization?: {
    timestamp: number;
    planId: string;
    applied: boolean;
  };

  // Local model detection cache
  localModels?: {
    lastCheck: number;
    detected: Array<{
      type: LocalModelType;
      endpoint: string;
      models: string[];
    }>;
  };
}

// =============================================================================
// CLI / Tool Responses
// =============================================================================

export interface StatusResponse {
  mode: OperationMode;
  providers: Array<{
    id: string;
    tier: ProviderTier;
    quotaType: QuotaType;
    limit: number;
    used: number;
    percentUsed: number;
    resetAt?: string;
    status: "ok" | "warning" | "critical" | "exhausted";
  }>;
  predictions: ExhaustionPrediction[];
  localModels: {
    available: boolean;
    count: number;
    types: LocalModelType[];
  };
  lastOptimization?: {
    timestamp: string;
    savings: number;
  };
}

export interface AnalyzeResponse {
  cronJobs: CronJobAnalysis[];
  agents: AgentAnalysis[];
  sessions: SessionAnalysis[];
  recommendations: string[];
  totalPotentialSavings: number;
}

export interface OptimizeResponse {
  mode: "dry-run" | "applied";
  plan: OptimizationPlan;
  actions: Array<{
    action: OptimizationAction;
    status: "pending" | "applied" | "failed";
    error?: string;
  }>;
}
