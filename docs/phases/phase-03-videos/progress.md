# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 6/12 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Implementar FfmpegService (metadados e thumbnail)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Implementar VideoProcessor (processamento em segundo plano)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Criar entrypoint do worker e serviço video-worker no Compose
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Expor streaming, download e thumbnail (endpoints públicos)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Sincronizar contrato OpenAPI e documentar a fase
- **Status:** pending
- **Tests:** —
- **Observations:** none
