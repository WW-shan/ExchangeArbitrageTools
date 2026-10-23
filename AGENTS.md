# Repository Guidelines

ExchangeArbitrageTools is an early-stage repository. This checkout contains no source files, tests, assets, or Git metadata, so no build system or historical conventions can be inferred. Update this guide when project tooling is added.

## Project Structure & Module Organization

- Place code in `src/`, tests in `tests/`, runtime assets in `assets/`, and developer utilities in `scripts/`.
- Group exchange adapters under `src/exchanges/<exchange_name>/`; keep shared models and arbitrage logic in `src/core/`.
- Keep configuration at the root. Never commit credentials, databases, logs, or account data.

## Build, Test, and Development Commands

No build, test, or run commands are defined. When adding them, document runtime versions and exact commands here:

- `./scripts/dev.ps1` - start local development on Windows.
- `./scripts/test.ps1` - run the full automated test suite.
- `./scripts/lint.ps1` - run formatting and static-analysis checks.

Ensure scripts fail fast with meaningful exit codes.

## Coding Style & Naming Conventions

- Use the committed formatter and linter; avoid unrelated formatting changes.
- Use lowercase `snake_case` for exchange identifiers and `UPPER_SNAKE_CASE` for environment variables.
- Prefer small, typed functions. Isolate exchange parsing and I/O from arbitrage calculations.
- Keep timestamps in UTC and use decimal-safe types for monetary values, never binary floating point.

## Testing Guidelines

- No test framework or coverage target is configured. Add tests with the first implementation.
- Mirror `src/` paths in `tests/` and name tests for observable behavior, such as `test_detects_negative_spread`.
- Unit-test fee, precision, and spread calculations; mock exchange APIs in integration tests. Never call live trading endpoints.
- Run the full suite before each pull request.

## Commit & Pull Request Guidelines

- This checkout has no Git history, so no repository-specific convention can be inferred. Adopt Conventional Commits: `feat: add Binance adapter`, `fix: correct fee rounding`, `docs: update setup instructions`.
- Keep commits focused. Pull requests should explain the change, list tests run, note configuration or migration impact, and link issues.
- Include screenshots only for user-facing output. Confirm secrets and account data are absent from code, logs, and fixtures.

## Security & Configuration

- Commit a `.env.example` with placeholders; keep `.env` untracked.
- Restrict API keys to minimum permissions. Rate-limit requests, validate order parameters, and log redacted identifiers.
