---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-09-28T13:55:00-03:00"
  bullmq:
    version: "^5.81.5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-28T13:55:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1141.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-28T13:55:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1141.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-28T13:55:00-03:00"
  minio:
    version: "cgr.dev/chainguard/minio@sha256:6a1d0b45c8669726bba580ced0bfa4cb9fdeed1ed636dfabd81d1577beb6937b"
    context7_id: "/minio/minio"
    fetched_at: "2026-09-28T13:55:00-03:00"
  ffmpeg:
    version: "Debian 12 (bookworm) `ffmpeg` package via apt in Dockerfile.dev (node:25.6.0-slim base)"
    context7_id: "/websites/ffmpeg_documentation"
    fetched_at: "2026-09-28T13:55:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T13:50:17-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries (and infrastructure binaries/images) decided in this slice. Pulled via Context7 during `/plan-resolve phase-03-videos`. Re-fetch when the underlying TD changes. Version constraints come from the npm registry on 2026-09-28 and from the installed stack (`nestjs-project/package.json`: Nest 11.1.16, TypeScript 5.9.3, CommonJS build, Jest 30 + ts-jest).

## @nestjs/bullmq

**Source:** `/nestjs/docs.nestjs.com` (Context7, NestJS "Queues" chapter) — High reputation. Maps to `phase-03-videos/TD-01` (A) and `phase-03-videos/TD-06` (A).

**Version pin:** `@nestjs/bullmq@^11.0.5`. Do **not** install `12.x` — `@nestjs/bullmq@12.0.0` is published as `type: module`, which conflicts with this CommonJS build/ts-jest runtime. `11.0.x` peers with `@nestjs/common|core ^10 || ^11` and `bullmq ^3 || ^4 || ^5`.

### Key contracts for Phase 03

- **Root connection (async, from config):** `BullModule.forRootAsync({ imports: [ConfigModule], inject: [...], useFactory: (...) => ({ connection: { host, port } }) })`. In this project inject the namespaced config (`queueConfig.KEY` + `ConfigType<typeof queueConfig>`) instead of `ConfigService.get(...)`, per the inherited `registerAs` convention.
- **Queue registration:** `BullModule.registerQueue({ name: 'video-processing' })` (also `registerQueueAsync` when options depend on config). Registration provides the injection token for producers and consumers.
- **Producer:** `constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}` → `await this.queue.add(name, data, opts)`.
- **Consumer:** `@Processor('video-processing') class VideoProcessor extends WorkerHost { async process(job: Job): Promise<...> }`. Consumers must be registered as `providers` in a module. `process()`'s return value is stored on the job.
- **Separate process:** the worker runs in its own container via a second entrypoint (TD-06); the processor lives only in the worker's module so the API never consumes jobs. (Sandboxed processors — `processors: [path]` in `registerQueue` — lose DI; not used.)

### Testing notes

- Module compilation tests that import a module using `BullModule.registerQueue` must also provide the root `BullModule.forRoot*` (real Redis from Compose, per TD-12).
- Unit-test the processor by calling `process(job)` directly with a real/fake `Job` object (testing guide `artifacts/future-types.md`).

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7) — High reputation, benchmark 88. Maps to `phase-03-videos/TD-01` (A), `phase-03-videos/TD-05` (A), `phase-03-videos/TD-10` (A).

**Version pin:** `bullmq@^5.81.5` (latest 5.x on 2026-09-28; `bullmq@6` exists but is outside `@nestjs/bullmq@11`'s peer range).

### Key contracts for Phase 03

- **Retries/backoff:** `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } })` (or via queue `defaultJobOptions`). BullMQ retries while `attemptsMade + 1 < opts.attempts` and the error is not an `UnrecoverableError`; otherwise the job moves to the failed set (`job.failedReason` = error message).
- **Final-attempt detection:** in the processor, treat the job as terminally failed when `job.attemptsMade + 1 >= (job.opts.attempts ?? 1)` (or react to the worker `failed` event after the last attempt) → set video `failed` + `processing_error` (TD-10).
- **Non-retryable errors:** throw `UnrecoverableError` (e.g. `ffprobe` reports no video stream — TD-13) to skip remaining attempts.
- **De-duplication:** `jobId` option — "the job will be ignored if the ID already exists in the queue". Custom ids must **not contain `:`** and must not be purely numeric → the video UUID is valid (`jobId = videoId`, TD-05).
- **Cleanup:** `removeOnComplete: true`, `removeOnFail: <count>` in `defaultJobOptions` to bound Redis memory.
- **Prefix:** all components accessing the same queue must use the same `prefix`; tests use a distinct prefix so the `video-worker` container never consumes test jobs (TD-12).
- **Graceful shutdown:** `await worker.close()` stops taking new jobs and waits for current ones (no timeout); pair with `app.enableShutdownHooks()` in the worker entrypoint.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7) — High reputation. Maps to `phase-03-videos/TD-03` (A), `phase-03-videos/TD-04` (A), `phase-03-videos/TD-05` (A), `phase-03-videos/TD-13` (A).

