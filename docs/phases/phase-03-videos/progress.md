# phase-03-videos — Progress

**Status:** completed
**SIs:** 12/12 completed

### SI-03.1 — Infra: subir MinIO, Redis e FFmpeg no Compose
- **Status:** completed
- **Tests:** 8 passing (`src/config/env.validation.integration-spec.ts`); ACs verified against the running stack (minio/redis healthy, `minio-init` exit 0, bucket private — anonymous GET 403, `ffprobe` present, `redis-cli ping` → PONG)
- **Observations:**
  - Installed versions: MinIO `RELEASE.2026-09-22T19-25-18Z` (Chainguard image by digest), FFmpeg `5.1.9-0+deb12u1` (Debian 12 apt), Redis `8-alpine` by digest.
  - The Chainguard MinIO image ships `mc` + `bash`, so the healthcheck runs `mc ready local` inside the `minio` container; `minio-init` stays on the shell-less `minio-client` image and runs a single `mb --ignore-existing` once `minio` is healthy (credentials via `MC_HOST_local`).
  - Redis port 6379 is published to the host (debug convenience, same as Postgres/MinIO); services talk to it as `redis`.
  - The TaskCreate tool is not available in this environment; progress.md is the per-SI tracker.

### SI-03.2 — Criar StorageModule (S3/MinIO)
- **Status:** completed
- **Tests:** 7 passing (`src/storage/storage.service.integration-spec.ts` — real MinIO: 2-part presigned multipart, Range → 206, attachment download, abort → NoSuchUpload, delete, public vs internal signing host; `src/storage/storage.module.spec.ts`)
- **Observations:**
  - Both S3 clients use `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'`: since AWS SDK v3.729 the default computes CRC32 on `UploadPart`, which would make presigned part URLs demand checksum headers a browser client never sends (context7, `/aws/aws-sdk-js-v3` CHANGELOG 3.731.0).
  - Clients are provided through `S3_INTERNAL_CLIENT` / `S3_PUBLIC_CLIENT` tokens (factory providers) and destroyed in `StorageService.onModuleDestroy` so keep-alive sockets don't hold Jest/app shutdown open.
  - `Content-Disposition` file names are ASCII-sanitized (quotes/backslashes/non-printables → `_`) so a user file name cannot break the header.

### SI-03.3 — Criar entidade Video e migration CreateVideos
- **Status:** completed
- **Tests:** 8 passing (`src/videos/entities/video.entity.integration-spec.ts` — 6: app-generated id + default `draft`, unique slug, invalid enum rejected, `ON DELETE CASCADE`, 10 GiB `size_bytes` as number, jsonb/duration round-trip; `src/database/migrations.integration-spec.ts` — 2: up with 3 migrations, revert removes `videos` + `videos_status_enum`). Full suites re-run because 10 existing test files changed: 161 unit/integration + 52 e2e passing.
- **Observations:**
  - Migration generated with the CLI (`1790616024522-CreateVideos.ts`) *before* any test ran with `Video` — integration tests use `synchronize`, which would otherwise have created the table and left the generator with an empty diff.
  - Deviation (scope-preserving): the inverse `Channel.videos` relation makes every DataSource that loads `Channel` require `Video`, so (a) `Video` was added to the `ALL_ENTITIES` list of the 10 existing test files and (b) a skeleton `src/videos/videos.module.ts` (only `TypeOrmModule.forFeature([Video])`) was registered in `AppModule` now, instead of in SI-03.7 — otherwise `AppModule` (e2e) fails metadata building. SI-03.7 completes the module.
  - Fixed an SI-03.1 slip found by the full e2e run: `test/jest-e2e.json` has `rootDir: "."` resolved relative to `test/`, so its setup file is `<rootDir>/set-test-env.ts`.

### SI-03.4 — Criar fila video-processing e VideoProcessingProducer
- **Status:** completed
- **Tests:** 5 passing (`src/queue/video-processing.producer.integration-spec.ts` — real Redis: job `process-video` with `{ videoId }` and `jobId = videoId`, de-dup on double enqueue, `attempts: 3` + exponential backoff 1000 ms, keys under `QUEUE_PREFIX`; `src/queue/queue.module.spec.ts`)
- **Observations:**
  - Installed `@nestjs/bullmq@11.0.5` + `bullmq@5.81.5` (CJS line, peers with Nest 11 — `@nestjs/bullmq@12` is ESM-only, per library-refs).
  - Job defaults live in `VIDEO_PROCESSING_JOB_OPTIONS` (`queue.constants.ts`) and are applied as the queue's `defaultJobOptions`.

