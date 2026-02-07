# openclaw-smart-router

[![npm version](https://badge.fury.io/js/openclaw-smart-router.svg)](https://badge.fury.io/js/openclaw-smart-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Intelligent model routing for OpenClaw with quota prediction, task classification, and automatic optimization.

## What It Does

**Smart Router** helps you get the most out of your LLM quotas by:

- **Predicting exhaustion** - Know when you'll run out of tokens before it happens
- **Analyzing workloads** - Identify which cron jobs and agents can use cheaper models
- **Automatic optimization** - Shift workloads to appropriate models based on task complexity
- **Local model support** - Route simple tasks to MLX, Ollama, or other local servers
- **Budget tracking** - Monitor spend on pay-per-token providers like OpenRouter

## Quick Start

### 1. Install

```bash
cd ~/.openclaw/extensions
git clone https://github.com/joshuaswarren/openclaw-smart-router.git
cd openclaw-smart-router
npm install && npm run build
```

### 2. Enable in openclaw.json

```json
{
  "plugins": {
    "openclaw-smart-router": {
      "mode": "dry-run",
      "providers": {
        "anthropic": {
          "quotaSource": "manual",
          "limit": 100000000,
          "resetSchedule": { "type": "weekly", "dayOfWeek": 3, "hour": 7 }
        },
        "openai-codex": {
          "quotaSource": "manual",
          "limit": 50000000,
          "resetSchedule": { "type": "fixed", "fixedDate": "2026-02-09T14:36:00Z" }
        }
      }
    }
  }
}
```

### 3. Restart Gateway

```bash
kill -USR1 $(pgrep openclaw-gateway)
```

### 4. Check Status

```bash
openclaw router status
```

## Usage

### CLI Commands

```bash
# Show provider status and usage
openclaw router status [provider]

# Predict quota exhaustion
openclaw router predict [--hours=24]

# List configured providers
openclaw router providers

# Manually set usage (e.g., after checking your account)
openclaw router set-usage <provider> <percent|tokens>
# Examples:
openclaw router set-usage anthropic 79%
openclaw router set-usage openai-codex 91%

# Reset quota counter after provider reset
openclaw router reset <provider>

# Analyze crons/agents for optimization opportunities
openclaw router analyze [--type=all|crons|agents]

# Generate and optionally apply optimizations
openclaw router optimize [--apply] [--safe-only]

# Detect local model servers
openclaw router detect-local

# Get or set operation mode
openclaw router mode [manual|dry-run|auto]
```

### Conversational Interface

Chat with OpenClaw using these capabilities:

```
"What's my token usage looking like?"
→ Calls router_status tool

"When will I run out of Codex tokens?"
→ Calls router_predict tool

"Which of my cron jobs could use cheaper models?"
→ Calls router_analyze tool

"Optimize my model usage"
→ Calls router_optimize tool (with confirmation)

"Move everything off Anthropic"
→ Calls router_shift tool
```

## Operation Modes

| Mode | Behavior |
|------|----------|
| `manual` | CLI only. No automatic changes. |
| `dry-run` | Preview optimizations. Ask before applying. (Default) |
| `auto` | Automatically apply safe (reversible) optimizations. |

## Configuration Reference

```json
{
  "plugins": {
    "openclaw-smart-router": {
      // Operation mode: manual, dry-run, auto
      "mode": "dry-run",

      // Enable debug logging
      "debug": false,

      // Provider-specific configuration
      "providers": {
        "anthropic": {
          // How to track quota: api, manual, unlimited
          "quotaSource": "manual",
          // Token or request limit
          "limit": 100000000,
          // What the limit measures: tokens, requests
          "quotaType": "tokens",
          // When quota resets
          "resetSchedule": {
            "type": "weekly",    // daily, weekly, monthly, fixed
            "dayOfWeek": 3,      // 0=Sunday (for weekly)
            "hour": 7,           // Hour of reset (0-23)
            "timezone": "America/Chicago"
          },
          // Cost tier: premium, standard, budget, free, local
          "tier": "premium",
          // Priority within tier (higher = preferred)
          "priority": 100
        },
        "openrouter": {
          "quotaSource": "api",
          "budget": {
            "monthlyLimit": 10.00,
            "alertThreshold": 0.8
          },
          "tier": "budget"
        },
        "local-mlx": {
          "quotaSource": "unlimited",
          "tier": "local",
          "local": {
            "type": "mlx",
            "endpoint": "http://localhost:8080",
            "models": ["mlx-community/Llama-3.2-3B-Instruct-4bit"]
          }
        }
      },

      // Minimum quality scores by task type
      "qualityThresholds": {
        "coding": 0.8,
        "reasoning": 0.75,
        "creative": 0.6,
        "simple": 0.4
      },

      // How far ahead to predict (hours)
      "predictionHorizonHours": 24,

      // Alert thresholds (0-1)
      "warningThreshold": 0.8,
      "criticalThreshold": 0.95,

      // Auto-optimization interval (minutes)
      "optimizationIntervalMinutes": 60,

      // When to use local models: never, simple-only, when-available, prefer
      "localModelPreference": "simple-only"
    }
  }
}
```

## How It Works

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     openclaw-smart-router                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────────────────┐ │
│  │   Quota     │   │ Capability  │   │      Optimization       │ │
│  │  Tracker    │   │   Scorer    │   │        Engine           │ │
│  └─────┬───────┘   └──────┬──────┘   └───────────┬─────────────┘ │
│        │                  │                       │               │
│        ▼                  ▼                       ▼               │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   Provider Registry                          │ │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐ │ │
│  │  │Anthropic│ │ OpenAI  │ │ Google  │ │OpenRouter│ │ Local  │ │ │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └────────┘ │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                      Interface Layer                         │ │
│  │  ┌──────────────────────┐  ┌───────────────────────────────┐ │ │
│  │  │     CLI Commands     │  │     Agent Tools (Chat)        │ │ │
│  │  └──────────────────────┘  └───────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Task Classification

The plugin analyzes prompts to determine task complexity:

| Signal | Classification | Quality Threshold |
|--------|----------------|-------------------|
| Code keywords, ``` blocks | Coding | 0.8 |
| "analyze", "design", "strategy" | Reasoning | 0.75 |
| "write", "story", "creative" | Creative | 0.6 |
| "summarize", "list", "check" | Simple | 0.4 |

### Model Capability Scoring

Each model is scored on capability dimensions (0-1):

- **coding** - Code generation and debugging
- **reasoning** - Logic, math, analysis
- **creative** - Writing, brainstorming
- **instruction** - Following complex instructions
- **context** - Long context handling
- **speed** - Response latency

Default scores are provided for common models. Override with manual scores in config.

### Optimization Flow

1. **Analyze** - Scan cron jobs and agents for optimization opportunities
2. **Score** - Match task requirements to model capabilities
3. **Plan** - Generate actions (change model, add fallback, split job)
4. **Apply** - Execute changes (dry-run or live based on mode)

## Local Model Support

The plugin auto-detects these local servers:

| Server | Default Port | Detection |
|--------|--------------|-----------|
| Ollama | 11434 | `GET /` returns "Ollama" |
| MLX-LM | 8080 | OpenAI-compatible `/v1/models` |
| LM Studio | 1234 | OpenAI-compatible `/v1/models` |
| vLLM | 8000 | `/health` endpoint |

Run `openclaw router detect-local` to check what's available.

Configure `localModelPreference`:

| Value | Behavior |
|-------|----------|
| `never` | Don't use local models |
| `simple-only` | Route simple tasks (summarize, list) to local |
| `when-available` | Use local when cloud is constrained |
| `prefer` | Prefer local over cloud when capable |

## Graceful Degradation

The plugin adapts to your setup:

| Scenario | Behavior |
|----------|----------|
| No providers configured | Just monitors usage if hooks fire |
| Single provider | Warns on high usage, no shifting |
| No local models | Uses cloud free tiers first |
| No free tiers | Optimizes premium usage |
| Budget-only (OpenRouter) | Tracks spend, warns at threshold |

## Troubleshooting

### "Unknown provider" errors

Add the provider to your plugin config:

```json
"providers": {
  "my-provider": {
    "quotaSource": "manual",
    "limit": 1000000
  }
}
```

### Predictions seem off

Update manual usage to match your actual account:

```bash
openclaw router set-usage anthropic 79%
```

### Local models not detected

1. Ensure the server is running
2. Check the default port is being used
3. Run `openclaw router detect-local` for diagnostics

### Optimizations not applying

- Check you're in `dry-run` or `auto` mode
- Use `--apply` flag with optimize command
- Restart gateway after changes: `kill -USR1 $(pgrep openclaw-gateway)`

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run check-types`
5. Submit a PR

## Related Projects

- [OpenClaw](https://github.com/openclaw/openclaw) - The AI agent framework
- [openclaw-engram](https://github.com/joshuaswarren/openclaw-engram) - Memory plugin
- [openclaw-patcher](https://github.com/joshuaswarren/openclaw-patcher) - Auto-patching utility

## License

MIT
