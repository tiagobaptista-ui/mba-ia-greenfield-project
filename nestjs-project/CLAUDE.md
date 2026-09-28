# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, object storage, queue, video worker) — **never** start the NestJS HTTP server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app"). The `video-worker` container is part of the infrastructure: `docker compose up -d` starts it and it consumes the queue on its own (no HTTP server, no ports).

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `docker compose ps minio` — expect `healthy` (healthcheck runs `mc ready local`); `docker compose ps -a minio-init` — expect `Exited (0)` (bucket created)
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Video worker:** `docker compose logs video-worker` — expect `[VideoWorker] Consuming the video-processing queue`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (container idles until you run `npm run start:dev`)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP `1025`, UI http://localhost:8025
- `minio` — S3-compatible object storage (Chainguard image pinned by digest), API `9000`, console http://localhost:9001 (user/password = `S3_ACCESS_KEY` / `S3_SECRET_KEY` from `.env`)
- `minio-init` — one-shot job that creates the private bucket `S3_BUCKET` (`streamtube-media`) and exits
- `redis` — Redis 8 (AOF on), port `6379`, backend of the BullMQ queue
- `video-worker` — same image and code as `nestjs-api`, second entrypoint `src/main-worker.ts` (`npm run start:worker:dev`), no ports; `restart: unless-stopped`