### SI-03.5 — Implementar pré-cadastro do vídeo e início do upload
- **Status:** completed
- **Tests:** 16 new passing — `src/videos/videos.service.spec.ts` (9: default title, explicit title, `part_count` 1/2/160, >10 GiB rejected before multipart, 3 × `UNSUPPORTED_VIDEO_FORMAT`, slug retry via SAVEPOINT, compensation abort), `src/videos/videos.service.integration-spec.ts` (3 — real DB + MinIO: draft persisted with `upload_id` and a writable multipart, distinct slugs, abort on persistence failure), `src/videos/slug.util.spec.ts` (2), `src/channels/channels.service.integration-spec.ts` (+2 `findByUserId`); `src/videos` + `src/channels` suites: 47 passing
- **Observations:**
  - Extracted the private `isPgUniqueViolationOnColumn` helper from `channels.service.ts` into `src/common/database/pg-errors.ts` so the video slug retry reuses it instead of duplicating it (channels behavior unchanged, its suite stays green).
  - `generateVideoSlug` rejects bytes ≥ 248 so each base62 character is uniformly distributed (no modulo bias).
  - Format check requires the extension to map to the declared `content_type` (e.g. `clip.mp4` + `video/webm` → `UNSUPPORTED_VIDEO_FORMAT`); `ffprobe` in the worker remains the authority on content (TD-13).
  - `VideosModule` now provides `VideosService` (imports `StorageModule`, `ChannelsModule`).

### SI-03.6 — Implementar assinatura de partes, conclusão, aborto e consulta do upload
- **Status:** completed
- **Tests:** `src/videos/videos.service.spec.ts` (+17 unit: not found / access denied, part URLs + expiry, out-of-range part, non-draft state, complete → processing + enqueue, 3 × invalid part sets rejected before storage, 4xx storage rejection → `INVALID_UPLOAD_PARTS` keeping the draft, non-client failure rethrown, 2 × size mismatch → object deleted + `failed`, abort, abort non-draft) and `src/videos/videos.service.integration-spec.ts` (+3 — real DB + MinIO + Redis: complete → `processing` + job in the queue, declared/real size mismatch → `failed` + object deleted + no job, abort → draft removed + upload id invalid); `src/videos` suites 38 passing; e2e re-run (AppModule now wires the queue): 52 passing
- **Observations:**
  - A 4xx `S3ServiceException` from `CompleteMultipartUpload` (InvalidPart, InvalidPartOrder, EntityTooSmall, NoSuchUpload…) maps to `INVALID_UPLOAD_PARTS`; any other failure propagates unchanged.
  - On `UPLOAD_SIZE_MISMATCH` the `failed` state and `processing_error` are persisted **before** the exception is thrown, so the DB reflects the terminal state (TD-10/TD-13).
  - `completeUpload` updates the row to `processing` and then enqueues; the worker ignores jobs whose video is not `processing` (SI-03.9), so the order is safe on retries.
  - `VideosModule` now imports `QueueModule`.

### SI-03.7 — Expor endpoints de upload (VideosController + VideosModule)
- **Status:** completed
- **Tests:** `test/videos-upload.e2e-spec.ts` (7 — authored from `nestjs-project/specs/videos-upload.plan.md`: 1.1 create draft, 1.2 401/`UNSUPPORTED_VIDEO_FORMAT`/`VALIDATION_ERROR`, 2.1 owner part URLs on the public host + 403 `VIDEO_ACCESS_DENIED`, 2.2 30 calls without 429, 3.1 real PUT of the part + complete → 202 `processing` + queued job, 4.1 abort → 204 / 409 `INVALID_VIDEO_STATE`, 5.1 owner details + 404 `VIDEO_NOT_FOUND`); `src/videos/videos.module.spec.ts` (1). Full e2e: 59 passing.
- **Observations:**
  - `npm run test:e2e` did not pass `--runInBand` (despite `nestjs-project/CLAUDE.md` stating it was already configured); with a 4th e2e suite Jest ran suites in parallel on the shared DB and `cleanAllTables` raced with other suites (FK violations). Fixed the script to `jest --config ./test/jest-e2e.json --runInBand`.
  - Added `test/helpers/auth-session.ts` (register → capture confirmation token → confirm → login via the real endpoints), shared by the video e2e suites.
  - Response shapes live in `src/videos/dto/video-responses.dto.ts` (classes consumed by the Swagger CLI plugin for the OpenAPI contract); throttle limits in `videos.constants.ts` (`OWNER_READ_THROTTLE` 60/60 s).

