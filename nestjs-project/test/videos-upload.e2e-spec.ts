import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import storageConfig from '../src/config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { obliterateQueue } from '../src/test/queue';
import { deleteObjectsByPrefix, putToPresignedUrl } from '../src/test/storage';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import type {
  CompletedUploadResponseDto,
  InitiatedUploadResponseDto,
  PartUrlsResponseDto,
  VideoDetailsResponseDto,
} from '../src/videos/dto/video-responses.dto';
import { createAuthSession, type AuthSession } from './helpers/auth-session';

// Spec: nestjs-project/specs/videos-upload.plan.md (SI-03.7)
describe('videos-upload', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  let owner: AuthSession;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await obliterateQueue(queue);
    throttlerStorage.storage.clear();
    owner = await createAuthSession(app, 'owner@example.com');
    throttlerStorage.storage.clear();
  });

  afterEach(async () => {
    await deleteObjectsByPrefix('videos/');
  });

  afterAll(async () => {
    await obliterateQueue(queue);
    await app.close();
  });

  const auth = (session: AuthSession): [string, string] => [
    'Authorization',
    `Bearer ${session.accessToken}`,
  ];

  async function createVideo(
    session: AuthSession,
    body: Record<string, unknown>,
  ): Promise<InitiatedUploadResponseDto> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set(...auth(session))
      .send(body)
      .expect(201);
    return res.body as InitiatedUploadResponseDto;
  }

  async function uploadAllParts(
    session: AuthSession,
    video: InitiatedUploadResponseDto,
    payload: Buffer<ArrayBuffer>,
  ): Promise<{ part_number: number; etag: string }[]> {
    const partNumbers = Array.from(
      { length: video.part_count },
      (_, i) => i + 1,
    );
    const res = await request(app.getHttpServer())
      .get(`/videos/${video.id}/upload/part-urls`)
      .query({ part_numbers: partNumbers.join(',') })
      .set(...auth(session))
      .expect(200);
    const { parts } = res.body as PartUrlsResponseDto;
    const uploaded: { part_number: number; etag: string }[] = [];
    for (const part of parts) {
      const start = (part.part_number - 1) * video.part_size_bytes;
      const chunk = Buffer.from(
        payload.subarray(start, start + video.part_size_bytes),
      );
      uploaded.push({
        part_number: part.part_number,
        etag: await putToPresignedUrl(part.url, chunk),
      });
    }
    return uploaded;
  }

  // 1. POST /videos — pré-cadastro

  test('1.1 create-draft-video-success', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set(...auth(owner))
      .send({
        file_name: 'meu-video.mp4',
        size_bytes: 1048576,
        content_type: 'video/mp4',
      })
      .expect(201);

    const body = res.body as InitiatedUploadResponseDto;
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.slug).toMatch(/^[0-9A-Za-z]{11}$/);
    expect(body.title).toBe('meu-video');
    expect(body.status).toBe('draft');
    expect(body.part_size_bytes).toBe(storageConfig().uploadPartSizeBytes);
    expect(body.part_count).toBe(1);

    const stored = await videoRepository.findOneByOrFail({ id: body.id });
    expect(stored.status).toBe(VideoStatus.DRAFT);
    expect(stored.upload_id).not.toBeNull();
  });

  test('1.2 create-video-auth-and-validation-errors', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send({ file_name: 'a.mp4', size_bytes: 10, content_type: 'video/mp4' })
      .expect(401);

    const unsupported = await request(app.getHttpServer())
      .post('/videos')
      .set(...auth(owner))
      .send({
        file_name: 'doc.pdf',
        size_bytes: 10,
        content_type: 'application/pdf',
      })
      .expect(400);
    expect((unsupported.body as ApiErrorEnvelope).error).toBe(
      'UNSUPPORTED_VIDEO_FORMAT',
    );

    const invalid = await request(app.getHttpServer())
      .post('/videos')
      .set(...auth(owner))
      .send({ file_name: 'a.mp4', content_type: 'video/mp4' })
      .expect(400);
    expect((invalid.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
    expect(await videoRepository.count()).toBe(0);
  });

  // 2. GET /videos/:id/upload/part-urls — assinatura de partes

  test('2.1 sign-part-urls-owner-and-forbidden', async () => {
    const other = await createAuthSession(app, 'other@example.com');
    throttlerStorage.storage.clear();
    const partSize = storageConfig().uploadPartSizeBytes;
    const video = await createVideo(owner, {
      file_name: 'longo.mp4',
      size_bytes: 2 * partSize,
      content_type: 'video/mp4',
    });
    expect(video.part_count).toBe(2);

    const ownRes = await request(app.getHttpServer())
      .get(`/videos/${video.id}/upload/part-urls`)
      .query({ part_numbers: '1,2' })
      .set(...auth(owner))
      .expect(200);
    const signed = ownRes.body as PartUrlsResponseDto;
    expect(signed.parts.map((p) => p.part_number)).toEqual([1, 2]);
    expect(signed.expires_in_seconds).toBe(
      storageConfig().presignExpiresSeconds,
    );
    const publicHost = new URL(storageConfig().publicEndpoint).host;
    for (const part of signed.parts) {
      expect(new URL(part.url).host).toBe(publicHost);
    }

    const forbidden = await request(app.getHttpServer())
      .get(`/videos/${video.id}/upload/part-urls`)
      .query({ part_numbers: '1' })
      .set(...auth(other))
      .expect(403);
    expect((forbidden.body as ApiErrorEnvelope).error).toBe(
      'VIDEO_ACCESS_DENIED',
    );
  });

  test('2.2 part-urls-dedicated-throttle-limit', async () => {
    const video = await createVideo(owner, {
      file_name: 'clip.mp4',
      size_bytes: 100,
      content_type: 'video/mp4',
    });

    for (let i = 0; i < 30; i++) {
      await request(app.getHttpServer())
        .get(`/videos/${video.id}/upload/part-urls`)
        .query({ part_numbers: '1' })
        .set(...auth(owner))
        .expect(200);
    }
  });

  // 3. POST /videos/:id/upload/complete — conclusão

  test('3.1 complete-upload-returns-processing', async () => {
    const payload = randomBytes(4096);
    const video = await createVideo(owner, {
      file_name: 'clip.mp4',
      size_bytes: payload.length,
      content_type: 'video/mp4',
    });
    const parts = await uploadAllParts(owner, video, payload);

    const res = await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set(...auth(owner))
      .send({ parts })
      .expect(202);

    expect((res.body as CompletedUploadResponseDto).status).toBe('processing');
    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.PROCESSING);
    expect(stored.upload_id).toBeNull();
    const job = await queue.getJob(video.id);
    expect(job?.name).toBe('process-video');
    expect(job?.id).toBe(video.id);
  });

  // 4. DELETE /videos/:id/upload — aborto

  test('4.1 abort-draft-and-conflict-when-processing', async () => {
    const draft = await createVideo(owner, {
      file_name: 'clip.mp4',
      size_bytes: 100,
      content_type: 'video/mp4',
    });
    await request(app.getHttpServer())
      .delete(`/videos/${draft.id}/upload`)
      .set(...auth(owner))
      .expect(204);
    expect(await videoRepository.findOneBy({ id: draft.id })).toBeNull();

    const payload = randomBytes(512);
    const processing = await createVideo(owner, {
      file_name: 'clip.mp4',
      size_bytes: payload.length,
      content_type: 'video/mp4',
    });
    const parts = await uploadAllParts(owner, processing, payload);
    await request(app.getHttpServer())
      .post(`/videos/${processing.id}/upload/complete`)
      .set(...auth(owner))
      .send({ parts })
      .expect(202);

    const conflict = await request(app.getHttpServer())
      .delete(`/videos/${processing.id}/upload`)
      .set(...auth(owner))
      .expect(409);
    expect((conflict.body as ApiErrorEnvelope).error).toBe(
      'INVALID_VIDEO_STATE',
    );
  });

  // 5. GET /videos/:id — consulta do dono

  test('5.1 get-owned-video-and-not-found', async () => {
    const video = await createVideo(owner, {
      file_name: 'viagem.webm',
      size_bytes: 2048,
      content_type: 'video/webm',
    });

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.id}`)
      .set(...auth(owner))
      .expect(200);
    const details = res.body as VideoDetailsResponseDto;
    expect(details.status).toBe('draft');
    expect(details.metadata).toBeNull();
    expect(details.has_thumbnail).toBe(false);
    expect(details.original_file_name).toBe('viagem.webm');
    expect(details.size_bytes).toBe(2048);

    const missing = await request(app.getHttpServer())
      .get(`/videos/${randomUUID()}`)
      .set(...auth(owner))
      .expect(404);
    expect((missing.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
  });
});
