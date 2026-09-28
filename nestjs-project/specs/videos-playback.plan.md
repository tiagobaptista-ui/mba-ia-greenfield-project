---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: nestjs-project/test/videos-playback.e2e-spec.ts
---

# Video Playback Endpoints Test Plan

## Application Overview

Endpoints públicos (`@Public()`) que entregam a reprodução via streaming, o download e a thumbnail de um vídeo `ready` pela URL única (`slug`), redirecionando (`302`) para URLs pré-assinadas do MinIO, que atende `Range` com `206 Partial Content` (TD-09/TD-11). Os vídeos chegam a `ready` pelo fluxo real: pré-cadastro, envio das partes ao MinIO, complete e processamento pelo `VideoProcessor` registrado **no próprio módulo de teste** sobre o prefixo de fila de teste (TD-12), com um clipe gerado por FFmpeg.

## Test Scenarios

### 1. GET /videos/:slug/stream — streaming

**Setup:** `beforeEach` `cleanAllTables` + `ThrottlerStorage.storage.clear()`; `Test.createTestingModule({ imports: [AppModule], providers: [VideoProcessor, …deps do worker] })` com `ValidationPipe` e filtros de `main.ts` reaplicados; fila de teste (`QUEUE_PREFIX=streamtube-test`) esvaziada; helper que registra/loga um usuário, gera o clipe de teste (`src/test/video-fixture.ts`), faz o upload completo pela API e aguarda (polling de `GET /videos/:id`) até `status: "ready"`.

#### 1.1. stream-ready-video-redirect-and-range

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. Obter um vídeo `ready` via helper de setup
    - expect: `GET /videos/:id` do dono retorna `status: "ready"`
  2. GET /videos/:slug/stream sem header Authorization (sem seguir redirects)
    - expect: status 302 com header `Location` apontando para o host de `S3_PUBLIC_ENDPOINT`
  3. GET na URL de `Location` com header `Range: bytes=0-1023`
    - expect: status 206 com header `Content-Range: bytes 0-1023/<tamanho do clipe>` e corpo de 1024 bytes

### 2. GET /videos/:slug/download — download

**Setup:** mesmo do grupo 1.

#### 2.1. download-ready-video-as-attachment

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. GET /videos/:slug/download sem token (sem seguir redirects) para um vídeo `ready` enviado como `clipe.mp4`
    - expect: status 302 com header `Location`
  2. GET na URL de `Location`
    - expect: status 200 com header `Content-Disposition: attachment; filename="clipe.mp4"` e corpo com o tamanho do clipe

### 3. GET /videos/:slug/thumbnail — thumbnail

**Setup:** mesmo do grupo 1.

#### 3.1. thumbnail-redirects-to-jpeg

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. GET /videos/:slug/thumbnail sem token (sem seguir redirects) para um vídeo `ready`
    - expect: status 302 com header `Location`
  2. GET na URL de `Location`
    - expect: status 200 com corpo não vazio começando pelos bytes JPEG `FF D8`

### 4. Vídeos não disponíveis para reprodução

**Setup:** mesmo do grupo 1, sem aguardar processamento: vídeo `draft` (só pré-cadastro), vídeo `processing` (completado com o processador parado) e vídeo `failed` (arquivo de texto enviado e processado).

#### 4.1. playback-routes-return-not-found-unless-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. GET /videos/{slug inexistente}/stream, /download e /thumbnail
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"` nas três rotas
  2. GET /videos/:slug/stream, /download e /thumbnail para os vídeos `draft`, `processing` e `failed`
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"` em todas as combinações

### 5. Limite de throttling dedicado

**Setup:** mesmo do grupo 1.

#### 5.1. playback-routes-dedicated-throttle-limit

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. Chamar GET /videos/:slug/stream 30 vezes seguidas (sem token, sem seguir redirects) para um vídeo `ready`
    - expect: todas as respostas com status 302 (nenhum 429)

### 6. Fluxo completo

**Setup:** mesmo do grupo 1.

#### 6.1. upload-process-and-stream-end-to-end

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-28T17:10:49Z

**Steps:**
  1. POST /videos com o clipe gerado (`clipe.mp4`, `video/mp4`, `size_bytes` real)
    - expect: status 201 com `status: "draft"`
  2. GET /videos/:id/upload/part-urls, `PUT` das partes nas URLs e POST /videos/:id/upload/complete
    - expect: status 202 com `status: "processing"`
  3. Polling de GET /videos/:id até `status` final (timeout de 30 s)
    - expect: `status: "ready"`, `duration_seconds` > 0, `metadata.video_codec` preenchido e `has_thumbnail: true`
  4. GET /videos/:slug/stream e GET na `Location` com `Range: bytes=0-99`
    - expect: status 206 com 100 bytes