**Version pin:** `@aws-sdk/client-s3@^3.1141.0` (dual CJS/ESM, Node ≥ 20).

### Key contracts for Phase 03

- **S3-compatible client:** `new S3Client({ endpoint, forcePathStyle: true, region, credentials: { accessKeyId, secretAccessKey } })` — `forcePathStyle` is required for MinIO. Two instances (TD-03): internal endpoint (`http://minio:9000`) for server-to-storage calls, public endpoint only for presigning client URLs.
- **Multipart:** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `{ UploadId }`; `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` (PartNumber 1–10000, response `ETag`); `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })`; `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`; `ListPartsCommand` for resume.
- **Real size check (TD-13):** `HeadObjectCommand({ Bucket, Key })` → `ContentLength`.
- **Downloads:** `GetObjectCommand({ Bucket, Key, ResponseContentDisposition })` — `ResponseContentDisposition` controls the attachment filename in presigned download URLs (TD-09).
- **Bootstrap:** `CreateBucketCommand` (idempotent handling of "already owned") if bucket creation is done by the app rather than an `mc` init container.
- **S3 limits** (design constraints for TD-04): parts 5 MiB–5 GiB (last part may be smaller), ≤ 10,000 parts, single PUT ≤ 5 GiB.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7, `packages/s3-request-presigner`). Maps to `phase-03-videos/TD-03` (A), `phase-03-videos/TD-04` (A), `phase-03-videos/TD-09` (A).

**Version pin:** `@aws-sdk/s3-request-presigner@^3.1141.0` (keep in lockstep with `client-s3`).

### Key contracts for Phase 03

- `getSignedUrl(client, command, { expiresIn })` → `Promise<string>`; `expiresIn` defaults to **900 s** when omitted.
- Presign `UploadPartCommand` per part (upload), `GetObjectCommand` (stream, TD-09) and `GetObjectCommand` with `ResponseContentDisposition` (download).
- SigV4 binds the host: sign with the **public-endpoint** client so the URL is valid for the client that will use it (TD-03); in the test env the public endpoint is the in-network `http://minio:9000`.

## minio

**Source:** `/minio/minio` (Context7) — High reputation. Maps to `phase-03-videos/TD-02` (A), `phase-03-videos/TD-03` (A).

**Image pin:** `cgr.dev/chainguard/minio@sha256:6a1d0b45c8669726bba580ced0bfa4cb9fdeed1ed636dfabd81d1577beb6937b` (`latest` as of 2026-09-28; entrypoint `/usr/bin/minio`, non-root uid 65532, distroless). Client for bootstrap/healthcheck: `cgr.dev/chainguard/minio-client@sha256:b2bd7824d23d3e3b15bedd7e87fbc3be29d2e213307b4f901e4a1d92356dc20f`.

### Key contracts for Phase 03

- **Server:** `minio server /data --console-address :9001` with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` (API on 9000, console on 9001).
- **Bucket bootstrap:** `mc alias set local http://minio:9000 <user> <password>` then `mc mb --ignore-existing local/<bucket>` from a one-shot init service.
- **Healthcheck:** upstream Compose example uses `mc ready local`; the Chainguard server image is distroless, so run the readiness check from the client image (init service waiting on `mc ready`) rather than inside the server container.
- **Range / 206:** the GET object handler parses `Range` and returns `206 Partial Content` (basis of TD-09 streaming).
- **Stale multipart uploads:** defaults `stale_uploads_expiry = 24h`, `stale_uploads_cleanup_interval = 6h` (abandoned-upload policy in TD-10).
- **CORS for future browser clients (`ETag` exposure):** not covered by the fetched docs — verify at implementation time before relying on a specific env var; not needed by Phase 03's backend tests.

## ffmpeg

**Source:** `/websites/ffmpeg_documentation` (Context7, ffmpeg.org "ffmpeg-all") — High reputation. Maps to `phase-03-videos/TD-07` (A), `phase-03-videos/TD-13` (A).

**Version pin:** OS package — `apt-get install -y ffmpeg` in `nestjs-project/Dockerfile.dev` (base `node:25.6.0-slim`, Debian 12 bookworm). Record the exact installed version (`ffmpeg -version`) in `progress.md` when the SI that installs it runs. No npm wrapper (`fluent-ffmpeg` is deprecated on npm).

### Key contracts for Phase 03

- **Metadata:** `ffprobe -v error -print_format json -show_format -show_streams <input>` → JSON with `format` (e.g. `duration`, `format_name`, `bit_rate`, `size`) and `streams[]` (e.g. `codec_type`, `codec_name`, `width`, `height`, `avg_frame_rate`). No stream with `codec_type: "video"` → not a video (TD-13).
- **Thumbnail:** `ffmpeg -ss <position> -i <input> -frames:v 1 <out>.jpg` — `-ss` **before** `-i` seeks in the input to the closest seek point (fast; no need to decode from the start); `-frames:v 1` writes a single image (TD-07: position ≈ 10% of duration, capped at 60 s).
- **Input:** a short-lived presigned GET URL works as `<input>` (FFmpeg reads over HTTP and seeks with Range), avoiding a local copy of the original.
