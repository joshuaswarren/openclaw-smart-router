/**
 * Local model server detection
 *
 * Auto-detects MLX, Ollama, vLLM, LM Studio, and generic OpenAI-compatible servers
 */

import type { LocalModelType } from "../../types.js";
import { log } from "../../logger.js";

// =============================================================================
// Detection Configuration
// =============================================================================

interface LocalServerConfig {
  type: LocalModelType;
  defaultPort: number;
  healthEndpoint: string;
  modelsEndpoint: string;
  detectFn: (response: unknown) => boolean;
}

const LOCAL_SERVERS: LocalServerConfig[] = [
  {
    type: "ollama",
    defaultPort: 11434,
    healthEndpoint: "/",
    modelsEndpoint: "/api/tags",
    detectFn: (resp) => {
      // Ollama returns "Ollama is running" on /
      return typeof resp === "string" && resp.includes("Ollama");
    },
  },
  {
    type: "mlx",
    defaultPort: 8080,
    healthEndpoint: "/v1/models",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => {
      // MLX-LM server returns OpenAI-compatible format
      return (
        typeof resp === "object" &&
        resp !== null &&
        "data" in resp &&
        Array.isArray((resp as { data: unknown[] }).data)
      );
    },
  },
  {
    type: "lmstudio",
    defaultPort: 1234,
    healthEndpoint: "/v1/models",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => {
      // LM Studio also uses OpenAI-compatible format
      return (
        typeof resp === "object" &&
        resp !== null &&
        "data" in resp &&
        Array.isArray((resp as { data: unknown[] }).data)
      );
    },
  },
  {
    type: "vllm",
    defaultPort: 8000,
    healthEndpoint: "/health",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => {
      // vLLM health endpoint returns empty or simple status
      return resp === "" || (typeof resp === "object" && resp !== null);
    },
  },
];

// =============================================================================
// Detection Results
// =============================================================================

export interface DetectedLocalServer {
  type: LocalModelType;
  endpoint: string;
  models: string[];
  healthy: boolean;
}

// =============================================================================
// Detection Functions
// =============================================================================

/**
 * Try to fetch with a short timeout
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number = 2000
): Promise<{ ok: boolean; data: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { ok: false, data: null };
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return { ok: true, data: await response.json() };
    } else {
      return { ok: true, data: await response.text() };
    }
  } catch {
    clearTimeout(timeout);
    return { ok: false, data: null };
  }
}

/**
 * Extract model IDs from various response formats
 */
function extractModelIds(type: LocalModelType, data: unknown): string[] {
  if (!data || typeof data !== "object") return [];

  // OpenAI-compatible format (MLX, LM Studio, vLLM)
  if ("data" in data && Array.isArray((data as { data: unknown[] }).data)) {
    const models = (data as { data: Array<{ id?: string }> }).data;
    return models.map((m) => m.id).filter((id): id is string => typeof id === "string");
  }

  // Ollama format
  if ("models" in data && Array.isArray((data as { models: unknown[] }).models)) {
    const models = (data as { models: Array<{ name?: string }> }).models;
    return models.map((m) => m.name).filter((name): name is string => typeof name === "string");
  }

  return [];
}

/**
 * Check if a specific server type is running at an endpoint
 */
async function checkServer(
  config: LocalServerConfig,
  host: string = "localhost"
): Promise<DetectedLocalServer | null> {
  const baseUrl = `http://${host}:${config.defaultPort}`;

  // Check health
  const healthResult = await fetchWithTimeout(`${baseUrl}${config.healthEndpoint}`);
  if (!healthResult.ok) {
    return null;
  }

  // Verify it's the expected type
  if (!config.detectFn(healthResult.data)) {
    return null;
  }

  // Get models
  let models: string[] = [];
  if (config.modelsEndpoint !== config.healthEndpoint) {
    const modelsResult = await fetchWithTimeout(`${baseUrl}${config.modelsEndpoint}`);
    if (modelsResult.ok) {
      models = extractModelIds(config.type, modelsResult.data);
    }
  } else {
    models = extractModelIds(config.type, healthResult.data);
  }

  return {
    type: config.type,
    endpoint: baseUrl,
    models,
    healthy: true,
  };
}

/**
 * Check a custom endpoint for an OpenAI-compatible server
 */
async function checkCustomEndpoint(
  endpoint: string
): Promise<DetectedLocalServer | null> {
  const modelsUrl = endpoint.endsWith("/")
    ? `${endpoint}v1/models`
    : `${endpoint}/v1/models`;

  const result = await fetchWithTimeout(modelsUrl);
  if (!result.ok) {
    return null;
  }

  const models = extractModelIds("generic", result.data);
  if (models.length === 0) {
    return null;
  }

  return {
    type: "generic",
    endpoint,
    models,
    healthy: true,
  };
}

/**
 * Detect all running local model servers
 */
export async function detectLocalServers(
  customEndpoints: string[] = []
): Promise<DetectedLocalServer[]> {
  log.debug("detecting local model servers...");

  const results: DetectedLocalServer[] = [];

  // Check known server types in parallel
  const checks = LOCAL_SERVERS.map((config) => checkServer(config));
  const knownResults = await Promise.all(checks);

  for (const result of knownResults) {
    if (result) {
      log.info(`detected ${result.type} at ${result.endpoint} with ${result.models.length} models`);
      results.push(result);
    }
  }

  // Check custom endpoints
  for (const endpoint of customEndpoints) {
    const result = await checkCustomEndpoint(endpoint);
    if (result) {
      log.info(`detected generic server at ${endpoint} with ${result.models.length} models`);
      results.push(result);
    }
  }

  log.debug(`detected ${results.length} local server(s)`);
  return results;
}

/**
 * Check if a specific local server is healthy
 */
export async function checkLocalServerHealth(
  endpoint: string,
  type: LocalModelType
): Promise<boolean> {
  const config = LOCAL_SERVERS.find((c) => c.type === type);
  if (!config) {
    // Try generic health check
    const result = await fetchWithTimeout(`${endpoint}/v1/models`);
    return result.ok;
  }

  const result = await fetchWithTimeout(`${endpoint}${config.healthEndpoint}`);
  return result.ok && config.detectFn(result.data);
}

/**
 * Refresh model list from a local server
 */
export async function refreshLocalModels(
  endpoint: string,
  type: LocalModelType
): Promise<string[]> {
  const config = LOCAL_SERVERS.find((c) => c.type === type);
  const modelsPath = config?.modelsEndpoint ?? "/v1/models";

  const url = endpoint.endsWith("/")
    ? `${endpoint.slice(0, -1)}${modelsPath}`
    : `${endpoint}${modelsPath}`;

  const result = await fetchWithTimeout(url);
  if (!result.ok) {
    return [];
  }

  return extractModelIds(type, result.data);
}
