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

### SI-03.1 — Infra: subir MinIO, Redis e FFmpeg no Compose

**Description:** Provisiona o object storage S3 (MinIO) com bucket privado, o Redis da fila e o FFmpeg na imagem de desenvolvimento, com as chaves de configuração validadas — a base de infraestrutura de toda a fase.

**Technical actions:**

1. Em `nestjs-project/compose.yaml`, adicionar `minio` (`cgr.dev/chainguard/minio@sha256:6a1d0b45c8669726bba580ced0bfa4cb9fdeed1ed636dfabd81d1577beb6937b`, `server /data --console-address :9001`, portas 9000/9001, volume `minio-data`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`), o one-shot `minio-init` (`cgr.dev/chainguard/minio-client@sha256:b2bd7824d23d3e3b15bedd7e87fbc3be29d2e213307b4f901e4a1d92356dc20f`: aguarda `mc ready`, `mc alias set`, `mc mb --ignore-existing` do bucket) e `redis` (`redis:8-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0`, `--appendonly yes`, healthcheck `redis-cli ping`, volume `redis-data`); `nestjs-api` passa a depender de `redis` (healthy) e `minio-init` (completed successfully) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-01`)
2. Em `nestjs-project/Dockerfile.dev`, instalar o pacote `ffmpeg` via `apt-get` (fornece `ffprobe` e `ffmpeg`) (per `phase-03-videos/TD-07`)
3. Criar `src/config/storage.config.ts` (`registerAs('storage')`: `endpoint`, `publicEndpoint`, `region`, `accessKey`, `secretKey`, `bucket`, `presignExpiresSeconds`, `uploadPartSizeBytes`) e `src/config/queue.config.ts` (`registerAs('queue')`: `host`, `port`, `prefix`), carregados no `ConfigModule.forRoot` do `AppModule` (per `phase-01-configuracao-base/TD-03`, `phase-03-videos/TD-03`, `phase-03-videos/TD-01`)
4. Estender `src/config/env.validation.ts` (Joi) com `S3_ENDPOINT` (padrão `http://minio:9000`), `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY` e `S3_SECRET_KEY` (obrigatórias), `S3_BUCKET` (padrão `streamtube-media`), `S3_PRESIGN_EXPIRES_SECONDS` (padrão 3600), `UPLOAD_PART_SIZE_BYTES` (padrão 67108864), `REDIS_HOST` (padrão `redis`), `REDIS_PORT` (padrão 6379), `QUEUE_PREFIX` (padrão `streamtube`), e documentá-las em `.env.example` — hosts internos sempre pelo nome do serviço; `S3_PUBLIC_ENDPOINT` é a única URL voltada ao cliente (per `phase-01-configuracao-base/TD-02`, `phase-03-videos/TD-03`)
5. Criar `test/set-test-env.ts` (primeiro item de `setupFiles` em `package.json` e `test/jest-e2e.json`, antes de `dotenv/config`) definindo `QUEUE_PREFIX=streamtube-test` e `S3_PUBLIC_ENDPOINT=http://minio:9000`, para que os testes não disputem jobs com o worker do Compose e consigam usar URLs pré-assinadas de dentro do container (per `phase-03-videos/TD-12`, `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (chaves de storage e fila) | Integration: obrigatórias rejeitadas quando ausentes, padrões aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` em `nestjs-project/` deixa `redis` saudável, `minio` em execução e `minio-init` concluído com código 0
- O bucket `S3_BUCKET` existe no MinIO após a subida e um GET anônimo de objeto retorna `403`
- `docker compose exec nestjs-api ffprobe -version` imprime a versão do FFmpeg
- Validar o ambiente sem `S3_ACCESS_KEY` falha com erro que cita a chave
- `docker compose exec redis redis-cli ping` responde `PONG`

---

### SI-03.2 — Criar StorageModule (S3/MinIO)

**Description:** Encapsula todo o acesso ao object storage num serviço próprio — multipart, objetos e URLs pré-assinadas — para que vídeos e worker nunca falem com o SDK diretamente.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3@^3.1141.0` e `@aws-sdk/s3-request-presigner@^3.1141.0`; criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` com dois `S3Client` (`forcePathStyle: true`, credenciais de `storageConfig`): **interno** (`storage.endpoint`) para chamadas servidor→storage e **público** (`storage.publicEndpoint`) apenas para assinar URLs entregues a clientes (per `phase-03-videos/TD-03`)
2. Métodos de multipart: `createMultipartUpload(key, contentType)` → `uploadId`; `presignUploadPart(key, uploadId, partNumber)`; `completeMultipartUpload(key, uploadId, parts)`; `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
3. Métodos de objeto: `headObjectSize(key)`, `putObject(key, body, contentType)`, `deleteObject(key)`; `presignGetObject(key, { downloadFileName? })` (cliente público; `ResponseContentDisposition: attachment; filename="…"` quando `downloadFileName` é informado) e `presignInternalGetObject(key)` (cliente interno, usado pelo FFmpeg no worker); todos com `expiresIn = storage.presignExpiresSeconds` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-07`, `phase-03-videos/TD-13`)
4. Criar `src/storage/storage.constants.ts` com os prefixos `videos/` e `thumbnails/` e os helpers `videoOriginalKey(id)` → `videos/{id}/original` e `videoThumbnailKey(id)` → `thumbnails/{id}.jpg` (per `phase-03-videos/TD-03`)
5. Criar `src/test/storage.ts` (helpers de teste: remover objetos por prefixo e enviar partes via `fetch` nas URLs pré-assinadas)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: MinIO real — multipart em 2 partes via `PUT` pré-assinado, complete, `headObjectSize`, abort; GET pré-assinado com `Range` → `206`; download com `Content-Disposition: attachment` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — MinIO, bucket e `storageConfig` precisam existir

