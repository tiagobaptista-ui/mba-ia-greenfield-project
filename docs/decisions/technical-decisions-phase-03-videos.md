---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-28
scope_description: "Backend foundation for video upload and processing: background queue technology, local S3-compatible storage server, storage layout and access model, large-file (≤10GB) upload protocol, upload-completion trigger, worker runtime, FFmpeg integration for metadata/thumbnail, unique video URL identifier, streaming/download delivery, video status lifecycle and failure handling, Phase 03 access policy, and the testing strategy for storage/queue/worker."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the whole phase: the videos module (API), the object-storage integration, the queue producer, the FFmpeg video worker (a second process) and the new Compose services (storage, queue, worker). Covered by TD-01 … TD-12.
- `next-frontend/` — no open decision in this document. The phase's capability bullets name no screen; the upload/player UI belongs to Phase 04 (painel de gerenciamento) and Phase 05 (player). TD-04 and TD-09 fix the API-side contract (upload handshake, stream/download delivery) that the future client will follow, so no frontend runtime choice is needed now.

**Inherited constraints (not reopened):** `phase-01-configuracao-base/TD-01…TD-04` (`@nestjs/config` + Joi + namespaced `registerAs` shared with the TypeORM CLI), `phase-02-auth/TD-02` (custom global `JwtAuthGuard` + `@Public()`), `phase-02-auth/TD-06` (class-validator DTOs), `phase-02-auth/TD-07` (domain exception filter / error envelope), `phase-02-auth/TD-08` (`@nestjs/throttler`), `openapi-docs-nestjs/TD-01…TD-02` (`@nestjs/swagger` + exported `openapi.json`, consumed by `next-frontend-openapi-typing`).

**Installed stack that constrains the options** (`nestjs-project/package.json` + lockfile): NestJS 11.1.16, TypeORM 0.3.28, TypeScript 5.9.3, Jest 30 + ts-jest 29 (CommonJS test runtime), Node 25.6.0 (`Dockerfile.dev`, Debian 12 slim). The backend compiles to **CommonJS** — ESM-only packages are a concrete compatibility cost below.

---

## TD-01: Background Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan and the C4 diagram leave the message queue as "TBD". After an upload finishes, the API must hand the video to a worker without waiting for processing; the queue needs retries with backoff (FFmpeg on user files fails in practice), job de-duplication (a double "complete" call must not process twice) and a real service in Compose. This is the main stack decision of the phase.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue with first-class Nest integration: `BullModule.forRootAsync` / `registerQueue` for producers, `@Processor` + `WorkerHost.process()` for consumers. Adds one `redis` service to Compose.
- **Pros:** retries with exponential backoff, `jobId`-based de-duplication (a job whose id already exists is ignored), delays, progress and failed-job retention are built in. `@nestjs/bullmq@11.0.x` is CommonJS and peers with Nest `^11` + `bullmq ^5` — drop-in for this codebase. Documented Nest recipe (context7 `/nestjs/docs.nestjs.com`, "Queues").
- **Cons:** new infrastructure (Redis) to operate; Redis persistence must be configured (AOF) or queued jobs are lost on restart. `@nestjs/bullmq@12` is `type: module`, so the version must be pinned to 11.x while the project stays CJS.

### Option B: RabbitMQ (`@golevelup/nestjs-rabbitmq`)
- AMQP broker (`rabbitmq` service) with exchanges/queues; the API publishes, the worker subscribes with `@RabbitSubscribe`.
- **Pros:** mature broker, protocol-level acks, strong routing features, good fit if the system later becomes event-driven across many services.
- **Cons:** no built-in delayed retries — the handler returns `Nack(true|false)` and the retry counter, dead-letter exchange and delay must be built by the app (context7, golevelup docs). No job de-dup primitive. `@golevelup/nestjs-rabbitmq@9.0.2` peers with `@nestjs/common ^11.1.21` (installed: 11.1.16), forcing a framework bump. More config than the phase needs (it has one job type).