### SI-03.8 — Implementar FfmpegService (metadados e thumbnail)
- **Status:** completed
- **Tests:** 10 passing — `src/media/ffmpeg.service.spec.ts` (7: video+audio normalization, no audio → `audio_codec` null, fallback to stream duration/`r_frame_rate`, no video stream → `InvalidMediaError`, duration `N/A` → `InvalidMediaError`, `thumbnailPosition(3)` = 0.3, `thumbnailPosition(3600)` = 60), `src/media/ffmpeg.service.integration-spec.ts` (3 — real ffprobe/ffmpeg 5.1.9 on the generated 3 s clip: duration ≈ 3, h264/aac 320×240 @ 25 fps; text file → `InvalidMediaError`; extracted frame is a non-empty JPEG `FF D8`)
- **Observations:**
  - `normalizeProbeOutput` and `thumbnailPosition` are exported pure functions so the unit test covers the JSON normalization without spawning processes; `FfmpegService` only spawns `ffprobe`/`ffmpeg` (with timeouts and SIGKILL) and maps a non-zero ffprobe exit to `InvalidMediaError` (TD-13).
  - `InvalidMediaError` lives in `src/media/media.errors.ts` as a plain `Error` (not a `DomainException`): it never reaches HTTP, the worker turns it into a terminal `failed` status.
  - `src/test/video-fixture.ts` generates the clip with `lavfi` `testsrc` + `sine` (libx264/aac) in a temp dir — no binary fixture committed.

### SI-03.9 — Implementar VideoProcessor (processamento em segundo plano)
- **Status:** completed
- **Tests:** 15 new passing — `src/worker/video.processor.spec.ts` (8: happy path → thumbnail `thumbnails/{id}.jpg` + `markProcessed`; `ready`/`failed`/`draft` skipped; missing video skipped; invalid media → `markFailed` + `UnrecoverableError`; transient failure on attempt 1/3 rethrown without `markFailed`; failure on attempt 3/3 → `markFailed`), `src/worker/video.processor.integration-spec.ts` (3 — real DB + MinIO + FFmpeg: generated clip → `ready` with duration ≈ 3 s, h264 320×240 @ 25 fps and the thumbnail object in MinIO; text file → `failed` on the first attempt via `UnrecoverableError`; reprocessing a `ready` video is a no-op), `src/videos/videos.service.integration-spec.ts` (+4: `markProcessed`, `markFailed` truncated to 500, status guard on a video that already left `processing`, `findForProcessing` → null); `src/worker` + `src/media` + `src/videos`: 64 passing
- **Observations:**
  - `markProcessed`/`markFailed` update `WHERE id = :id AND status = 'processing'`, so a duplicate or late job can never overwrite a `ready`/`failed` video (idempotency required by TD-10).
  - The processor issues a `HeadObject` on the original before probing: an unreachable storage or a missing object then fails as a transient storage error (retried with backoff) instead of being misread by ffprobe as invalid media and failed without retries.
  - Found while testing: ffprobe/ffmpeg echo the input in stderr, so the error for a presigned URL carried a live `X-Amz-Signature` into logs and `processing_error` (visible to the owner). `FfmpegService` now redacts the input as `<input>`; the integration test asserts it.
  - `VideoProcessor` is not registered in `AppModule` (the API never consumes jobs, TD-06); it is wired by the worker entrypoint in SI-03.10.

