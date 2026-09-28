---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-28T13:52:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T13:50:17-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "'metadados' não define quais campos técnicos são extraídos e persistidos"
    resolved_by: phase-03-videos/TD-07
  - id: AMB-2
    status: resolved
    summary: "Pré-cadastro não define quais dados o cliente informa ao iniciar o upload"
    resolved_by: phase-03-videos/TD-04
  - id: AMB-3
    status: resolved
    summary: "'rascunho' da Fase 03 pode colidir com 'rascunho → publicação' da Fase 04"
    resolved_by: phase-03-videos/TD-10
  - id: MD-1
    status: resolved
    summary: "Sem TD para política de formatos aceitos e validação do arquivo enviado"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Background Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Local S3-Compatible Storage Server (Compose image)"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Storage Layout and Access Model"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Large-File Upload Protocol (≤ 10GB, resumable)"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Upload Completion and Processing Trigger"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Video Worker Runtime and Deployment"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — FFmpeg Integration for Metadata and Thumbnail"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Unique Video URL Identifier"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Video Status Lifecycle and Processing Failure Handling"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Access Policy for Video Endpoints in Phase 03"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Testing Strategy for Storage, Queue and Worker"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Accepted Formats and Upload Validation Policy"
    resolved_by: phase-03-videos/TD-13
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI↔API sync deferred — `## UI Inventory` carries the deferred placeholder; Check 7 does not apply.)_

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-13)_ — Sem TD para política de formatos aceitos e validação do arquivo enviado. Coberto pela TD-13 adicionada via `/research` (iteração validate → research → context → validate).
- **AMB-1** _(resolved_by phase-03-videos/TD-07)_ — 'metadados' não define quais campos técnicos são extraídos e persistidos. Usuário escolheu: `duration_seconds` como coluna + `metadata` jsonb normalizado (container/formato, codec de vídeo, codec de áudio, largura, altura, fps, bitrate); registrado como `**Revisions:**` da TD-07.
- **AMB-2** _(resolved_by phase-03-videos/TD-04)_ — Pré-cadastro não define quais dados o cliente informa ao iniciar o upload. Usuário escolheu: obrigatórios `file_name`, `size_bytes`, `content_type`; `title` opcional (1–100) com padrão = nome do arquivo sem extensão; registrado como `**Revisions:**` da TD-04.
- **AMB-3** _(resolved_by phase-03-videos/TD-10)_ — 'rascunho' da Fase 03 pode colidir com 'rascunho → publicação' da Fase 04. Usuário escolheu: conceitos separados — o `status` da Fase 03 é só o ciclo técnico; publicação/visibilidade é atributo da Fase 04; registrado como `**Revisions:**` da TD-10.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 decidida: **A** (BullMQ + Redis via `@nestjs/bullmq`).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 decidida: **A** (MinIO via imagem Chainguard, fixada por digest).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 decidida: **A** (bucket privado único, chaves derivadas do id, acesso só por URL pré-assinada, endpoints interno/público).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 decidida: **A** (S3 multipart com URLs pré-assinadas por parte).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 decidida: **A** (endpoint explícito de complete + enfileiramento com `jobId = videoId`).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 decidida: **A** (mesmo codebase, segundo entrypoint, serviço `video-worker` no Compose).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 decidida: **A** (`ffprobe`/`ffmpeg` do SO via `spawn`, lendo por URL pré-assinada).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 decidida: **A** (slug base62 de 11 caracteres via `node:crypto` + índice único + retry).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decidida: **A** (API responde 302 para GET pré-assinado; `Range`/`206` servidos pelo storage; variante attachment para download).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 decidida: **A** (status único `draft → processing → ready | failed`, 3 tentativas com backoff exponencial).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 decidida: **A** (controle de upload só do dono; reprodução pública de vídeos `ready` por slug; limites de throttle dedicados).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 decidida: **A** (MinIO + Redis + FFmpeg reais em integração/e2e; prefixo de fila isolado para testes).
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 decidida: **A** (allowlist de MIME/extensão no início + checagem real de tamanho no complete + `ffprobe` como autoridade no worker).
