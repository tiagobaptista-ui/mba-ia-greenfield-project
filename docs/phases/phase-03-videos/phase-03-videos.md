---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-28T13:52:32-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-28T13:54:12-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T13:50:17-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar no `nestjs-project` o upload de vídeos de até 10GB sem impacto na performance (pré-cadastro automático como rascunho ao iniciar o upload e envio direto ao object storage), o processamento automático em segundo plano por fila e worker (extração de duração e metadados e geração de thumbnail a partir de um frame), a URL única por vídeo sem conflito, a reprodução via streaming sem download completo e o download do vídeo pelo usuário — com o serviço de armazenamento de arquivos, a fila e o worker subindo no Docker Compose.

---

## Step Implementations

<!-- SIs will be written in Phase B -->

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos` (entidade `Video` em `src/videos/entities/video.entity.ts`). Colunas em snake_case literal, seguindo as entidades existentes. O `status` cobre só o ciclo técnico de upload/processamento; publicação/visibilidade fica para a Fase 04 *(per `phase-03-videos/TD-10`, revisão 2026-09-28)*.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK — gerado pela aplicação (`randomUUID()`) antes do `CreateMultipartUpload`, pois compõe a `storage_key` *(per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)* |
| channel_id | uuid | FK → `channels.id`, not null, `ON DELETE CASCADE` |
| slug | varchar(11) | unique, not null — base62 aleatório de 11 caracteres via `node:crypto` *(per `phase-03-videos/TD-08`)* |
| title | varchar(100) | not null — padrão: nome do arquivo sem extensão *(per `phase-03-videos/TD-04`, revisão 2026-09-28)* |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` *(per `phase-03-videos/TD-10`)* |
| original_file_name | varchar(255) | not null |
| content_type | varchar(100) | not null — um dos tipos da allowlist *(per `phase-03-videos/TD-13`)* |
| size_bytes | bigint | not null — tamanho declarado no início do upload, ≤ 10 GiB (10737418240); mapeado para `number` via transformer (cabe em `Number.MAX_SAFE_INTEGER`) *(per `phase-03-videos/TD-13`)* |
| storage_key | varchar(255) | not null — `videos/{id}/original` *(per `phase-03-videos/TD-03`)* |
| upload_id | varchar(255) | nullable — `UploadId` do multipart; limpo (null) ao completar ou abortar *(per `phase-03-videos/TD-04`)* |
| part_size_bytes | integer | not null — tamanho de parte usado no plano de upload (padrão 64 MiB) *(per `phase-03-videos/TD-04`)* |
| part_count | integer | not null — `ceil(size_bytes / part_size_bytes)`, mínimo 1, ≤ 10000 *(per `phase-03-videos/TD-04`)* |
| thumbnail_key | varchar(255) | nullable — `thumbnails/{id}.jpg`, preenchido pelo worker *(per `phase-03-videos/TD-03`, `phase-03-videos/TD-07`)* |
| duration_seconds | double precision | nullable — preenchido pelo worker *(per `phase-03-videos/TD-07`, revisão 2026-09-28)* |
| metadata | jsonb | nullable — `{ container, video_codec, audio_codec, width, height, fps, bitrate }` normalizados do `ffprobe` *(per `phase-03-videos/TD-07`, revisão 2026-09-28)* |
| processing_error | varchar(500) | nullable — motivo do `failed` *(per `phase-03-videos/TD-10`)* |
| created_at | timestamp | not null, default now() (`@CreateDateColumn`) |
| updated_at | timestamp | not null, default now() (`@UpdateDateColumn`) |

**Relations:** `Channel` has many `Video` (one-to-many; `@OneToMany` inverso em `Channel`, `@ManyToOne` + `@JoinColumn({ name: 'channel_id' })` em `Video`).
**Indexes:** unique em `slug`; índice em `channel_id`.

**Storage objects** *(per `phase-03-videos/TD-03`)*: bucket privado único (`S3_BUCKET`, padrão `streamtube-media`); original em `videos/{id}/original`, thumbnail em `thumbnails/{id}.jpg`. Nenhum objeto é público — todo acesso por URL pré-assinada.

### API Contracts