### Option C: pg-boss (queue in PostgreSQL)
- Job queue stored in the existing PostgreSQL (`SKIP LOCKED`), no new service.
- **Pros:** zero new infrastructure; transactional enqueue in the same DB transaction as the video row; retries/backoff built in.
- **Cons:** puts queue churn on the primary database; `pg-boss@12` is ESM-only and requires Node ≥ 22.12 — works at runtime on Node 25 but conflicts with the CJS build + ts-jest; no Nest module (manual lifecycle wiring). The C4 diagram and the assignment expect a separate queue container.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the only option that gives retries-with-backoff and job de-duplication out of the box with an official Nest integration that is CommonJS-compatible with the installed Nest 11.1.16; RabbitMQ would force a Nest upgrade and a hand-built retry/DLX layer for a single job type, and pg-boss is ESM-only and loads the primary DB. Pin `@nestjs/bullmq@^11.0` + `bullmq@^5`.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

**Libraries:** @nestjs/bullmq, bullmq

---

## TD-02: Local S3-Compatible Storage Server (Compose image)

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The project targets S3 (the code will speak only the S3 API) and the assignment asks for MinIO locally. Since October 2025 MinIO stopped publishing community images and in September 2026 the `minio/minio` Docker Hub repository was removed; verified on 2026-09-28: `minio/minio`, `quay.io/minio/minio` (all tags tried) and `bitnami/minio` no longer resolve, while `cgr.dev/chainguard/minio:latest` (built from MinIO source, 2026-09-27) and `cgr.dev/chainguard/minio-client:latest` do. The Compose image choice is therefore a real decision, cited in `compose.yaml`, `.env.example` and the docs.

**Options:**

### Option A: MinIO via Chainguard image (`cgr.dev/chainguard/minio`)
- Chainguard rebuilds MinIO from source continuously; distroless, non-root (uid 65532), entrypoint `/usr/bin/minio`. `cgr.dev/chainguard/minio-client` provides `mc` for bucket bootstrap.
- **Pros:** it is actual MinIO (same S3 behavior the assignment expects: presigned URLs, multipart, `Range` → `206`, stale multipart cleanup defaults 24h/6h); free, currently maintained; pin by digest for reproducibility.
- **Cons:** free tier exposes only `latest` (pin by digest, not by version); distroless image has no shell/`curl`, so the healthcheck must come from another container (`mc ready`) or the `-dev` variant.

### Option B: Build MinIO from source locally
- A project Dockerfile compiles the MinIO community source (Go) into an image.
- **Pros:** full control of the version.
- **Cons:** slow first build and a Go toolchain in the dev loop; the community source is unmaintained (development stopped in 2026), so the project would own its patching.

### Option C: Another S3-compatible server (SeaweedFS or RustFS)
- Replace MinIO with a maintained S3-compatible server (`chrislusf/seaweedfs`, `rustfs/rustfs` both resolve).
- **Pros:** actively maintained open-source images with version tags.
- **Cons:** diverges from the assignment ("MinIO localmente"); S3 edge behavior (presigned multipart, CORS, `ETag` exposure) would need re-validation per server.

**Recommendation:** **Option A (Chainguard MinIO, pinned by digest)** — it keeps the assignment's MinIO with the exact S3 semantics the upload/stream design relies on, without owning a Go build; because the application talks only S3 (endpoint + credentials from env), swapping to AWS S3 in production or to another S3 server later is a configuration change, not a code change.

**Decision:** A (MinIO via Chainguard image `cgr.dev/chainguard/minio`, pinned by digest)

**Libraries:** minio

---

## TD-03: Storage Layout and Access Model

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Video originals and thumbnails need a bucket/key layout, an access model (who can read objects directly) and a way for clients outside Docker to reach presigned URLs. SigV4 presigned URLs are signed for a specific host: containers reach the storage as `minio:9000`, but a browser/host client can only reach `localhost:9000` — a URL signed for one host is rejected on the other. The key layout is cited by the API, the worker and the tests.

**Options:**