### SI-03.10 — Criar entrypoint do worker e serviço video-worker no Compose
- **Status:** completed
- **Tests:** `src/worker/worker.module.spec.ts` (2 — `WorkerModule` compiles against the real DB/Redis/MinIO and resolves `VideoProcessor` (a `WorkerHost`), `VideosService`, `StorageService`, `FfmpegService`; declares no controllers). Full suite after the change: 228 unit + integration, 59 e2e passing; tsc 0; lint 0 errors
- **Observations:**
  - ACs verified against the running stack: `docker compose up -d` brings `video-worker` up next to `nestjs-api`, `db`, `mailpit`, `minio`, `redis` (no published ports; application context only — no HTTP server); its log shows `[VideoWorker] Consuming the video-processing queue`. A smoke run (real clip PUT to MinIO, `processing` row, `process-video` enqueued on the dev prefix `streamtube`) was consumed by the container: log `process-video <id>: attempt 1/3` → `ready (4.00 s)`, row `ready` with h264/aac 320×240 @ 25 fps and `thumbnails/<id>.jpg` (6.9 KB `image/jpeg`) in MinIO; smoke data removed afterwards. The API → worker path over HTTP is exercised by `test/videos-playback.e2e-spec.ts` 6.1 (SI-03.11).
  - Bug caught by the module test: with `autoLoadEntities`, the worker only knew `Channel`/`Video`, and `Channel#user` failed metadata building (the API gets `User` through `AuthModule → UsersModule`). `WorkerModule` imports `UsersModule` to complete the `Video → Channel → User` graph.
  - Both containers bind-mount the project and `nest-cli.json` has `deleteOutDir: true`, so two `nest start --watch` would wipe each other's `dist/`. `start:worker:dev` compiles with `tsconfig.worker.json` (`outDir: ./dist-worker`, git-ignored and excluded in `tsconfig.json`); `start:worker` (`node dist/main-worker`) is the production path after `nest build`.
  - Deviation (scope-preserving): the `ConfigModule.forRoot` and `TypeOrmModule.forRootAsync` blocks moved from `AppModule` to `src/config/root-config.ts` / `src/database/root-typeorm.ts` so the API and the worker load and validate exactly the same environment (TD-06 "same codebase"); `AppModule` behavior is unchanged (full e2e green).
  - `VideosController` comes along with `VideosModule`, but an application context never binds routes; `WorkerModule` itself declares none.

### SI-03.11 — Expor streaming, download e thumbnail (endpoints públicos)
- **Status:** completed
- **Tests:** `test/videos-playback.e2e-spec.ts` (6 — authored from `nestjs-project/specs/videos-playback.plan.md`, `VideoProcessor` in-process on the test prefix: 1.1 anonymous stream → 302 to the `S3_PUBLIC_ENDPOINT` host, `Range: bytes=0-1023` → 206 `Content-Range: bytes 0-1023/<size>` + 1024 bytes; 2.1 download → 302, `Content-Disposition: attachment; filename="clipe.mp4"` + full body; 3.1 thumbnail → 302 to a JPEG `FF D8`; 4.1 unknown slug + `draft` + `processing` (worker paused) + `failed` (text file processed) → 404 `VIDEO_NOT_FOUND` on the 3 routes; 5.1 30 stream calls without 429; 6.1 POST → PUT parts → complete → worker → `ready` (duration, `video_codec`, `has_thumbnail`) → 206 with 100 bytes), `src/videos/videos.service.spec.ts` (+7 `getPlaybackUrl`: stream/download attachment name/thumbnail keys, unknown slug, `draft`/`processing`/`failed` → `VIDEO_NOT_FOUND`). Full e2e: 65 passing
- **Observations:**
  - Endpoints return `HttpRedirectResponse` through `@Redirect()` (context7 `/nestjs/docs.nestjs.com`, controllers → Redirection); playback never proxies bytes through the API.
  - The slug routes (`/videos/:slug/{stream,download,thumbnail}`) have two segments, so they don't collide with the owner route `GET /videos/:id` (`ParseUUIDPipe`).