Envelope de erro herdado: `{ statusCode, error, message }` via `DomainExceptionFilter` / `ValidationExceptionFilter` *(per `phase-02-auth/TD-07`)*; documentado com `ApiErrorEnvelope` *(per `openapi-docs-nestjs/TD-01`)*. Rotas autenticadas usam `Authorization: Bearer <access_token>` *(per `phase-02-auth/TD-02`)*.

#### POST /videos (SI-03.7)

Pré-cadastro do vídeo como rascunho + início do multipart upload *(per `phase-03-videos/TD-04`, `phase-03-videos/TD-13`)*.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- file_name: string, required — 1–255 caracteres
- size_bytes: integer, required — ≥ 1
- content_type: string, required — `video/mp4` | `video/webm` | `video/quicktime` | `video/x-matroska`
- title: string, optional — 1–100 caracteres; ausente → nome do arquivo sem extensão

**Response 201:**
- id: string (uuid)
- slug: string (11 caracteres base62)
- title: string
- status: `"draft"`
- part_size_bytes: integer
- part_count: integer

**Error responses:**
- 400 VALIDATION_ERROR: corpo fora do schema
- 400 UNSUPPORTED_VIDEO_FORMAT: `content_type` fora da allowlist ou extensão de `file_name` incompatível
- 400 VIDEO_TOO_LARGE: `size_bytes` > 10737418240 (10 GiB)
- 401 Unauthorized: token ausente ou inválido (JWT guard)
- 429 Too Many Requests: limite global de throttling

---

#### GET /videos/:id/upload/part-urls (SI-03.7)

Assina URLs de `UploadPart` em lote; o cliente envia cada parte **direto ao storage** com `PUT <url>` e guarda o `ETag` da resposta *(per `phase-03-videos/TD-04`, `phase-03-videos/TD-03`)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Request query parameters:**
- part_numbers: string, required — lista separada por vírgula de inteiros únicos, cada um em `1..part_count`, no máximo 100 por requisição

**Response 200:**
- parts: array of `{ part_number: integer, url: string }`
- expires_in_seconds: integer

**Error responses:**
- 400 VALIDATION_ERROR: `id` não é uuid ou `part_numbers` malformado / com mais de 100 itens
- 400 INVALID_PART_NUMBER: algum número fora de `1..part_count`
- 401 Unauthorized: token ausente ou inválido
- 403 VIDEO_ACCESS_DENIED: o vídeo pertence a outro canal
- 404 VIDEO_NOT_FOUND: vídeo inexistente
- 409 INVALID_VIDEO_STATE: vídeo não está em `draft`
- 429 Too Many Requests: limite dedicado de assinatura de partes

---

#### POST /videos/:id/upload/complete (SI-03.7)

Finaliza o multipart, confere o tamanho real e enfileira o processamento *(per `phase-03-videos/TD-05`, `phase-03-videos/TD-13`)*.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required — 1 a 10000 itens `{ part_number: integer ≥ 1, etag: string (não vazia) }`