### Option A: Single private bucket, prefixed keys, presigned access only
- One bucket (e.g. `streamtube-media`), keys `videos/{videoId}/original` and `thumbnails/{videoId}.jpg`; the bucket stays private and every client read/write uses short-lived presigned URLs. Two S3 client configurations: an **internal** endpoint (`http://minio:9000`) for server-to-storage calls and a **public** endpoint (e.g. `http://localhost:9000`) used only to sign URLs handed to clients.
- **Pros:** one bucket to bootstrap and one lifecycle policy; keys derive from the video id (no user input in keys); nothing is world-readable; the internal/public split is the documented exception to "use service names" (the public endpoint is a client-facing URL, never used service-to-service).
- **Cons:** every thumbnail read also needs a presigned URL (or an API redirect); two endpoint settings to keep consistent.

### Option B: Two buckets — private videos, public-read thumbnails
- Originals in a private bucket via presigned URLs; thumbnails in a public-read bucket served by plain URL.
- **Pros:** thumbnails are cacheable plain URLs (cheap for listing pages in later phases).
- **Cons:** two buckets + a bucket policy to maintain; public bucket makes thumbnails of not-yet-published videos guessable once Phase 04 adds visibility.

### Option C: Public-read bucket for everything
- Objects served directly by URL, no signing.
- **Pros:** simplest delivery.
- **Cons:** anyone with the key reads any original — incompatible with drafts and with Phase 04's "unlisted" visibility; no way to force `Content-Disposition: attachment` per request.

**Recommendation:** **Option A** — a single private bucket with id-derived keys plus presigned access keeps drafts and future unlisted videos protected, needs one bootstrap step, and the internal/public endpoint split is the minimum needed for presigned URLs to work both inside Compose and from the host.

**Decision:** A (single private bucket, id-derived keys, presigned-only access, internal/public S3 endpoints)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-04: Large-File Upload Protocol (≤ 10GB, resumable)

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A 10GB upload must not tie up the API and, per `docs/project-plan.md` §4 ("Pontos de Atenção"), must be resumable after a connection failure. S3 limits shape the options: a single PUT is capped at 5 GiB (so one presigned PUT cannot carry 10GB), multipart parts are 5 MiB–5 GiB (last part may be smaller) and at most 10,000 parts. The protocol is an API contract the future upload UI must follow (client side deferred with the UI; see "Subprojects in scope").

**Options:**

### Option A: S3 multipart upload with presigned part URLs
- `POST /videos` creates the draft video + `CreateMultipartUpload` and returns `videoId`, `uploadId`, part size and part count; the client asks for presigned `UploadPart` URLs (in batches), PUTs each part **directly to storage**, collects the `ETag`s and calls a complete endpoint (TD-05). Parts can be re-sent individually; `ListParts` supports resume.
- **Pros:** the file bytes never pass through the API (no memory/bandwidth/connection held by Nest); resumable per part; native S3 feature, portable MinIO ↔ AWS; the API stays a thin control plane. Draft pre-registration happens naturally at step 1.
- **Cons:** multi-step client handshake (init → sign parts → PUT → complete); presigned URLs must be signed for a host the client can reach (TD-03); browser clients need storage CORS exposing `ETag` (configure now, used when the UI lands).

### Option B: tus resumable-upload server (`@tus/server` + `@tus/s3-store`)
- A tus endpoint (inside the API or a separate service) receives `PATCH` chunks and writes them to S3 as multipart.
- **Pros:** standard resumable protocol with ready clients (tus-js-client/Uppy); resume semantics are part of the spec.
- **Cons:** every byte passes through the tus server — hosting it in the API contradicts "sem impacto na performance", hosting it separately adds a service; `@tus/server@2` and `@tus/s3-store@2` are ESM-only (CJS build conflict).

### Option C: Stream the multipart/form-data body through the API to S3
- The API pipes the incoming request stream to S3 (`@aws-sdk/lib-storage` `Upload`).
- **Pros:** simplest client (one POST).
- **Cons:** the API holds a connection and forwards 10GB per upload (bandwidth and timeouts on the API tier); not resumable — a dropped connection restarts from zero; directly contradicts the phase's non-functional requirement.

**Recommendation:** **Option A (S3 multipart + presigned part URLs)** — it is the only option where the 10GB never touches the API and each part is independently retryable, using a native S3 feature that works identically on MinIO and AWS; part size ~64 MiB keeps a 10 GiB file at ~160 parts (well under 10,000), `size_bytes ≤ 10 GiB` is validated at init, and part URLs are signed in batches so the handshake stays within the global throttler.