### SI-03.12 — Sincronizar contrato OpenAPI e documentar a fase
- **Status:** completed
- **Tests:** `src/openapi-export.integration-spec.ts` (+3: the 8 video operations are exported; owner endpoints require `access-token` and the 3 playback routes don't; playback documents `302` + `Location` and `404`) — 12 passing
- **Observations:**
  - Contract chain run: `openapi:export` → `scripts/sync-openapi.sh` → `openapi:types`. `nestjs-project/openapi.json` and `next-frontend/openapi.json` are byte-identical, and a second `openapi:types` produced no diff in `types.gen.ts` (same md5). Frontend DoD after the regen: `tsc` 0, lint 0 errors, Vitest 67 passing.
  - `next-frontend/openapi.json` is git-ignored (`next-frontend/.gitignore`). The root `CLAUDE.md` said to commit it; it now says to commit `nestjs-project/openapi.json` + `types.gen.ts`.
  - Fixed afterwards in this phase, at the user's request to resolve everything in the session. `openapi:export` runs through ts-node, which doesn't apply the `@nestjs/swagger` CLI plugin, so every DTO schema had been exported without `properties` (the baseline too, auth DTOs included).
    - `src/swagger/generate-metadata.ts` (`npm run openapi:metadata`, chained into `openapi:export`) generates `src/metadata.ts` with the CLI's `PluginMetadataGenerator` + `ReadonlyVisitor`, using the plugin options from `nest-cli.json` (context7 `/nestjs/docs.nestjs.com`, OpenAPI → CLI plugin / SWC recipe). `exportSpec` now loads it like `main.ts` does.
    - Two CommonJS adaptations are applied to the printed file, both documented in the generator: `import()` → `require()` (under `module: nodenext` tsc keeps dynamic `import()` native, and Node's ESM resolver can't load extensionless paths), and interface fields qualified as `t[...].Object` → `Object`.
    - `generate-metadata.integration-spec.ts` fails `npm test` when the committed file is stale.
    - The live `/api/docs-json` of the production build (`SWAGGER_ENABLED=true`) matches the exported `openapi.json` byte for byte (paths and schemas).
  - `.claude/rules/nestjs-dtos.md` requires `@ApiProperty` on response DTO fields. `src/videos/dto/video-responses.dto.ts` now has it, with formats, examples and the named `VideoStatus` enum. Nullable fields declare `type` explicitly, because `T | null` reflects as `Object`.
  - The frontend regen with the real shapes stays green: `tsc` 0, lint 0 errors, Vitest 67.
  - Documentation drift found and corrected:
    - `next-frontend/CLAUDE.md` and `.claude/rules/next-frontend-bff-api.md` cited a CI workflow (`.github/workflows/openapi-freshness.yml`) that was never committed, and called `next-frontend/openapi.json` committed although it is git-ignored.
    - `nestjs-project/CLAUDE.md` now documents the `*.module.spec.ts` exception prescribed by the testing guide: compilation tests run against the real services.
  - Docs updated against the code:
    - `nestjs-project/CLAUDE.md`: services and readiness checks; worker commands and `dist-worker`; test infra and `set-test-env.ts`; a Videos section with modules, endpoints, lifecycle, storage layout and env vars.
    - Root `CLAUDE.md`: phase status, containers, the `S3_PUBLIC_ENDPOINT` exception, commands.
    - `docs/diagrams/software-arch.mermaid`: queue is Redis + BullMQ, storage is MinIO.
    - `README.md`: architecture, services, Phase 03 endpoints, structure, phase table.
  - Every file path cited in the three documents was checked to exist. `npm run build` emits both `dist/main.js` and `dist/main-worker.js`.

### Final verification (Definition of Done)
- `docker compose exec nestjs-api npm test -- --runInBand` → 38 suites, 241 tests passing
- `docker compose exec nestjs-api npm run test:e2e` → 5 suites, 65 tests passing
- `docker compose exec nestjs-api npx tsc --noEmit` → exit 0
- `docker compose exec nestjs-api npm run lint` → exit 0 (0 errors; the 28 warnings were there before Phase 03)
- `docker compose ps` → `db`, `mailpit`, `minio`, `redis` healthy; `nestjs-api` and `video-worker` up; `minio-init` exited 0
- Real end-to-end run before the PR:
  - Setup: the API dev server was running, the `video-worker` container consumed the dev queue, and a host-side client talked HTTP to `localhost:3000` and the presigned URLs to `localhost:9000`, with confirmation through Mailpit.
  - Result: 27/27 checks passed.
    - Auth: register → confirm → login.
    - Upload limits: 401 without a token, `VIDEO_TOO_LARGE` above 10 GiB, and exactly 10 GiB accepted as 160 parts of 64 MiB.
    - Upload and processing: a 137 MB 1080p clip in 3 parts PUT straight to MinIO → complete `202` → the worker set it to `ready` within ~1 s. It extracted 60 s, h264/aac 1920×1080 @ 30 fps, and a thumbnail taken at 6.000 s (10%).
    - Playback: stream `302` → `206` for byte 0 and for a seek to byte 100,000,000; the download was byte-identical (sha256); thumbnail served as JPEG.
    - Failure paths: a non-video file → `failed` with the signature redacted; `failed` video and unknown slug → 404; another user → 403.
  - Test data was removed afterwards.
