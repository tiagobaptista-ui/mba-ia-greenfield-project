---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 16
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-28T13:25:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-28T13:06:59-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "'metadados' não define quais campos técnicos são extraídos e persistidos"
  - id: AMB-2
    status: open
    summary: "Pré-cadastro não define quais dados o cliente informa ao iniciar o upload"
  - id: AMB-3
    status: open
    summary: "'rascunho' da Fase 03 pode colidir com 'rascunho → publicação' da Fase 04"
  - id: MD-1
    status: open
    summary: "Sem TD para política de formatos aceitos e validação do arquivo enviado"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Background Queue Technology"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — Local S3-Compatible Storage Server (Compose image)"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — Storage Layout and Access Model"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — Large-File Upload Protocol (≤ 10GB, resumable)"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Upload Completion and Processing Trigger"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — Video Worker Runtime and Deployment"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — FFmpeg Integration for Metadata and Thumbnail"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — Unique Video URL Identifier"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Streaming and Download Delivery"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Video Status Lifecycle and Processing Failure Handling"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — Access Policy for Video Endpoints in Phase 03"
  - id: OQ-12
    status: open
    summary: "TD-12 pending — Testing Strategy for Storage, Queue and Worker"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — A capability "Processamento automático do vídeo após upload (extração de duração e metadados)" nomeia apenas "duração"; o conjunto de "metadados" (ex.: container/formato, codecs de vídeo e áudio, resolução, fps, bitrate, tamanho) não está definido, e o implementador precisaria perguntar quais campos persistir e em que forma (colunas dedicadas vs. um campo `metadata` estruturado). Explicit choice: definir a lista de metadados extraídos e a forma de persistência (resolver via `/plan-resolve phase-03-videos`; alimenta o Data Model do plano).
- **AMB-2** — A capability "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" não diz quais dados o cliente fornece ao iniciar o upload: o título é obrigatório no início ou derivado do nome do arquivo (editável na Fase 04 — "Edição das informações do vídeo: título, descrição, categoria")? Quais atributos do arquivo (nome, tamanho, tipo) são obrigatórios no pré-cadastro? Explicit choice: fixar os campos de entrada do pré-cadastro e a regra de título padrão (resolver via `/plan-resolve phase-03-videos`; alimenta API Contracts e Validation Rules).
- **AMB-3** — Fronteira com a Fase 04: esta fase cria o vídeo "como rascunho", e o vizinho Phase 04 traz "Fluxo de rascunho → publicação". Não está explícito se o "rascunho" da Fase 03 é o estado de upload/processamento (o vídeo ainda não está pronto) ou o estado editorial que a Fase 04 publica — o mesmo termo pode cair em qualquer lado da fronteira. Explicit choice: declarar que o status da Fase 03 cobre só o ciclo técnico (upload/processamento) e que publicação/visibilidade é um atributo separado da Fase 04 — ou o contrário (resolver junto com OQ-10 / TD-10 via `/plan-resolve phase-03-videos`).

### Missing Decisions

- **MD-1** — A capability "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" exige uma política de aceitação do arquivo que nenhuma TD decide: quais formatos/containers de vídeo são aceitos, onde a validação acontece (declaração de `content_type`/extensão no início do upload vs. verificação real por `ffprobe` no worker, com o vídeo indo para erro se não for vídeo) e como o limite de 10GB é aplicado (tamanho declarado no início vs. tamanho real do objeto ao completar). É uma decisão de limite/política citada em mais de um componente (DTO de início, worker, contrato OpenAPI). Explicit choice: run `/research phase 03` to add a TD covering accepted formats and upload validation policy.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **OQ-1** — TD-01 pending — Background Queue Technology. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.
- **OQ-2** — TD-02 pending — Local S3-Compatible Storage Server (Compose image). Resolution: fill the **Decision:** field of TD-02 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.
- **OQ-3** — TD-03 pending — Storage Layout and Access Model. Resolution: fill the **Decision:** field of TD-03 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.
- **OQ-4** — TD-04 pending — Large-File Upload Protocol (≤ 10GB, resumable). Resolution: fill the **Decision:** field of TD-04 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.
- **OQ-5** — TD-05 pending — Upload Completion and Processing Trigger. Resolution: fill the **Decision:** field of TD-05 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.
- **OQ-6** — TD-06 pending — Video Worker Runtime and Deployment. Resolution: fill the **Decision:** field of TD-06 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.
- **OQ-7** — TD-07 pending — FFmpeg Integration for Metadata and Thumbnail. Resolution: fill the **Decision:** field of TD-07 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.
- **OQ-8** — TD-08 pending — Unique Video URL Identifier. Resolution: fill the **Decision:** field of TD-08 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.
- **OQ-9** — TD-09 pending — Streaming and Download Delivery. Resolution: fill the **Decision:** field of TD-09 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.
- **OQ-10** — TD-10 pending — Video Status Lifecycle and Processing Failure Handling. Resolution: fill the **Decision:** field of TD-10 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.
- **OQ-11** — TD-11 pending — Access Policy for Video Endpoints in Phase 03. Resolution: fill the **Decision:** field of TD-11 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.
- **OQ-12** — TD-12 pending — Testing Strategy for Storage, Queue and Worker. Resolution: fill the **Decision:** field of TD-12 in `docs/decisions/technical-decisions-phase-03-videos.md` (via `/plan-resolve phase-03-videos`), then re-run `/plan-validate phase-03-videos`.

### UI Coverage Gaps

_None._ _(UI↔API sync deferred — `## UI Inventory` carries the deferred placeholder; Check 7 does not apply.)_

## Resolved Issues

_No issues resolved yet._
