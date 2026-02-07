# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-07

### Added

- Initial release
- Provider registry with tier-based organization
- Quota tracking via hooks (tokens and requests)
- Budget tracking for pay-per-token providers
- Reset schedule support (daily, weekly, monthly, fixed)
- Exhaustion prediction with trend analysis
- Model capability scoring with defaults for common models
- Task classification from prompt analysis
- Task-to-model matching with quality thresholds
- Cron job analysis for optimization opportunities
- Agent analysis for default model optimization
- Job splitting detection for complex tasks
- Optimization plan generation
- Dry-run and auto-apply modes
- Local model server detection (Ollama, MLX, LM Studio, vLLM)
- CLI commands: status, predict, providers, set-usage, reset, analyze, optimize, detect-local, mode
- Conversational tools: router_status, router_predict, router_analyze, router_optimize, router_set_usage, router_shift
- Persistent state storage
- Comprehensive documentation