**Response 202:**
- id: string (uuid)
- slug: string
- title: string
- status: `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: corpo fora do schema ou `id` não é uuid
- 400 INVALID_UPLOAD_PARTS: `part_number`s não cobrem exatamente `1..part_count` ou o storage rejeita as partes/ETags (o vídeo permanece `draft`)
- 400 UPLOAD_SIZE_MISMATCH: tamanho real do objeto (`HeadObject`) difere do declarado ou excede 10 GiB — objeto removido e vídeo marcado `failed`
- 401 Unauthorized: token ausente ou inválido
- 403 VIDEO_ACCESS_DENIED: o vídeo pertence a outro canal
- 404 VIDEO_NOT_FOUND: vídeo inexistente
- 409 INVALID_VIDEO_STATE: vídeo não está em `draft`

---

#### DELETE /videos/:id/upload (SI-03.7)

Aborta um upload em andamento: `AbortMultipartUpload` e remoção do rascunho *(per `phase-03-videos/TD-10`)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content.

**Error responses:**
- 400 VALIDATION_ERROR: `id` não é uuid
- 401 Unauthorized: token ausente ou inválido
- 403 VIDEO_ACCESS_DENIED: o vídeo pertence a outro canal
- 404 VIDEO_NOT_FOUND: vídeo inexistente
- 409 INVALID_VIDEO_STATE: vídeo não está em `draft`

---

#### GET /videos/:id (SI-03.7)

Consulta do dono: estado do upload/processamento e metadados extraídos *(per `phase-03-videos/TD-10`, `phase-03-videos/TD-07`)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: `"draft"` | `"processing"` | `"ready"` | `"failed"`
- original_file_name: string
- content_type: string
- size_bytes: integer
- duration_seconds: number | null
- metadata: `{ container, video_codec, audio_codec, width, height, fps, bitrate }` | null
- has_thumbnail: boolean
- processing_error: string | null
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: `id` não é uuid
- 401 Unauthorized: token ausente ou inválido
- 403 VIDEO_ACCESS_DENIED: o vídeo pertence a outro canal
- 404 VIDEO_NOT_FOUND: vídeo inexistente

---

#### GET /videos/:slug/stream (SI-03.11)

Streaming progressivo: redireciona para GET pré-assinado; o player faz `Range` direto no storage, que responde `206 Partial Content` *(per `phase-03-videos/TD-09`, `phase-03-videos/TD-11`)*.

**Response 302:**
- Location: URL pré-assinada de `GetObject` do original (endpoint público de storage), válida por `S3_PRESIGN_EXPIRES_SECONDS`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo não está `ready`
- 429 Too Many Requests: limite dedicado de reprodução

---

#### GET /videos/:slug/download (SI-03.11)

Download: redireciona para GET pré-assinado com `ResponseContentDisposition: attachment; filename="<original_file_name>"` *(per `phase-03-videos/TD-09`, `phase-03-videos/TD-11`)*.

**Response 302:**
- Location: URL pré-assinada de `GetObject` com `Content-Disposition: attachment`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo não está `ready`
- 429 Too Many Requests: limite dedicado de reprodução

---

#### GET /videos/:slug/thumbnail (SI-03.11)

Thumbnail gerada pelo worker, servida por GET pré-assinado *(per `phase-03-videos/TD-03`, `phase-03-videos/TD-07`)*.

**Response 302:**
- Location: URL pré-assinada de `GetObject` de `thumbnails/{id}.jpg`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente ou vídeo não está `ready`
- 429 Too Many Requests: limite dedicado de reprodução

---

#### Validation Rules — Phase 03 videos

- `file_name`: required, string, 1–255 caracteres; extensão deve ser `.mp4`, `.webm`, `.mov` ou `.mkv` *(per `phase-03-videos/TD-13`)*
- `content_type`: required, um de `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` *(per `phase-03-videos/TD-13`)*
- `size_bytes`: required, inteiro ≥ 1; > 10737418240 → `VIDEO_TOO_LARGE` *(per `phase-03-videos/TD-13`)*
- `title`: optional, string, 1–100 caracteres *(per `phase-03-videos/TD-04`, revisão 2026-09-28)*
- `part_numbers`: required, inteiros únicos separados por vírgula, 1–100 itens *(per `phase-03-videos/TD-04`)*
- `parts[]`: required, 1–10000 itens; `part_number` inteiro ≥ 1; `etag` string não vazia *(per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)*
- `:id`: uuid (`ParseUUIDPipe`); `:slug`: string (lookup por igualdade; inexistente → 404)

### Authorization Matrix

"Owner" = usuário autenticado cujo canal (`ChannelsService`, relação 1:1 usuário↔canal) é o `channel_id` do vídeo *(per `phase-03-videos/TD-11`)*. Todas as rotas são protegidas pelo `JwtAuthGuard` global, exceto as marcadas `@Public()` *(per `phase-02-auth/TD-02`)*.

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ (cria no próprio canal) | ✓ |
| GET /videos/:id/upload/part-urls | ✗ | ✗ (403) | ✓ |
| POST /videos/:id/upload/complete | ✗ | ✗ (403) | ✓ |
| DELETE /videos/:id/upload | ✗ | ✗ (403) | ✓ |
| GET /videos/:id | ✗ | ✗ (403) | ✓ |
| GET /videos/:slug/stream | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`) |
| GET /videos/:slug/download | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`) |
| GET /videos/:slug/thumbnail | ✓ (só `ready`) | ✓ (só `ready`) | ✓ (só `ready`) |

**Throttling** *(per `phase-03-videos/TD-11`, `phase-02-auth/TD-08`)* — o `ThrottlerGuard` global (10 req/60 s) continua valendo; os endpoints abaixo recebem limite próprio via `@Throttle` para não bloquear uploads e players reais:

| Endpoint | Limite |
|----------|--------|
| POST /videos, POST /videos/:id/upload/complete, DELETE /videos/:id/upload | global (10 req/60 s) |
| GET /videos/:id | 60 req/60 s (polling de status) |
| GET /videos/:id/upload/part-urls | 60 req/60 s (até 100 partes por chamada) |
| GET /videos/:slug/stream, /download, /thumbnail | 120 req/60 s |

### Error Catalog

Formato herdado `{ statusCode, error, message }` *(per `phase-02-auth/TD-07`)*. Novas classes em `src/common/exceptions/domain.exception.ts`, estendendo `DomainException`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `id`/`slug` inexistente; ou vídeo não `ready` nas rotas públicas de reprodução |
| VIDEO_ACCESS_DENIED | 403 | usuário autenticado opera vídeo de outro canal |
| INVALID_VIDEO_STATE | 409 | operação de upload (assinar, completar, abortar) fora do status `draft` |
| UNSUPPORTED_VIDEO_FORMAT | 400 | `content_type` fora da allowlist ou extensão de `file_name` incompatível *(per `phase-03-videos/TD-13`)* |
| VIDEO_TOO_LARGE | 400 | `size_bytes` declarado > 10 GiB *(per `phase-03-videos/TD-13`)* |
| INVALID_PART_NUMBER | 400 | `part_numbers` contém número fora de `1..part_count` |
| INVALID_UPLOAD_PARTS | 400 | partes informadas no complete não cobrem `1..part_count` ou o storage rejeita partes/ETags |
| UPLOAD_SIZE_MISMATCH | 400 | tamanho real (`HeadObject`) ≠ declarado ou > 10 GiB no complete *(per `phase-03-videos/TD-13`)* |
| VALIDATION_ERROR | 400 | corpo/parâmetros fora do schema (herdado, `ValidationExceptionFilter`) |

Falhas do worker **não** geram resposta HTTP: são gravadas em `videos.processing_error` com `status = failed` *(per `phase-03-videos/TD-10`)*. `401` (JWT guard) e `429` (throttler) usam o corpo padrão do Nest (`UnauthorizedException` / `ThrottlerException`), como nas fases anteriores.

### Events/Messages

#### video-processing / process-video

Fila BullMQ `video-processing` (Redis), job `process-video` *(per `phase-03-videos/TD-01`)*.

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoProcessingProducer` (chamado por `VideosService.completeUpload` após o `CompleteMultipartUpload` e a transição `draft → processing`) (per `phase-03-videos/TD-05`)
**Consumer:** `VideoProcessor` (`WorkerHost`) no processo/container `video-worker` — lê o original por GET pré-assinado, extrai metadados com `ffprobe`, gera thumbnail com `ffmpeg`, grava a thumbnail no storage e atualiza o vídeo para `ready` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
**Trigger:** upload completado com sucesso em `POST /videos/:id/upload/complete`
**Delivery semantics:** at-least-once — `jobId = videoId` (de-duplicação na fila), `attempts: 3` com backoff exponencial (base 1000 ms), processador idempotente (chave de thumbnail determinística, metadados sobrescritos); `UnrecoverableError` quando o `ffprobe` não encontra stream de vídeo; após a última tentativa o vídeo vai para `failed` com `processing_error` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-13`). Prefixo da fila configurável (`QUEUE_PREFIX`) para isolar testes do worker do Compose (per `phase-03-videos/TD-12`).

---

<!-- phase-a-complete -->

## Dependency Map

<!-- Dep Map will be written in Phase B -->

---

## Deliverables

<!-- Deliverables will be written in Phase B -->