**Decision:** A (S3 multipart upload with presigned part URLs)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-09-28 — Pre-registration request fixed: required `file_name`, `size_bytes`, `content_type`; optional `title` (1–100 chars) defaulting to the file name without extension (editable in Phase 04). Rationale: resolves AMB-2 in `/plan-resolve` (user choice: title optional, derived from file name).

---

## TD-05: Upload Completion and Processing Trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Processing must start automatically once the upload is complete. Something has to (1) finalize the multipart object, (2) move the video out of `draft` and (3) enqueue the processing job (TD-01) exactly once. Depends on TD-01 and TD-04.

**Options:**

### Option A: Explicit complete endpoint in the API
- The client calls `POST /videos/{id}/upload/complete` with the part `ETag`s; the API runs `CompleteMultipartUpload`, sets status `processing` and enqueues the job with `jobId = videoId`.
- **Pros:** deterministic, testable with supertest end to end; ownership and state are checked in one place; `jobId` de-dup makes a repeated call harmless; identical on MinIO and AWS.
- **Cons:** relies on the client to call it (an abandoned upload stays `draft` — handled by TD-10's abandoned-upload policy).

### Option B: Storage bucket notification
- Configure MinIO to publish `s3:ObjectCreated:CompleteMultipartUpload` events (webhook/Redis/AMQP target) that trigger the job.
- **Pros:** fires even if the client never calls the API after the last part.
- **Cons:** the client must still call `CompleteMultipartUpload` (via the API or a presigned POST), so the API is involved anyway; notification config is MinIO-specific (AWS uses SNS/SQS/EventBridge instead), breaking the "config-only swap" of TD-02; harder to test deterministically.

**Recommendation:** **Option A (explicit complete endpoint)** — S3 multipart always needs a `CompleteMultipartUpload` call, so doing it in the API gives one authorized, testable transition (`draft → processing` + enqueue with `jobId = videoId`) that behaves the same on MinIO and AWS.

**Decision:** A (explicit complete endpoint + enqueue with `jobId = videoId`)

---

## TD-06: Video Worker Runtime and Deployment

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram has a separate "Video Worker (FFmpeg)" container that consumes the queue, reads/writes storage and updates the database. FFmpeg work is CPU-heavy and must not run in the API process. The worker needs the `Video` entity, the storage client and the config the API already has. Depends on TD-01.

**Options:**

### Option A: Same codebase, second entrypoint, own Compose service
- `nestjs-project` gets a worker entrypoint (`NestFactory.createApplicationContext(WorkerModule)`, no HTTP server) and a `video-worker` Compose service built from the same image with a different command.
- **Pros:** reuses entities, config (`registerAs` + Joi), TypeORM data source and storage service with zero duplication; independent process and container (scales and crashes separately); one `package.json` and one test suite.
- **Cons:** the worker image carries the API code too; the two entrypoints must stay coherent (module boundaries matter).

### Option B: Separate subproject (`video-worker/` with its own package.json)
- A standalone Node/Nest app with its own dependencies.
- **Pros:** strict isolation; can use a different runtime or language.
- **Cons:** duplicates the `Video` entity, DB config, env validation and storage client (drift risk); a second toolchain and test setup for one job type.

### Option C: BullMQ worker inside the API process
- Register the processor in the API app itself.
- **Pros:** no extra container.
- **Cons:** FFmpeg competes with HTTP handling for CPU in the API container — contradicts the phase's "sem impacto na performance" and the C4 design.

**Recommendation:** **Option A** — a second entrypoint in the same codebase delivers the separate worker container the architecture requires while reusing the existing config, entities and storage code instead of duplicating them.

**Decision:** A (same codebase, second entrypoint, own `video-worker` Compose service)

---

## TD-07: FFmpeg Integration for Metadata and Thumbnail

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker extracts duration and technical metadata (container, codecs, resolution, bitrate) and grabs one frame as the thumbnail. It needs an FFmpeg binary and a Node integration. Inputs can be 10GB, so how the worker reads the source matters. Depends on TD-06.

**Options:**

### Option A: `ffprobe`/`ffmpeg` via `child_process.spawn`, binary from the OS package
- Install the distro `ffmpeg` package in `Dockerfile.dev`; the worker spawns `ffprobe -print_format json -show_format -show_streams <url>` and `ffmpeg -ss <t> -i <url> -frames:v 1 <thumb.jpg>`, reading the source through a short-lived presigned GET URL (FFmpeg seeks with HTTP `Range`, no full download).
- **Pros:** no wrapper dependency; JSON output from ffprobe parses into typed metadata; seeking over HTTP avoids copying 10GB to local disk; the same binary is available to integration tests in the API container.
- **Cons:** the app owns argument building, exit-code/stderr handling and timeouts.

### Option B: `fluent-ffmpeg`
- Fluent Node API over the FFmpeg CLI.
- **Pros:** convenient builder API, many examples.
- **Cons:** the npm package is **deprecated** ("Package no longer supported", 2.1.3) — unmaintained dependency for a core path.

### Option C: Bundled binaries via npm (`ffmpeg-static` / `ffprobe-static`) + spawn
- npm packages that download a static FFmpeg build at install time.
- **Pros:** binary version pinned through `package-lock`.
- **Cons:** install-time download of large binaries into the bind-mounted `node_modules`; `ffprobe-static` last published 2022; still needs the spawn integration of Option A.

**Recommendation:** **Option A** — spawning the OS-packaged `ffprobe`/`ffmpeg` avoids a deprecated wrapper and install-time binary downloads, and reading through a presigned URL lets FFmpeg seek within a 10GB file without a local copy; the thumbnail frame is taken at ~10% of the duration (bounded to the first minute) to avoid black intro frames.

**Decision:** A (spawn OS-packaged `ffprobe`/`ffmpeg` over a presigned GET URL)

**Libraries:** ffmpeg

**Revisions:**
- 2026-09-28 — Persisted metadata fixed: `duration_seconds` as a dedicated column plus a `metadata` jsonb with normalized fields (container/format, video codec, audio codec, width, height, fps, bitrate). Rationale: resolves AMB-1 in `/plan-resolve` (user choice: duration column + normalized metadata JSON).

---

## TD-08: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short public identifier for its URL that never collides (§4 "Pontos de Atenção": "URL curta e única que nunca conflite"). It is cited by the entity/migration, the stream/download routes and future frontend routes. `nanoid@5+` is ESM-only (latest 6.0.1), which matters for the CJS build.

**Options:**

### Option A: Random base62 slug from `node:crypto` + unique index + retry
- 11 characters from `crypto.randomBytes` mapped to `[0-9A-Za-z]` (~65 bits); a `UNIQUE` constraint guarantees no conflict and an insert that hits `23505` retries with a new slug (same pattern as `ChannelsService.createChannel`, with a SAVEPOINT per attempt).
- **Pros:** no dependency; not enumerable (does not leak upload order/volume); DB-level uniqueness guarantee; collision retry is already a project pattern.
- **Cons:** needs the retry loop (practically never triggered at this entropy).

### Option B: Sqids over a numeric sequence
- Encode an auto-increment integer into a short string with `sqids`.
- **Pros:** collision-free by construction; very short.
- **Cons:** reversible by design — anyone can decode the sequence (exposes volume, enables enumeration of unlisted videos in Phase 04); requires an extra sequence column; `sqids` last published 2023.

### Option C: UUID in the URL
- Use the primary key directly.
- **Pros:** zero extra column or logic.
- **Cons:** 36 characters — not the "URL curta" the plan asks for; couples the public URL to the internal id.

**Recommendation:** **Option A** — a crypto-random base62 slug with a unique index is short, non-enumerable (important once Phase 04 adds unlisted videos) and dependency-free, and its collision handling reuses the retry pattern the project already has for channel nicknames.

**Decision:** A (11-char base62 slug from `node:crypto` + unique index + retry)

---

## TD-09: Streaming and Download Delivery

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, and users can download the original. The C4 diagram has the frontend streaming **from Object Storage**, not through the API. Depends on TD-03 (private bucket + public signing endpoint).

**Options:**

### Option A: API redirects to presigned storage URLs
- `GET /videos/{slug}/stream` answers `302` to a short-lived presigned GET; the player then sends `Range` requests straight to storage, which answers `206 Partial Content`. `GET /videos/{slug}/download` redirects to a presigned GET with `ResponseContentDisposition=attachment; filename=…`.
- **Pros:** bytes flow storage → client (matches the C4 diagram); range/seek/resume handled natively by S3/MinIO; the API only authorizes and signs; per-request `Content-Disposition` for download.
- **Cons:** URLs expire (players re-request the redirect after expiry); the client must reach the public storage endpoint (TD-03).

### Option B: API proxies bytes with Range support
- The API reads `Range`, calls `GetObject` with the same range and pipes the body back with `206`.
- **Pros:** single origin; storage never exposed to clients.
- **Cons:** every played byte crosses the API (the performance cost the phase is trying to avoid); the API must implement range parsing edge cases itself.

### Option C: Adaptive streaming (HLS) produced by the worker
- The worker transcodes renditions + segments; the player loads a manifest.
- **Pros:** adaptive bitrate, the "YouTube-grade" experience.
- **Cons:** heavy transcoding cost and storage multiplication, far beyond the phase's capabilities (which only require playback without full download); still needs Option A or B to serve segments.

**Recommendation:** **Option A** — progressive playback with HTTP `Range` straight from storage satisfies "sem necessidade de download completo" with no transcoding, keeps video bytes off the API as the C4 diagram prescribes, and gives download a forced-attachment variant of the same mechanism.

**Decision:** A (API 302 to presigned GET; `Range`/`206` served by storage; attachment variant for download)

---

## TD-10: Video Status Lifecycle and Processing Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row is created as a draft when the upload starts and must reflect processing progress and failures in the database. Worker failures are expected (corrupt file, unsupported codec, transient storage error). Phase 04 later adds a separate "rascunho → publicação" flow and visibility; this status must not collide with it. Depends on TD-01, TD-05, TD-06.

**Options:**

### Option A: Single processing status with bounded retries and terminal `failed`
- `status` enum `draft → processing → ready | failed`; `draft` = created, upload not completed; the job runs with `attempts: 3` + exponential backoff; the worker is idempotent (deterministic thumbnail key, metadata overwrite); after the last attempt it sets `failed` and stores a short `processing_error`. Abandoned drafts: abort-multipart endpoint + storage stale-upload expiry (MinIO default 24h; `AbortIncompleteMultipartUpload` lifecycle on AWS).
- **Pros:** one column to query; transient errors recover automatically; failures are visible and explainable; publication/visibility in Phase 04 stays an orthogonal field.
- **Cons:** "draft" here means "upload not finished" — Phase 04 must name its publication state separately (e.g. `visibility` / `published_at`).

### Option B: Separate `upload_status` and `processing_status` columns
- Two state machines on the row.
- **Pros:** very explicit per stage.
- **Cons:** invalid combinations become possible; more states for clients to interpret, with no capability that needs them.

### Option C: No retries — fail fast
- First error sets `failed`; user re-uploads.
- **Pros:** simplest worker.
- **Cons:** transient storage/DB hiccups become permanent failures of a 10GB upload.

**Recommendation:** **Option A** — a single `draft → processing → ready | failed` status matches the lifecycle the phase describes, bounded retries with backoff (native in TD-01's BullMQ) absorb transient errors, and keeping publication out of this column leaves Phase 04's draft→published flow free to be modeled on its own.

**Decision:** A (single status `draft → processing → ready | failed`, 3 attempts + exponential backoff)

**Revisions:**
- 2026-09-28 — Status semantics fixed: this `status` covers only the technical upload/processing lifecycle; editorial publication/visibility (Phase 04 "rascunho → publicação") is a separate attribute to be added by Phase 04, so a `ready` video is not "published". Rationale: resolves AMB-3 in `/plan-resolve` (user choice: separate concepts).

---

## TD-11: Access Policy for Video Endpoints in Phase 03

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Endpoints are JWT-protected by default (`phase-02-auth/TD-02`) and globally throttled at 10 requests/60s (`phase-02-auth/TD-08`). Upload control calls are per owner; playback/download must work for viewers. Visibility (public/unlisted) only arrives in Phase 04 and anonymous viewing is a platform principle (`docs/project-plan.md` §1). A player issues several requests and a 10GB upload signs parts in batches — both would hit the global throttle.

**Options:**

### Option A: Owner-only upload control, public playback of `ready` videos by slug
- Upload init/sign/complete/abort require JWT and ownership (video's channel = caller's channel). Stream/download are `@Public()` and only serve `ready` videos (others → 404), effectively "unlisted by link" until Phase 04 adds visibility. Part-signing and stream/download get a dedicated throttle limit instead of the auth-sized global one.
- **Pros:** matches "anonymous users watch freely"; no leak of drafts or failed uploads; throttling stays on but sized per endpoint.
- **Cons:** any `ready` video is watchable by whoever has the slug until Phase 04 — acceptable because the slug is non-enumerable (TD-08).

### Option B: Owner-only for everything in Phase 03
- Stream/download also require the owner's JWT until Phase 04.
- **Pros:** most restrictive.
- **Cons:** contradicts anonymous viewing; Phase 04/05 would have to reopen the policy.

### Option C: Authenticated users only for playback
- Any logged-in user can stream/download.
- **Pros:** middle ground.
- **Cons:** contradicts "anonymous users watch freely" with no capability asking for it.

**Recommendation:** **Option A** — it aligns with the platform's anonymous-viewing principle, protects everything that is not `ready`, and relies on TD-08's non-enumerable slug as the "unlisted-by-link" boundary until Phase 04 introduces visibility.

**Decision:** A (owner-only upload control; public playback of `ready` videos by slug; dedicated throttle limits)

---

## TD-12: Testing Strategy for Storage, Queue and Worker

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The testing guide (`testing-guide-nestjs-project`) suggests a "local filesystem adapter under a tmp dir" for storage, while integration/e2e tests in this project run against real Compose services (Postgres, Mailpit) and the phase requires that storage, queue and worker be exercised for real. The e2e flow must also avoid a race between the `video-worker` container and test cleanup when both consume the same queue.

**Options:**

### Option A: Real MinIO + Redis + FFmpeg in integration/e2e, isolated queue per test run
- Integration and e2e tests use the Compose `minio` and `redis` services and the `ffmpeg` binary in the API container; a tiny generated video fixture exercises ffprobe/thumbnail; tests use a dedicated queue prefix (env) so the `video-worker` container never consumes test jobs, and the e2e registers the processor in-process and polls until `ready`. Unit tests still mock collaborators.
- **Pros:** proves presigned multipart, `Range`/`206`, retries and FFmpeg for real; follows the existing "real services in integration" convention; deterministic (no container race).
- **Cons:** slower suites; tests depend on the Compose stack being up (already true for Postgres/Mailpit).

### Option B: Storage abstraction with a local-filesystem adapter in tests
- A `StorageService` interface with an FS implementation for tests, S3 for runtime.
- **Pros:** fast, no MinIO needed in tests.
- **Cons:** cannot test presigned URLs, multipart or `Range` semantics — the riskiest parts of the phase would be untested; adds an adapter used only by tests.

### Option C: Mock the queue and storage SDKs
- `jest.mock` of `@aws-sdk/client-s3` / BullMQ.
- **Pros:** fastest.
- **Cons:** mirror tests of SDK calls; contradicts the project rule of using real configured libraries in integration tests.

**Recommendation:** **Option A** — the phase's risk lives in presigned multipart, `Range` delivery, retries and FFmpeg, which only real MinIO/Redis/FFmpeg can prove; an isolated queue prefix plus an in-process processor keeps the e2e deterministic. This overrides the testing guide's filesystem-adapter suggestion for this phase.

**Decision:** A (real MinIO + Redis + FFmpeg in integration/e2e; isolated test queue prefix)

---

## TD-13: Accepted Formats and Upload Validation Policy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Raised by `plan-validate` (MD-1). With TD-04's presigned multipart, the API never sees the bytes, so it cannot inspect the file while it is uploaded: the client *declares* name, size and type at init, and the object only exists in storage after completion. The policy must say which formats are accepted, where validation happens, and how the 10GB limit is enforced when the declared size could be a lie. It is cited by the init DTO, the complete step, the worker and the OpenAPI contract. Depends on TD-04, TD-05, TD-07, TD-10.

**Options:**

### Option A: Declared allowlist at init + real checks at complete and in the worker
- Init accepts only an allowlist of video MIME types / extensions (e.g. `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`) and `size_bytes ≤ 10 GiB`. On complete, the API reads the real object size (`HeadObject`) and rejects/aborts if it exceeds 10 GiB or differs from the declared size. In the worker, `ffprobe` is the authority: no video stream / unreadable container → `failed` with a reason.
- **Pros:** cheap early rejection of obviously wrong files (fast feedback, no wasted upload); the declared-vs-real size check closes the "lie at init" gap; `ffprobe` catches renamed non-video files without any byte inspection in the API.
- **Cons:** the allowlist must be maintained; a file with a valid extension but broken content still uploads fully before failing in the worker.

### Option B: Size-only check at init, worker decides everything else
- Init validates only `size_bytes ≤ 10 GiB`; any type is accepted; `ffprobe` in the worker marks non-videos as `failed`.
- **Pros:** simplest contract; no allowlist to maintain; any container FFmpeg can read is accepted.
- **Cons:** users can upload 10GB of non-video before learning it fails; the real object size is never re-checked, so the 10GB cap can be bypassed by under-declaring.

### Option C: Magic-byte sniffing in the API at complete
- On complete, the API fetches the first bytes of the object (ranged `GetObject`) and checks container signatures before enqueueing.
- **Pros:** rejects non-video content before any worker time is spent.
- **Cons:** duplicates what `ffprobe` already does authoritatively; container signatures are format-specific and incomplete (e.g. MKV/WebM share EBML headers, MP4 variants differ); extra storage round-trip inside a request.

**Recommendation:** **Option A** — a declared allowlist gives immediate feedback without touching the bytes, the `HeadObject` check at complete makes the 10 GiB cap enforceable despite client-declared sizes, and `ffprobe` in the worker (already required by TD-07) is the single authority on "is this really a video", avoiding a second, weaker format detector in the API.

**Decision:** A (MIME/extension allowlist at init + real size check at complete + `ffprobe` authority in worker)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background queue technology | A — BullMQ + Redis (`@nestjs/bullmq@^11`) | **A** |
| TD-02 | Repo-wide | Local S3-compatible storage server image | A — Chainguard MinIO pinned by digest | **A** |
| TD-03 | Backend | Storage layout and access model | A — single private bucket, id-derived keys, presigned only, internal/public endpoints | **A** |
| TD-04 | Backend | Large-file upload protocol (≤10GB, resumable) | A — S3 multipart with presigned part URLs | **A** |
| TD-05 | Backend | Upload completion and processing trigger | A — explicit complete endpoint + enqueue with `jobId = videoId` | **A** |
| TD-06 | Backend | Video worker runtime and deployment | A — same codebase, second entrypoint, own Compose service | **A** |
| TD-07 | Backend | FFmpeg integration for metadata and thumbnail | A — spawn OS-packaged ffprobe/ffmpeg over presigned URL | **A** |
| TD-08 | Backend | Unique video URL identifier | A — 11-char base62 slug (`node:crypto`) + unique index + retry | **A** |
| TD-09 | Backend | Streaming and download delivery | A — API 302 to presigned GET (`Range`/`206` from storage; attachment for download) | **A** |
| TD-10 | Backend | Video status lifecycle and failure handling | A — `draft → processing → ready \| failed`, 3 attempts + backoff | **A** |
| TD-11 | Backend | Access policy for video endpoints in Phase 03 | A — owner-only upload control; public playback of `ready` videos by slug | **A** |
| TD-12 | Backend | Testing strategy for storage, queue and worker | A — real MinIO/Redis/FFmpeg, isolated test queue prefix | **A** |
| TD-13 | Backend | Accepted formats and upload validation policy | A — MIME/extension allowlist at init, real size check at complete, `ffprobe` authority in worker | **A** |