**Acceptance criteria:**

- Um arquivo enviado em 2 partes por `PUT` nas URLs pré-assinadas e completado resulta num objeto com o tamanho exato no bucket
- `GET` na URL pré-assinada de leitura com `Range: bytes=0-99` retorna `206` com `Content-Range` e 100 bytes
- A URL pré-assinada de download responde com `Content-Disposition: attachment; filename="<nome informado>"`
- URLs entregues a clientes usam o host de `S3_PUBLIC_ENDPOINT`; chamadas servidor→storage usam `S3_ENDPOINT`
- Abortar um multipart invalida o `uploadId` (um `UploadPart` posterior falha)

---

### SI-03.3 — Criar entidade Video e migration CreateVideos

**Description:** Materializa a tabela `videos` ligada ao canal, com status, chaves de storage, metadados e o slug único — o modelo persistente de toda a fase.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme o Data Model (`@Entity('videos')`; enum TS `VideoStatus` com valores `draft`/`processing`/`ready`/`failed`; `size_bytes` `bigint` com transformer para `number`; `metadata` `jsonb`; `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })` com `onDelete: 'CASCADE'`; `@Index` em `channel_id`; `slug` `unique`) (per `phase-03-videos/TD-08`, `phase-03-videos/TD-10`, `phase-03-videos/TD-07`)
2. Adicionar o lado inverso `@OneToMany(() => Video, (video) => video.channel) videos` em `src/channels/entities/channel.entity.ts`
3. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` com `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL (tabela, `videos_status_enum`, `UQ` de `slug`, `IDX` de `channel_id`, FK `ON DELETE CASCADE`; `down()` removendo FK, índice, tabela e enum)
4. Atualizar `src/database/migrations.integration-spec.ts` (migration na lista explícita, `videos` em `MANAGED_TABLES`, `videos_status_enum` em `MANAGED_ENUM_TYPES`) e `cleanAllTables` em `src/test/create-test-data-source.ts` (apagar `videos` antes de `channels`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `slug` único, default `draft`, enum inválido rejeitado, `ON DELETE CASCADE` a partir do canal, `size_bytes` de 10 GiB lido como número | `src/videos/entities/video.entity.integration-spec.ts` |
| `CreateVideos` migration | Integration: up cria `videos` + enum; revert remove ambos | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none — depende apenas de `channels` (Fase 02)

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` e o tipo `videos_status_enum`; `npm run migration:revert` remove ambos
- Inserir dois vídeos com o mesmo `slug` viola a constraint única
- Um vídeo inserido sem `status` fica com `draft`
- Remover um canal remove seus vídeos
- `size_bytes` = 10737418240 é persistido e lido de volta como o número 10737418240

---

### SI-03.4 — Criar fila video-processing e VideoProcessingProducer

**Description:** Registra a fila BullMQ sobre o Redis e o produtor do job `process-video`, com retries e de-duplicação definidos no Events/Messages.

**Technical actions:**

1. Instalar `@nestjs/bullmq@^11.0.5` e `bullmq@^5.81.5` (não usar `@nestjs/bullmq@12`, publicado como ESM) (per `phase-03-videos/TD-01`)
2. Criar `src/queue/queue.constants.ts` (`VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`) e `src/queue/queue.types.ts` (`ProcessVideoJobData = { videoId: string }`)
3. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync` (conexão e `prefix` de `queueConfig`) e `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` com `defaultJobOptions` `{ attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: 1000 }`; exportar `BullModule` e o produtor (per `phase-03-videos/TD-01`, `phase-03-videos/TD-10`)
4. Criar `src/queue/video-processing.producer.ts` — `enqueueVideoProcessing(videoId)` → `queue.add(PROCESS_VIDEO_JOB, { videoId }, { jobId: videoId })` (per `phase-03-videos/TD-05`)
5. Criar `src/test/queue.ts` (helper de teste: `obliterate` da fila no prefixo de teste)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration: Redis real — job `process-video` em `waiting` com `{ videoId }`, `jobId = videoId`, `attempts: 3` e backoff exponencial; segunda chamada com o mesmo id não cria outro job | `src/queue/video-processing.producer.integration-spec.ts` |
| `QueueModule` | Unit: compilation | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1 — Redis e `queueConfig`

**Acceptance criteria:**

- Enfileirar um vídeo cria um job `process-video` na fila `video-processing` com payload `{ videoId }` e `jobId` igual ao id do vídeo
- Enfileirar o mesmo vídeo duas vezes resulta em um único job
- O job é criado com 3 tentativas e backoff exponencial de base 1000 ms
- As chaves da fila no Redis usam o prefixo configurado em `QUEUE_PREFIX`

---

### SI-03.5 — Implementar pré-cadastro do vídeo e início do upload

**Description:** Cria o vídeo como rascunho no canal do usuário, com slug único, e abre o multipart upload no storage — o primeiro passo do protocolo de upload direto.

**Technical actions:**

1. Criar `src/videos/slug.util.ts` — `generateVideoSlug()`: 11 caracteres `[0-9A-Za-z]` a partir de `crypto.randomBytes` (per `phase-03-videos/TD-08`)
2. Criar `src/videos/videos.constants.ts` (allowlist `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` e extensões `.mp4`, `.webm`, `.mov`, `.mkv`; `MAX_VIDEO_SIZE_BYTES = 10737418240`; `MAX_PART_URLS_PER_REQUEST = 100`; `SLUG_MAX_RETRIES`) e as exceções do Error Catalog (`VideoNotFoundException`, `VideoAccessDeniedException`, `InvalidVideoStateException`, `UnsupportedVideoFormatException`, `VideoTooLargeException`, `InvalidPartNumberException`, `InvalidUploadPartsException`, `UploadSizeMismatchException`) em `src/common/exceptions/domain.exception.ts` (per `phase-03-videos/TD-13`)
3. Adicionar `findByUserId(userId)` em `src/channels/channels.service.ts` (o vídeo pertence ao canal do usuário; acesso ao `Channel` só via `ChannelsService`)
4. Criar `src/videos/dto/create-video.dto.ts` (`file_name`, `size_bytes`, `content_type`, `title?` — per Validation Rules) e `VideosService.initiateUpload(userId, dto)` em `src/videos/videos.service.ts`: valida formato (`UNSUPPORTED_VIDEO_FORMAT`) e tamanho (`VIDEO_TOO_LARGE`), aplica o título padrão (nome do arquivo sem extensão), gera `id` com `randomUUID()`, calcula `part_size_bytes`/`part_count`, chama `StorageService.createMultipartUpload(videoOriginalKey(id), content_type)` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-13`)
5. Persistir o vídeo `draft` com `upload_id` em `dataSource.transaction`, com retry de `slug` em violação `23505` usando SAVEPOINT por tentativa (padrão de `ChannelsService.createChannel`); se a persistência falhar, chamar `abortMultipartUpload` e relançar (per `phase-03-videos/TD-08`, `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: formato inválido, tamanho > 10 GiB, título padrão, cálculo de `part_count`, retry de slug, compensação (abort do multipart quando a persistência falha) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: DB + MinIO reais — rascunho persistido com `upload_id` e multipart aberto em `videos/{id}/original` | `src/videos/videos.service.integration-spec.ts` |
| `generateVideoSlug` | Unit: 11 caracteres base62 | `src/videos/slug.util.spec.ts` |
| `ChannelsService.findByUserId` | Integration: canal do usuário encontrado; usuário sem canal → `null` | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — `StorageService`; SI-03.3 — entidade `Video`

**Acceptance criteria:**

- Iniciar o upload de um `.mp4` válido cria um vídeo `draft` no canal do usuário com `slug` de 11 caracteres base62
- Sem `title`, o vídeo recebe o nome do arquivo sem extensão como título
- O multipart é aberto em `videos/{id}/original` e o `upload_id` fica gravado no vídeo
- `size_bytes` = 10737418241 é rejeitado com `VIDEO_TOO_LARGE`, sem criar vídeo nem multipart
- `content_type` `application/pdf` ou arquivo `.txt` é rejeitado com `UNSUPPORTED_VIDEO_FORMAT`
- `part_count` = `ceil(size_bytes / part_size_bytes)`, com mínimo 1
- Uma colisão de `slug` é resolvida com um novo slug, sem erro para o usuário

---

### SI-03.6 — Implementar assinatura de partes, conclusão, aborto e consulta do upload

**Description:** Completa o protocolo de upload no serviço — assinar partes em lote, finalizar com checagem de tamanho real e enfileiramento, abortar e consultar — com as regras de dono e de estado.

**Technical actions:**

1. `VideosService.findOwnedVideo(userId, id)` — vídeo inexistente → `VIDEO_NOT_FOUND`; canal diferente do canal do usuário → `VIDEO_ACCESS_DENIED`; e `getOwnedVideo(userId, id)` mapeando a resposta de `GET /videos/:id` (inclui `has_thumbnail`) (per `phase-03-videos/TD-11`)
2. `VideosService.signPartUrls(userId, id, partNumbers)` — exige `draft` (`INVALID_VIDEO_STATE`), valida cada número em `1..part_count` (`INVALID_PART_NUMBER`) e devolve `{ part_number, url }` de `StorageService.presignUploadPart` + `expires_in_seconds` (per `phase-03-videos/TD-04`)
3. `VideosService.completeUpload(userId, id, parts)` — exige `draft`; `part_number`s devem cobrir exatamente `1..part_count` (`INVALID_UPLOAD_PARTS`); `completeMultipartUpload` (rejeição do storage → `INVALID_UPLOAD_PARTS`, vídeo continua `draft`); `headObjectSize` ≠ `size_bytes` ou > 10 GiB → `deleteObject`, vídeo `failed` com `processing_error` e `UPLOAD_SIZE_MISMATCH`; senão `status = processing`, `upload_id = null` e `VideoProcessingProducer.enqueueVideoProcessing(id)` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-13`, `phase-03-videos/TD-10`)
4. `VideosService.abortUpload(userId, id)` — exige `draft`; `abortMultipartUpload` e remoção do rascunho (per `phase-03-videos/TD-10`)
5. DTOs `src/videos/dto/complete-upload.dto.ts` (`parts[]` com `@ValidateNested` + `@Type`, 1–10000 itens) e `src/videos/dto/part-urls-query.dto.ts` (`part_numbers` convertido com `@Transform` de lista separada por vírgula para `number[]`, 1–100 itens únicos) — per Validation Rules

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (`findOwnedVideo`, `signPartUrls`, `completeUpload`, `abortUpload`) | Unit: dono vs. outro canal, estado fora de `draft`, cobertura de partes, mismatch de tamanho, enfileiramento só no sucesso | `src/videos/videos.service.spec.ts` |
| `VideosService` (`completeUpload`, `abortUpload`) | Integration: DB + MinIO + Redis reais — partes enviadas por `PUT` pré-assinado, complete, job na fila; abort remove rascunho e multipart | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 — produtor da fila; SI-03.5 — rascunho e multipart criados no início do upload

**Acceptance criteria:**

- Completar um upload cujas partes foram enviadas deixa o vídeo `processing`, com `upload_id` nulo, e um job `process-video` na fila com o id do vídeo
- Completar com partes que não cobrem `1..part_count` falha com `INVALID_UPLOAD_PARTS` e o vídeo continua `draft`
- Completar quando o tamanho real difere do declarado remove o objeto e deixa o vídeo `failed` com `UPLOAD_SIZE_MISMATCH`
- Assinar partes fora de `1..part_count` falha com `INVALID_PART_NUMBER`
- Operar o vídeo de outro canal falha com `VIDEO_ACCESS_DENIED`; operar vídeo fora de `draft` falha com `INVALID_VIDEO_STATE`
- Abortar remove o rascunho e invalida o multipart

---

### SI-03.7 — Expor endpoints de upload (VideosController + VideosModule)

**Route:** POST /videos, GET /videos/:id/upload/part-urls, POST /videos/:id/upload/complete, DELETE /videos/:id/upload, GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`
**Authorization:** Authenticated (criar) / Owner (demais) — per `### Authorization Matrix`

**Description:** Publica o protocolo de upload via HTTP conforme o `### API Contracts`, com autenticação, limites de throttling e documentação OpenAPI, e liga o módulo de vídeos na aplicação.

**Technical actions:**

1. Criar `src/videos/videos.controller.ts` (`@Controller('videos')`) com os 5 endpoints e status `201` / `200` / `202` / `204` / `200` conforme `### API Contracts`, usando `@CurrentUser()` e `ParseUUIDPipe`, delegando tudo ao `VideosService` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
2. Aplicar `@Throttle({ default: { limit: 60, ttl: 60000 } })` em `GET /videos/:id/upload/part-urls` e `GET /videos/:id`; os demais herdam o limite global (per `phase-03-videos/TD-11`, `phase-02-auth/TD-08`)
3. Documentar com `@ApiTags('videos')`, `@ApiBearerAuth('access-token')`, `@ApiOperation` e um `@ApiResponse` por status, erros referenciando `ApiErrorEnvelope` via `getSchemaPath` (per `openapi-docs-nestjs/TD-01`)
4. Criar `src/videos/videos.module.ts` (imports `TypeOrmModule.forFeature([Video])`, `StorageModule`, `QueueModule`, `ChannelsModule`; controller; provider `VideosService`; export `VideosService`) e registrá-lo no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit: compilation (TypeORM feature + Bull + Storage) | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.6 — `VideosService` completo para o upload

**Acceptance criteria:**

- `POST /videos` com corpo válido e token retorna `201` com `id`, `slug`, `title`, `status: "draft"`, `part_size_bytes` e `part_count`
- `POST /videos` sem token retorna `401`; com `content_type` fora da allowlist retorna `400` com `error: "UNSUPPORTED_VIDEO_FORMAT"`; com corpo inválido retorna `400` com `error: "VALIDATION_ERROR"`
- `GET /videos/:id/upload/part-urls?part_numbers=1,2` pelo dono retorna `200` com 2 URLs; por outro usuário retorna `403` com `error: "VIDEO_ACCESS_DENIED"`
- `POST /videos/:id/upload/complete` com as partes enviadas retorna `202` com `status: "processing"`
- `DELETE /videos/:id/upload` num rascunho retorna `204`; num vídeo `processing` retorna `409` com `error: "INVALID_VIDEO_STATE"`
- `GET /videos/:id` pelo dono retorna `200` com `status` e `metadata`; `id` inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:id/upload/part-urls` aceita 30 chamadas em um minuto sem `429`

---

### SI-03.8 — Implementar FfmpegService (metadados e thumbnail)

**Description:** Isola a integração com o FFmpeg num serviço de mídia — sondagem de metadados e extração de um frame — usado pelo worker.

**Technical actions:**

1. Criar `src/media/media.module.ts` e `src/media/ffmpeg.service.ts` com `probe(input)`: executa `ffprobe -v error -print_format json -show_format -show_streams <input>` via `child_process.spawn` com timeout e normaliza para `{ duration_seconds, metadata: { container, video_codec, audio_codec, width, height, fps, bitrate } }` (per `phase-03-videos/TD-07`, revisão 2026-09-28)
2. Sem stream `codec_type: "video"` ou ffprobe falhando ao ler o container → lançar `InvalidMediaError` (erro de mídia, não HTTP) (per `phase-03-videos/TD-13`)
3. `extractFrame(input, positionSeconds, outputPath)` — `ffmpeg -ss <pos> -i <input> -frames:v 1 -y <outputPath>` (JPEG); e `thumbnailPosition(durationSeconds)` = 10% da duração, limitado a 60 s (per `phase-03-videos/TD-07`)
4. Criar `src/test/video-fixture.ts` — gera um clipe curto (`ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=25` + áudio `sine`) em diretório temporário para os testes

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Unit: normalização do JSON do ffprobe (vídeo com/sem áudio, sem stream de vídeo) e `thumbnailPosition` | `src/media/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration: ffprobe/ffmpeg reais no clipe gerado; arquivo de texto → `InvalidMediaError` | `src/media/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg instalado na imagem

**Acceptance criteria:**

- Sondar o clipe gerado de 3 s retorna `duration_seconds` ≈ 3 e `metadata` com `video_codec`, `width` = 320, `height` = 240 e `fps` = 25
- Sondar um arquivo de texto falha com `InvalidMediaError`
- Extrair um frame gera um arquivo JPEG não vazio
- `thumbnailPosition(3)` = 0,3 s e `thumbnailPosition(3600)` = 60 s

---

### SI-03.9 — Implementar VideoProcessor (processamento em segundo plano)

**Description:** Consome o job `process-video`, extrai duração e metadados, gera e grava a thumbnail e leva o vídeo a `ready` — ou a `failed` quando as tentativas se esgotam.

**Technical actions:**

1. Adicionar ao `VideosService` os métodos de ciclo do worker: `findForProcessing(id)`, `markProcessed(id, { duration_seconds, metadata, thumbnail_key })` (`status = ready`) e `markFailed(id, reason)` (`status = failed`, `processing_error` truncado em 500) (per `phase-03-videos/TD-10`)
2. Criar `src/worker/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`; `process(job)`: ignora vídeo inexistente ou fora de `processing`; lê o original por `StorageService.presignInternalGetObject`; `FfmpegService.probe`; `extractFrame` em `thumbnailPosition(duration)` num arquivo temporário; `StorageService.putObject(videoThumbnailKey(id), …, 'image/jpeg')`; `markProcessed` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
3. Tratamento de falhas: `InvalidMediaError` → `markFailed` e relançar como `UnrecoverableError` (sem novas tentativas); outras falhas → na última tentativa (`job.attemptsMade + 1 >= job.opts.attempts`) `markFailed` e relançar, nas anteriores só relançar (retry com backoff); o arquivo temporário é removido em `finally` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit: vídeo fora de `processing` ignorado; mídia inválida → `failed` + `UnrecoverableError`; falha na tentativa 1/3 relança sem marcar; falha na tentativa 3/3 → `failed` | `src/worker/video.processor.spec.ts` |
| `VideoProcessor` | Integration: DB + MinIO + FFmpeg reais — clipe enviado vira `ready` com duração, metadados e thumbnail no storage; arquivo de texto vira `failed` | `src/worker/video.processor.integration-spec.ts` |
| `VideosService` (`markProcessed`, `markFailed`) | Integration: transições persistidas | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — storage; SI-03.4 — fila; SI-03.6 — vídeos em `processing`; SI-03.8 — `FfmpegService`

**Acceptance criteria:**

- Processar um vídeo `processing` com clipe válido o deixa `ready` com `duration_seconds`, `metadata` e `thumbnail_key` = `thumbnails/{id}.jpg`, e o objeto da thumbnail existe no storage
- Processar um vídeo cujo arquivo não é vídeo o deixa `failed` com `processing_error` na primeira tentativa, sem retries
- Uma falha transitória na tentativa 1 de 3 mantém o vídeo `processing` e o job é reagendado com backoff
- Quando a 3ª tentativa falha, o vídeo fica `failed` com `processing_error`
- Reprocessar um job de vídeo já `ready` não altera o vídeo

---

### SI-03.10 — Criar entrypoint do worker e serviço video-worker no Compose

**Description:** Roda o `VideoProcessor` num processo e container próprios, sem servidor HTTP, subindo junto com a stack do backend.

**Technical actions:**

1. Criar `src/worker/worker.module.ts` — `ConfigModule` (mesmos `load` + `envValidationSchema`), `TypeOrmModule.forRootAsync` (via `databaseConfig`), `QueueModule`, `StorageModule`, `MediaModule`, `VideosModule` e o provider `VideoProcessor`; sem controllers (per `phase-03-videos/TD-06`, `phase-01-configuracao-base/TD-04`)
2. Criar `src/main-worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `app.enableShutdownHooks()` (fecha o worker BullMQ de forma graciosa) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-01`)
3. Adicionar scripts `start:worker` (`node dist/main-worker`) e `start:worker:dev` (`nest start --watch --entryFile main-worker`) em `package.json`
4. Adicionar o serviço `video-worker` em `nestjs-project/compose.yaml` — mesma build do `nestjs-api`, bind mount do projeto, `command: npm run start:worker:dev`, `restart: unless-stopped`, `depends_on` `db` (healthy), `redis` (healthy) e `minio-init` (completed successfully), sem portas publicadas (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation — resolve `VideoProcessor` e não registra controllers | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.9 — `VideoProcessor`

**Acceptance criteria:**

- `docker compose up -d` em `nestjs-project/` deixa `video-worker` em execução junto com `nestjs-api`, `db`, `mailpit`, `minio` e `redis`
- O `video-worker` não publica portas nem responde HTTP
- Com o `video-worker` ativo, completar um upload pela API leva o vídeo a `ready` sem nenhuma ação manual
- `docker compose logs video-worker` registra o processamento do job `process-video` com o id do vídeo

---

### SI-03.11 — Expor streaming, download e thumbnail (endpoints públicos)

**Route:** GET /videos/:slug/stream, GET /videos/:slug/download, GET /videos/:slug/thumbnail
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** Anonymous (somente vídeos `ready`) — per `### Authorization Matrix`

**Description:** Entrega a reprodução sem download completo e o download do vídeo pela URL única, redirecionando para o storage, que atende `Range` com `206`.

**Technical actions:**

1. `VideosService.getPlaybackUrl(slug, kind)` com `kind` ∈ `stream` / `download` / `thumbnail` — busca por `slug`, exige `ready` (senão `VIDEO_NOT_FOUND`) e devolve `StorageService.presignGetObject` do original, do original com `downloadFileName = original_file_name` (sanitizado para o header) ou da thumbnail (per `phase-03-videos/TD-09`, `phase-03-videos/TD-11`)
2. Adicionar ao `VideosController` os três endpoints com `@Public()`, resposta `302` com `Location` (via `@Redirect()` retornando `{ url }`) e `@Throttle({ default: { limit: 120, ttl: 60000 } })` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-11`)
3. Documentar com `@ApiOperation`, `@ApiResponse` `302` (header `Location`) e `404` com `ApiErrorEnvelope` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackUrl` | Unit: `ready` vs. demais status, slug inexistente, attachment com nome original | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.7 — `VideosController`/`VideosModule`; SI-03.9 — vídeos chegam a `ready` com thumbnail

**Acceptance criteria:**

- `GET /videos/:slug/stream` de um vídeo `ready`, sem token, retorna `302`; seguir a `Location` com `Range: bytes=0-1023` retorna `206` com `Content-Range`
- `GET /videos/:slug/download` retorna `302` e a `Location` responde com `Content-Disposition: attachment; filename="<original_file_name>"`
- `GET /videos/:slug/thumbnail` retorna `302` para um JPEG
- As três rotas retornam `404` com `error: "VIDEO_NOT_FOUND"` para slug inexistente ou vídeo `draft`, `processing` ou `failed`
- As três rotas aceitam 30 requisições em um minuto sem `429`
- Pré-cadastro → envio das partes → complete → processamento → `ready` → stream com `206` funciona ponta a ponta

---

### SI-03.12 — Sincronizar contrato OpenAPI e documentar a fase

**Description:** Mantém o contrato consumido pelo frontend e a documentação de IA coerentes com o código entregue pela fase.

**Technical actions:**

1. Rodar `npm run openapi:export` no `nestjs-project` e commitar o `openapi.json` com os paths de vídeos (per `openapi-docs-nestjs/TD-02`)
2. Rodar `bash scripts/sync-openapi.sh` (host) e `npm run openapi:types` no `next-frontend`, commitando `next-frontend/openapi.json` e `lib/api/types.gen.ts` juntos (per `next-frontend-openapi-typing/TD-02`, `next-frontend-openapi-typing/TD-03`)
3. Atualizar `nestjs-project/CLAUDE.md` e o `CLAUDE.md` raiz com a seção de vídeos — módulos (`videos`, `storage`, `queue`, `media`, `worker`), endpoints, fila/worker, storage (bucket, endpoints interno/público), variáveis de ambiente e como subir/testar o worker — citando apenas arquivos e comandos existentes
4. Atualizar `docs/diagrams/software-arch.mermaid` (Message Queue: Redis/BullMQ; Object Storage: MinIO) e o status da Fase 03 no `README.md`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `exportSpec` | Integration: a spec exportada contém os paths de `/videos` | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.7, SI-03.10, SI-03.11 — todos os endpoints e o worker existem

**Acceptance criteria:**

- `nestjs-project/openapi.json` e `next-frontend/openapi.json` são idênticos e contêm os 8 endpoints de vídeos
- Rodar `npm run openapi:types` de novo não gera diff em `next-frontend/lib/api/types.gen.ts`
- Os `CLAUDE.md` (raiz e `nestjs-project/`) descrevem vídeos, fila, worker e storage apenas com arquivos, endpoints e comandos que existem
- O diagrama C4 identifica a fila como Redis (BullMQ) e o storage como MinIO

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

## Dependency Map

```
SI-03.1 (root — infra: MinIO, Redis, FFmpeg, config)
├── SI-03.2 — depends on SI-03.1 (storage precisa do MinIO/bucket e do storageConfig)
│   └── SI-03.5 — depends on SI-03.2 + SI-03.3 (pré-cadastro abre o multipart e persiste o Video)
│       └── SI-03.6 — depends on SI-03.5 + SI-03.4 (complete enfileira o processamento)
│           ├── SI-03.7 — depends on SI-03.6 (endpoints de upload expõem o serviço)
│           │   └── SI-03.11 — depends on SI-03.7 + SI-03.9 (endpoints públicos no mesmo controller; vídeos ready)
│           └── SI-03.9 — depends on SI-03.6 + SI-03.2 + SI-03.4 + SI-03.8 (worker consome o job e usa storage + FFmpeg)
│               └── SI-03.10 — depends on SI-03.9 (entrypoint e container do worker)
├── SI-03.4 — depends on SI-03.1 (fila precisa do Redis e do queueConfig)
└── SI-03.8 — depends on SI-03.1 (FfmpegService precisa do FFmpeg na imagem)
SI-03.3 (root, independent — entidade Video sobre channels da Fase 02)
SI-03.12 — depends on SI-03.7 + SI-03.10 + SI-03.11 (contrato OpenAPI e docs refletem endpoints e worker finais)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: subir MinIO, Redis e FFmpeg no Compose
- [ ] SI-03.2 — Criar StorageModule (S3/MinIO)
- [ ] SI-03.3 — Criar entidade Video e migration CreateVideos
- [ ] SI-03.4 — Criar fila video-processing e VideoProcessingProducer
- [ ] SI-03.5 — Implementar pré-cadastro do vídeo e início do upload
- [ ] SI-03.6 — Implementar assinatura de partes, conclusão, aborto e consulta do upload
- [ ] SI-03.7 — Expor endpoints de upload (VideosController + VideosModule)
- [ ] SI-03.8 — Implementar FfmpegService (metadados e thumbnail)
- [ ] SI-03.9 — Implementar VideoProcessor (processamento em segundo plano)
- [ ] SI-03.10 — Criar entrypoint do worker e serviço video-worker no Compose
- [ ] SI-03.11 — Expor streaming, download e thumbnail (endpoints públicos)
- [ ] SI-03.12 — Sincronizar contrato OpenAPI e documentar a fase

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Stack sobe completa (`cd nestjs-project && docker compose up -d && docker compose ps` — `nestjs-api`, `db`, `mailpit`, `minio`, `redis`, `video-worker` em execução; `minio-init` concluído)