The `video-worker` shares the bind-mounted `node_modules`, so run `npm install` in `nestjs-api` first — the worker keeps restarting until the dependencies exist.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs video-worker   # job processing: "process-video <id>: attempt n/3" → "ready" / "failed"

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Run the compiled video worker (dist/main-worker)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (the script already passes --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting

npm run openapi:export                   # Regenerate src/metadata.ts, then write openapi.json (see the root CLAUDE.md for the frontend sync chain)
npm run openapi:metadata                 # Only regenerate src/metadata.ts (Swagger CLI plugin metadata)
```

`src/metadata.ts` is **generated** (`src/swagger/generate-metadata.ts`, using the plugin options in `nest-cli.json`) and committed — never edit it by hand.
- **Why it exists:** ts-node (`openapi:export`) and ts-jest don't run the `@nestjs/swagger` CLI plugin, so `exportSpec` and `main.ts` load this file with `SwaggerModule.loadPluginMetadata` to get the same DTO schemas `nest build` produces.
- **Keeping it in sync:** after changing a DTO, run `npm run openapi:export`. `src/swagger/generate-metadata.integration-spec.ts` fails `npm test` while the file is stale.

`npm run start:worker:dev` (`nest start --watch --entryFile main-worker -p tsconfig.worker.json`) is the `video-worker` container's command — you don't run it by hand. It builds into `dist-worker/` (git-ignored) instead of `dist/`: both containers bind-mount the project and `nest-cli.json` has `deleteOutDir: true`, so sharing `dist/` would make each watcher wipe the other's build.

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Video tests use the real `minio`, `redis` and FFmpeg (installed in `Dockerfile.dev`) — nothing is mocked that the Compose stack can provide. `test/set-test-env.ts` runs before `dotenv/config` and forces `QUEUE_PREFIX=streamtube-test` (so the `video-worker` container, on prefix `streamtube`, never consumes test jobs) and `S3_PUBLIC_ENDPOINT=http://minio:9000` (so tests inside the container can follow presigned URLs). Suites that need processing register `VideoProcessor` in their own testing module (see `test/videos-playback.e2e-spec.ts`). Test clips are generated on the fly by `src/test/video-fixture.ts` (`ffmpeg -f lavfi testsrc`), and `src/test/storage.ts` / `src/test/queue.ts` hold the MinIO and queue cleanup helpers.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

The one exception is **module compilation tests**. They are named `*.module.spec.ts` (e.g. `src/videos/videos.module.spec.ts`, `src/worker/worker.module.spec.ts`) and compile the module against the real Compose services — TypeORM, Redis, MinIO — to catch DI wiring errors that TypeScript cannot. This follows the testing guide: `.claude/skills/testing-guide-nestjs-project/artifacts/modules.md`. They only resolve providers and assert nothing about data.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["<rootDir>/../test/set-test-env.ts", "dotenv/config"]` (in `test/jest-e2e.json`: `["<rootDir>/set-test-env.ts", "dotenv/config"]`) — `dotenv/config` loads `.env` inside the Jest process; without it `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS. `set-test-env.ts` must come first: dotenv never overrides a variable that is already set, which is how the test-only queue prefix and storage endpoint win over `.env`.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- Two entrypoints share the codebase: `src/main.ts` boots `AppModule` (HTTP API) and `src/main-worker.ts` boots `WorkerModule` (`src/worker/worker.module.ts`) as an application context with no HTTP server. Both import the same `rootConfigModule` (`src/config/root-config.ts`, Joi-validated env) and `rootTypeOrmModule` (`src/database/root-typeorm.ts`), so they always see the same configuration and database.
- `autoLoadEntities` only knows entities registered through some module's `TypeOrmModule.forFeature`. A root module must import every module whose entities are reachable through relations — the worker imports `UsersModule` because `Video → Channel → User`.

## Videos (Phase 03)

Upload, background processing and playback of videos up to 10 GiB. Plan, decisions and progress: `docs/phases/phase-03-videos/` and `docs/decisions/technical-decisions-phase-03-videos.md` (TD-01…TD-13).

| Module | Path | Responsibility |
|---|---|---|
| `VideosModule` | `src/videos/` | `Video` entity (`videos` table, migration `CreateVideos1790616024522`), `VideosService` (upload lifecycle, worker transitions, playback URLs), `VideosController`, 11-char base62 slug (`slug.util.ts`) |
| `StorageModule` | `src/storage/` | `StorageService` over `@aws-sdk/client-s3`: multipart upload, presigned part/GET URLs, `HeadObject`, put/delete. Two clients — internal (`S3_ENDPOINT`) and public signing (`S3_PUBLIC_ENDPOINT`) |
| `QueueModule` | `src/queue/` | BullMQ root connection (`REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`), queue `video-processing` with its job defaults, `VideoProcessingProducer` |
| `MediaModule` | `src/media/` | `FfmpegService` — `ffprobe` metadata and `ffmpeg` frame extraction via `child_process.spawn` (no npm wrapper) |
| `WorkerModule` | `src/worker/` | `VideoProcessor` (`@Processor('video-processing')`). It is registered **only** here, so the API process never consumes jobs |

### Endpoints

| Method & route | Auth | Result |
|---|---|---|
| `POST /videos` | JWT | `201` — draft pre-registered in the caller's channel and S3 multipart upload opened (`part_size_bytes`, `part_count`). Accepts `.mp4`/`.webm`/`.mov`/`.mkv` up to 10 GiB |
| `GET /videos/:id/upload/part-urls?part_numbers=1,2,…` | JWT, owner | `200` — presigned `UploadPart` URLs (≤ 100 per call). The client `PUT`s each part straight to MinIO and keeps the `ETag` |
| `POST /videos/:id/upload/complete` | JWT, owner | `202` — completes the multipart upload, checks the real size (`HeadObject`), sets `processing` and enqueues `process-video` |
| `DELETE /videos/:id/upload` | JWT, owner | `204` — aborts the multipart upload and deletes the draft |
| `GET /videos/:id` | JWT, owner | `200` — status, metadata, `has_thumbnail`, `processing_error` |
| `GET /videos/:slug/stream` | public | `302` → presigned GET of the original; MinIO answers `Range` with `206 Partial Content` |
| `GET /videos/:slug/download` | public | `302` → presigned GET with `Content-Disposition: attachment; filename="<original name>"` |
| `GET /videos/:slug/thumbnail` | public | `302` → presigned GET of the JPEG thumbnail |

Playback routes return `404 VIDEO_NOT_FOUND` for any video that is not `ready`. Other error codes (all in `src/common/exceptions/domain.exception.ts`): `VIDEO_ACCESS_DENIED` 403, `INVALID_VIDEO_STATE` 409, `UNSUPPORTED_VIDEO_FORMAT` / `VIDEO_TOO_LARGE` / `INVALID_PART_NUMBER` / `INVALID_UPLOAD_PARTS` / `UPLOAD_SIZE_MISMATCH` 400. Throttling (`src/videos/videos.constants.ts`): the global limit is 10 req/60 s; `OWNER_READ_THROTTLE` (60/60 s) covers part-urls and `GET /videos/:id`, and `PLAYBACK_THROTTLE` (120/60 s) covers the three public routes.

### Status lifecycle and processing

`draft → processing → ready | failed` (`VideoStatus` in `src/videos/entities/video.entity.ts`). This status covers only the technical upload/processing cycle; publication and visibility are Phase 04.

1. The job is `process-video` with payload `{ videoId }` and `jobId = videoId` (de-duplicated). It gets 3 attempts with exponential backoff (1 s base), set in `VIDEO_PROCESSING_JOB_OPTIONS` (`src/queue/queue.constants.ts`).
2. `VideoProcessor` skips videos that are not `processing`. Otherwise it:
   - does a `HeadObject` on the original;
   - runs `ffprobe` over a presigned **internal** GET (no local copy of the 10 GiB file) to get `duration_seconds` and `metadata` (`container`, `video_codec`, `audio_codec`, `width`, `height`, `fps`, `bitrate`);
   - extracts one frame at `min(10% of duration, 60 s)`, uploads it as `thumbnails/{id}.jpg` and moves the video to `ready`.
3. Failures:
   - Unreadable media (`InvalidMediaError`) → `failed` immediately, via `UnrecoverableError` with no retries.
   - Any other error → retried, and `failed` only on the last attempt.
   - The reason is stored in `processing_error` (≤ 500 chars, with presigned URLs redacted).
4. `markProcessed` / `markFailed` only update rows still in `processing`, so duplicate or late jobs are no-ops.

### Storage layout

A single private bucket, `S3_BUCKET` (`streamtube-media`), created by `minio-init`. Keys come from `src/storage/storage.constants.ts`: `videos/{id}/original` and `thumbnails/{id}.jpg`. Presigned URLs expire after `S3_PRESIGN_EXPIRES_SECONDS`.

**Exception to the Compose-service-name rule:**
- `S3_ENDPOINT=http://minio:9000` is used for every server-to-storage call.
- `S3_PUBLIC_ENDPOINT=http://localhost:9000` is used only to *sign* URLs handed to clients. SigV4 binds the host, so a URL signed for `minio:9000` is unusable from a browser or the host.
- Tests override it to `http://minio:9000`.

### Environment variables (`.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT` | `http://minio:9000` / `http://localhost:9000` | internal calls / client-facing signing host |
| `S3_REGION` | `us-east-1` | SigV4 region |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | required | MinIO root credentials (also consumed by `compose.yaml`) |
| `S3_BUCKET` | `streamtube-media` | media bucket |
| `S3_PRESIGN_EXPIRES_SECONDS` | `3600` | lifetime of presigned URLs |
| `UPLOAD_PART_SIZE_BYTES` | `67108864` (64 MiB, min 5 MiB) | multipart part size (10 GiB ÷ 64 MiB = 160 parts ≤ 10 000) |
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | BullMQ connection |
| `QUEUE_PREFIX` | `streamtube` | BullMQ key prefix (`streamtube-test` in tests) |

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
