# Contributing to RealtimeClaw

Thanks for your interest in contributing!

## Quick Start

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USER/RealtimeClaw.git`
3. Install dependencies: `npm install`
4. Run tests: `npm test`
5. Create a feature branch: `git checkout -b feat/my-feature`

## Development

```bash
npm run dev          # run with hot reload
npm test             # run all 251 tests
npm run build        # compile TypeScript
npm run typecheck    # type-check without emitting
npm run lint         # lint src/ and tests/
```

## Code Style

- TypeScript strict mode, ESM modules
- Named exports, no default exports
- Structured logging with `[Component]` prefixes: `[Wyoming]`, `[Realtime]`, `[Bridge]`
- Error handling via EventEmitter, never swallow silently

## Commit Format

```
<type>: <description>
```

Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `ci`

## Pull Requests

- One concern per PR
- All tests must pass (`npm test`)
- TypeScript must compile (`npm run typecheck`)
- Include tests for new functionality

## Reporting Issues

- Use [GitHub Issues](https://github.com/visterion/RealtimeClaw/issues)
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)
