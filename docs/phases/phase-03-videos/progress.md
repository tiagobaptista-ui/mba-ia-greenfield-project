# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/12 completed

### SI-03.1 — Infra: subir MinIO, Redis e FFmpeg no Compose
- **Status:** completed
- **Tests:** 8 passing (`src/config/env.validation.integration-spec.ts`); ACs verified against the running stack (minio/redis healthy, `minio-init` exit 0, bucket private — anonymous GET 403, `ffprobe` present, `redis-cli ping` → PONG)
- **Observations:**
  - Installed versions: MinIO `RELEASE.2026-09-22T19-25-18Z` (Chainguard image by digest), FFmpeg `5.1.9-0+deb12u1` (Debian 12 apt), Redis `8-alpine` by digest.
  - The Chainguard MinIO image ships `mc` + `bash`, so the healthcheck runs `mc ready local` inside the `minio` container; `minio-init` stays on the shell-less `minio-client` image and runs a single `mb --ignore-existing` once `minio` is healthy (credentials via `MC_HOST_local`).
  - Redis port 6379 is published to the host (debug convenience, same as Postgres/MinIO); services talk to it as `redis`.
  - The TaskCreate tool is not available in this environment; progress.md is the per-SI tracker.

### SI-03.2 — Criar StorageModule (S3/MinIO)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Criar entidade Video e migration CreateVideos
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Criar fila video-processing e VideoProcessingProducer
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Implementar pré-cadastro do vídeo e início do upload
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Implementar assinatura de partes, conclusão, aborto e consulta do upload
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
