/**
 * Fetch provider usage from OpenClaw's built-in tracking
 *
 * OpenClaw v2026.2.6 already fetches real-time quota data from:
 * - Anthropic/Claude via claude.ai/api/organizations/{orgId}/usage
 * - OpenAI Codex via chatgpt.com/backend-api/wham/usage
 * - Copilot, Gemini, Z.ai, MiniMax
 *
 * This utility parses the output of `openclaw models` to get this data.
 */

import { execSync } from "child_process";
import { log } from "../../logger.js";

export interface UsageWindow {
  label: string;           // "5h", "Day", "Week"
  usedPercent: number;     // 0-100
  resetAtMs?: number;      // Unix timestamp
  remainingText?: string;  // "1h 23m"
}

export interface ProviderUsage {
  provider: string;
  windows: UsageWindow[];
  error?: string;
}

/**
 * Parse usage data from `openclaw models` output
 *
 * Example line:
 * - openai-codex usage: 5h 96% left ⏱1h 23m · Day 8% left ⏱2d 2h
 *
 * Returns parsed usage windows for known providers
 */
export function parseModelsOutput(output: string): ProviderUsage[] {
  const results: ProviderUsage[] = [];

  // Match lines like: "- openai-codex usage: 5h 96% left ⏱1h 23m · Day 8% left"
  const usageRegex = /^-\s+(\S+)\s+usage:\s*(.+)$/gm;

  let match;
  while ((match = usageRegex.exec(output)) !== null) {
    const provider = match[1];
    const usageStr = match[2];

    const windows: UsageWindow[] = [];

    // Split by · and parse each window
    const windowParts = usageStr.split("·").map((s) => s.trim());

    for (const part of windowParts) {
      // Parse "5h 96% left ⏱1h 23m" or "Day 8% left ⏱2d 2h"
      const windowMatch = part.match(
        /^(\w+)\s+(\d+(?:\.\d+)?)\s*%\s*left(?:\s*⏱(.+))?$/
      );

      if (windowMatch) {
        const label = windowMatch[1];
        const leftPercent = parseFloat(windowMatch[2]);
        const remainingText = windowMatch[3]?.trim();

        windows.push({
          label,
          usedPercent: 100 - leftPercent,
          remainingText,
        });
      }
    }

    if (windows.length > 0) {
      results.push({ provider, windows });
    }
  }

  return results;
}

/**
 * Fetch usage from OpenClaw's built-in tracking
 *
 * Runs `openclaw models` and parses the output
 */
export async function fetchOpenClawUsage(): Promise<ProviderUsage[]> {
  try {
    // Run openclaw models and capture output
    // Note: This runs synchronously for simplicity
    const output = execSync("openclaw models 2>/dev/null", {
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, NO_COLOR: "1" },
    });

    const usage = parseModelsOutput(output);
    log.debug(`fetched usage for ${usage.length} providers from OpenClaw`);
    return usage;
  } catch (err) {
    log.debug("failed to fetch OpenClaw usage", err);
    return [];
  }
}

/**
 * Get usage for a specific provider
 */
export async function getProviderUsage(
  providerId: string
): Promise<ProviderUsage | null> {
  const all = await fetchOpenClawUsage();
  return all.find((u) => u.provider === providerId) ?? null;
}
