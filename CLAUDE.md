# openclaw-smart-router

## PUBLIC REPOSITORY — Privacy Policy

**This repository is PUBLIC on GitHub.** Every commit is visible to the world.

### Rules for ALL agents committing to this repo:

1. **NEVER commit personal data** — no names, emails, addresses, phone numbers, account IDs, or user identifiers
2. **NEVER commit API keys, tokens, or secrets** — even in comments or examples
3. **NEVER commit usage data** — the `state.json` file contains user-specific quota tracking
4. **NEVER commit user configuration** — specific provider limits, budgets, or schedules are private
5. **NEVER commit `.env` files** or any file containing credentials
6. **NEVER reference specific users, their quotas, or their usage patterns** in code comments or commit messages
7. **Config examples must use placeholders** — `${OPENAI_API_KEY}`, not actual keys
8. **Test data must be synthetic** — never use real usage data in tests

### What IS safe to commit:
- Source code (`src/`)
- Package manifests (`package.json`, `tsconfig.json`, `tsup.config.ts`)
- Plugin manifest (`openclaw.plugin.json`)
- Documentation (`README.md`, `CHANGELOG.md`, `docs/`)
- Build configuration
- `.gitignore`
- This `CLAUDE.md` file

### Before every commit, verify:
- `git diff --cached` contains NO personal information
- No hardcoded API keys, URLs with tokens, or credentials
- No references to specific users or their usage data

## Architecture Notes

### File Structure
```
src/
├── index.ts              # Plugin entry point
├── config.ts             # Config parsing and defaults
├── logger.ts             # Logging wrapper
├── types.ts              # All type definitions
├── providers/
│   ├── registry.ts       # Provider registration and status
│   └── local/
│       └── detector.ts   # Local model server detection
├── quota/
│   ├── tracker.ts        # Usage tracking via hooks
│   ├── predictor.ts      # Exhaustion prediction
│   └── reset.ts          # Reset schedule handling
├── capabilities/
│   ├── scorer.ts         # Model capability scoring
│   └── matcher.ts        # Task-to-model matching
├── optimization/
│   ├── analyzer.ts       # Cron/agent analysis
│   ├── optimizer.ts      # Plan generation
│   └── applier.ts        # Action application
├── interface/
│   ├── tools.ts          # Agent tools (conversational)
│   └── cli.ts            # CLI commands
└── storage/
    └── state.ts          # Persistent state management
```

### Key Patterns

1. **State is hot** — quota and budget tracking updates frequently
2. **Config is cold** — plugin config parsed once at startup
3. **Registry is authoritative** — single source of truth for providers
4. **Scorer caches** — capability lookups are cached per session
5. **Hooks are passive** — usage tracking via llm_end events

### Integration Points

- `api.registerTool()` — conversational interface
- `api.registerCommand()` — CLI interface
- `api.on("llm_end")` — usage tracking
- `api.registerService()` — background tasks

### Testing Locally

```bash
# Build
npm run build

# Check types
npm run check-types

# Add to openclaw.json and restart
kill -USR1 $(pgrep openclaw-gateway)

# Verify
openclaw router status
```
