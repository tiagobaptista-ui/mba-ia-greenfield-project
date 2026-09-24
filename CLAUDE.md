# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md). Phases 01 (base setup) and 02 (auth, backend + frontend) are done; phases 03–07 (video upload/processing → search) are planned.

## Repository Structure

Monorepo with two subprojects, each with its **own** `CLAUDE.md` holding the detailed commands, test conventions and architecture — read the one for the subproject you are touching:

- `nestjs-project/` — Backend API (NestJS 11, TypeORM, PostgreSQL 17, Mailpit). See [nestjs-project/CLAUDE.md](nestjs-project/CLAUDE.md).
- `next-frontend/` — Frontend (Next.js 16 App Router, React 19, Tailwind 4, shadcn/ui). See [next-frontend/CLAUDE.md](next-frontend/CLAUDE.md).
- `docs/` — project plan, technical decisions, phase/task plans, diagrams.
- `scripts/` — host-side helper scripts (e.g., `sync-openapi.sh`).
- `.claude/rules/` — path-scoped rules (load automatically when editing matching files: controllers, DTOs, entities, migrations, BFF routes, tests…). `.claude/skills/` and `.claude/agents/` hold the planning pipeline.

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → strict **BFF**: the browser only calls same-origin Route Handlers in `app/api/**`, which proxy server-side to the API. Streams media from Object Storage.
- **API** (Nest.js) → business rules, auth (JWT + refresh-token rotation, global `JwtAuthGuard` with `@Public()` opt-out), reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage *(planned — phase 03)*
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails *(planned)*
- **Message Queue** (TBD) → video processing job queue *(planned)*
- **Email Service** (SMTP; Mailpit in dev, UI at http://localhost:8025) → account confirmation and password recovery

### OpenAPI contract between subprojects

The backend's OpenAPI spec is the single source of truth for every wire shape on the frontend (BFF handlers, MSW fixtures, component types). When an endpoint or DTO changes, regenerate the chain in this order:

```bash
cd nestjs-project && docker compose exec nestjs-api npm run openapi:export   # writes nestjs-project/openapi.json
bash scripts/sync-openapi.sh                                                  # from repo root, on the HOST
cd next-frontend && docker compose exec next-frontend npm run openapi:types  # writes lib/api/types.gen.ts
```

Commit `nestjs-project/openapi.json`, `next-frontend/openapi.json` and `next-frontend/lib/api/types.gen.ts` together. Never hand-edit `types.gen.ts` or duplicate DTOs on the frontend.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

**Exception — the two subprojects are separate Compose stacks** (each has its own `compose.yaml`, run from inside its directory). Until they share a network, the frontend reaches the API via `API_URL=http://host.docker.internal:3000` (`next-frontend/.env.local` + `extra_hosts` in its compose).

## Commands (quick reference)

All `npm`/`npx`/`tsc` commands run **inside the container** (`docker compose exec <service> …`, from the subproject dir) — never on the host. The only host-side exceptions are Playwright (`npx playwright test` in `next-frontend/`) and `scripts/*.sh`.

| | Backend (`nestjs-project/`, service `nestjs-api`) | Frontend (`next-frontend/`, service `next-frontend`) |
|---|---|---|
| Start env | `docker compose up -d` (API + `db` + `mailpit`) | `docker compose up -d` |
| First run | `npm install` then `npm run migration:run` (synchronize is off) | `npm install` |
| Dev server | `npm run start:dev` (port 3000, run in background) | `npm run dev` (host port 3001, run in background) |
| All tests | `npm test` (unit + integration) and `npm run test:e2e` | `npm test` (Vitest) and `npx playwright test` on host |
| Single test | `npm test -- path/to/file.spec.ts` | `npm test -- path/to/file.test.ts` / `npx playwright test tests/x.e2e-spec.ts` |
| Type-check | `npx tsc --noEmit` | `npx tsc --noEmit` |
| Lint | `npm run lint` | `npm run lint` |

"Start the environment" means containers/infra only — start the dev servers only when explicitly asked. Backend integration/e2e suites share one DB and must run `--runInBand`. Playwright requires the frontend dev server started with `MSW_ENABLED=true` (details in `next-frontend/CLAUDE.md`).

## Planning Workflow (docs/)

Work is planned before it is implemented, via project skills in `.claude/skills/`:

- `/research` → `docs/decisions/technical-decisions-*.md` (TDs with options; the user decides). `/decide` triages free-text decision changes against existing TDs.
- `/screen-inventory` (frontend) → `docs/inventories/`, mapping Figma screens to capabilities.
- Plan pipeline `plan-context → plan-validate → plan-resolve → plan-build → plan-test-specs` → `docs/phases/phase-NN-{slug}/` (for a project-plan phase) or `docs/tasks/task-{slug}/` (ad-hoc task). Each folder holds `context.md`, the plan (`phase-NN-{slug}.md` / `task-{slug}.md`, split into SIs), `progress.md` and `validation.md`.
- `/implement` executes a plan SI by SI, running the relevant tests after each.

When a plan exists for the work at hand, follow it and update its `progress.md`. The design system source is `FC Tube.fig` at the repo root; frontend tokens derive from it into `next-frontend/app/globals.css`.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.
