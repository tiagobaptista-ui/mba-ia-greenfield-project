---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-upload.e2e-spec.ts
---

# Video Upload Endpoints Test Plan

## Application Overview

Endpoints autenticados que implementam o protocolo de upload direto ao storage (TD-04/TD-05): `POST /videos` pré-cadastra o vídeo como rascunho e abre o multipart; `GET /videos/:id/upload/part-urls` assina URLs de `UploadPart` em lote; o cliente envia as partes direto ao MinIO; `POST /videos/:id/upload/complete` finaliza, confere o tamanho real e enfileira o processamento; `DELETE /videos/:id/upload` aborta; `GET /videos/:id` consulta o estado. Tudo contra Postgres, MinIO e Redis reais do Compose (TD-12), com o prefixo de fila de teste.

## Test Scenarios

### 1. POST /videos — pré-cadastro

**Setup:** `beforeEach` `cleanAllTables` + `ThrottlerStorage.storage.clear()`; `Test.createTestingModule({ imports: [AppModule] })` com `ValidationPipe` e filtros de `main.ts` reaplicados; usuário registrado, confirmado e logado (access token) via fluxo de auth.

#### 1.1. create-draft-video-success

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. POST /videos com token e body `{ file_name: "meu-video.mp4", size_bytes: 1048576, content_type: "video/mp4" }`
    - expect: status 201
    - expect: body contém `id` (uuid), `slug` com 11 caracteres `[0-9A-Za-z]`, `title: "meu-video"`, `status: "draft"`, `part_size_bytes` e `part_count: 1`
    - expect: existe linha em `videos` com esse `id`, `status = draft` e `upload_id` não nulo, no canal do usuário

#### 1.2. create-video-auth-and-validation-errors

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. POST /videos sem header Authorization e body válido
    - expect: status 401
  2. POST /videos com token e `content_type: "application/pdf"`, `file_name: "doc.pdf"`
    - expect: status 400 com `error: "UNSUPPORTED_VIDEO_FORMAT"`
  3. POST /videos com token e body sem `size_bytes`
    - expect: status 400 com `error: "VALIDATION_ERROR"`
    - expect: nenhuma linha criada em `videos`

### 2. GET /videos/:id/upload/part-urls — assinatura de partes

**Setup:** mesmo do grupo 1; vídeo `draft` criado via `POST /videos` pelo usuário A; segundo usuário B registrado, confirmado e logado.

#### 2.1. sign-part-urls-owner-and-forbidden

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. Usuário A cria vídeo com `size_bytes` = 2 × `part_size_bytes` (2 partes)
    - expect: status 201 com `part_count: 2`
  2. GET /videos/:id/upload/part-urls?part_numbers=1,2 com o token de A
    - expect: status 200 com `parts` de 2 itens `{ part_number, url }` e `expires_in_seconds`
    - expect: cada `url` aponta para o host de `S3_PUBLIC_ENDPOINT`
  3. GET /videos/:id/upload/part-urls?part_numbers=1 com o token de B
    - expect: status 403 com `error: "VIDEO_ACCESS_DENIED"`

#### 2.2. part-urls-dedicated-throttle-limit

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. Usuário A cria um vídeo `draft`
    - expect: status 201
  2. Chamar GET /videos/:id/upload/part-urls?part_numbers=1 30 vezes seguidas com o token de A
    - expect: todas as respostas com status 200 (nenhum 429)

### 3. POST /videos/:id/upload/complete — conclusão

**Setup:** mesmo do grupo 1; fila de teste (`QUEUE_PREFIX=streamtube-test`) esvaziada em `beforeEach`.

#### 3.1. complete-upload-returns-processing

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. Usuário cria vídeo com `size_bytes` igual ao tamanho do buffer de teste (1 parte)
    - expect: status 201
  2. GET /videos/:id/upload/part-urls?part_numbers=1 e `PUT` do buffer na URL retornada
    - expect: o `PUT` responde 200 com header `ETag`
  3. POST /videos/:id/upload/complete com `{ parts: [{ part_number: 1, etag }] }`
    - expect: status 202 com `status: "processing"`
    - expect: a linha em `videos` tem `status = processing` e `upload_id` nulo
    - expect: a fila `video-processing` tem um job `process-video` com `jobId` = id do vídeo

### 4. DELETE /videos/:id/upload — aborto

**Setup:** mesmo do grupo 1.

#### 4.1. abort-draft-and-conflict-when-processing

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. Usuário cria vídeo `draft` e chama DELETE /videos/:id/upload
    - expect: status 204
    - expect: a linha do vídeo não existe mais em `videos`
  2. Usuário cria outro vídeo, envia a parte e completa (vídeo `processing`); chama DELETE /videos/:id/upload
    - expect: status 409 com `error: "INVALID_VIDEO_STATE"`

### 5. GET /videos/:id — consulta do dono

**Setup:** mesmo do grupo 1.

#### 5.1. get-owned-video-and-not-found

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. Usuário cria vídeo e chama GET /videos/:id com o próprio token
    - expect: status 200 com `status: "draft"`, `metadata: null`, `has_thumbnail: false`, `original_file_name` e `size_bytes` informados
  2. GET /videos/{uuid aleatório inexistente} com o token
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`
