import { readFile } from 'node:fs/promises';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import storageConfig from '../src/config/storage.config';
import { MediaModule } from '../src/media/media.module';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { StorageModule } from '../src/storage/storage.module';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { obliterateQueue } from '../src/test/queue';
import { deleteObjectsByPrefix, putToPresignedUrl } from '../src/test/storage';
import {
  createTestMediaDir,
  generateNotAVideo,
  generateTestVideo,
  type TestMediaDir,
} from '../src/test/video-fixture';
import type {
  InitiatedUploadResponseDto,
  PartUrlsResponseDto,
  VideoDetailsResponseDto,
} from '../src/videos/dto/video-responses.dto';
import { VideoStatus } from '../src/videos/entities/video.entity';
import { VideosModule } from '../src/videos/videos.module';
import { VideoProcessor } from '../src/worker/video.processor';
import { createAuthSession, type AuthSession } from './helpers/auth-session';

const PLAYBACK_ROUTES = ['stream', 'download', 'thumbnail'] as const;
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

// Spec: nestjs-project/specs/videos-playback.plan.md (SI-03.11)
describe('videos-playback', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let queue: Queue;
  let processor: VideoProcessor;
  let throttlerStorage: ThrottlerStorageService;
  let media: TestMediaDir;
  let clip: Buffer<ArrayBuffer>;
  let notAVideo: Buffer<ArrayBuffer>;
  let owner: AuthSession;

  beforeAll(async () => {
    // The processor runs in this process on the test queue prefix (TD-12), so the
    // video-worker container (dev prefix) never sees these jobs.
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule, VideosModule, StorageModule, MediaModule],
      providers: [VideoProcessor],
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
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    processor = moduleFixture.get(VideoProcessor);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    media = await createTestMediaDir();
    clip = Buffer.from(
      await readFile(
        await generateTestVideo(media.dir, { fileName: 'clipe.mp4' }),
      ),
    );
    notAVideo = Buffer.from(
      await readFile(await generateNotAVideo(media.dir, 'falso.mp4')),
    );
  }, 60_000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await obliterateQueue(queue);
    throttlerStorage.storage.clear();
    owner = await createAuthSession(app, 'owner@example.com');
    throttlerStorage.storage.clear();
  });

  afterEach(async () => {
    await deleteObjectsByPrefix('videos/');
    await deleteObjectsByPrefix('thumbnails/');
  });

  afterAll(async () => {
    await obliterateQueue(queue);
    await media.cleanup();
    await app.close();
  });

  const auth = (): [string, string] => [
    'Authorization',
    `Bearer ${owner.accessToken}`,
  ];

  async function createDraft(
    fileName: string,
    size: number,
  ): Promise<InitiatedUploadResponseDto> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set(...auth())
      .send({
        file_name: fileName,
        size_bytes: size,
        content_type: 'video/mp4',
      })
      .expect(201);
    return res.body as InitiatedUploadResponseDto;
  }

  /** Real client flow: sign the parts, PUT them to MinIO and complete (→ 202 processing). */
  async function uploadAndComplete(
    video: InitiatedUploadResponseDto,
    payload: Buffer<ArrayBuffer>,
  ): Promise<void> {
    const partNumbers = Array.from(
      { length: video.part_count },
      (_, i) => i + 1,
    );
    const signed = await request(app.getHttpServer())
      .get(`/videos/${video.id}/upload/part-urls`)
      .query({ part_numbers: partNumbers.join(',') })
      .set(...auth())
      .expect(200);
    const parts: { part_number: number; etag: string }[] = [];
    for (const part of (signed.body as PartUrlsResponseDto).parts) {
      const start = (part.part_number - 1) * video.part_size_bytes;
      const chunk = Buffer.from(
        payload.subarray(start, start + video.part_size_bytes),
      );
      parts.push({
        part_number: part.part_number,
        etag: await putToPresignedUrl(part.url, chunk),
      });
    }
    const completed = await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set(...auth())
      .send({ parts })
      .expect(202);
    expect((completed.body as { status: string }).status).toBe('processing');
  }

  async function waitForFinalStatus(
    videoId: string,
  ): Promise<VideoDetailsResponseDto> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .set(...auth())
        .expect(200);
      const details = res.body as VideoDetailsResponseDto;
      if (details.status !== VideoStatus.PROCESSING) return details;
      if (Date.now() > deadline) {
        throw new Error(`Video ${videoId} still processing after 30 s`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  async function readyVideo(): Promise<VideoDetailsResponseDto> {
    const draft = await createDraft('clipe.mp4', clip.length);
    await uploadAndComplete(draft, clip);
    const details = await waitForFinalStatus(draft.id);
    expect(details.status).toBe('ready');
    throttlerStorage.storage.clear();
    return details;
  }

  async function redirectLocation(
    slug: string,
    route: (typeof PLAYBACK_ROUTES)[number],
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .get(`/videos/${slug}/${route}`)
      .expect(302);
    return res.headers.location;
  }

  // 1. GET /videos/:slug/stream — streaming

  test('1.1 stream-ready-video-redirect-and-range', async () => {
    const video = await readyVideo();

    const location = await redirectLocation(video.slug, 'stream');
    expect(new URL(location).origin).toBe(
      new URL(storageConfig().publicEndpoint).origin,
    );

    const res = await fetch(location, { headers: { Range: 'bytes=0-1023' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(
      `bytes 0-1023/${clip.length}`,
    );
    expect((await res.arrayBuffer()).byteLength).toBe(1024);
  }, 60_000);

  // 2. GET /videos/:slug/download — download

  test('2.1 download-ready-video-as-attachment', async () => {
    const video = await readyVideo();

    const location = await redirectLocation(video.slug, 'download');

    const res = await fetch(location);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="clipe.mp4"',
    );
    expect((await res.arrayBuffer()).byteLength).toBe(clip.length);
  }, 60_000);

  // 3. GET /videos/:slug/thumbnail — thumbnail

  test('3.1 thumbnail-redirects-to-jpeg', async () => {
    const video = await readyVideo();

    const location = await redirectLocation(video.slug, 'thumbnail');

    const res = await fetch(location);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 60_000);

  // 4. Vídeos não disponíveis para reprodução

  test('4.1 playback-routes-return-not-found-unless-ready', async () => {
    const draft = await createDraft('rascunho.mp4', clip.length);

    // Processor paused: the completed upload stays in `processing`.
    await processor.worker.pause();
    const processing = await createDraft('processando.mp4', clip.length);
    await uploadAndComplete(processing, clip);
    await obliterateQueue(queue);
    processor.worker.resume();

    const failedDraft = await createDraft('falso.mp4', notAVideo.length);
    await uploadAndComplete(failedDraft, notAVideo);
    expect((await waitForFinalStatus(failedDraft.id)).status).toBe('failed');
    throttlerStorage.storage.clear();

    const slugs = [
      'naoExiste00',
      draft.slug,
      processing.slug,
      failedDraft.slug,
    ];
    for (const slug of slugs) {
      for (const route of PLAYBACK_ROUTES) {
        const res = await request(app.getHttpServer())
          .get(`/videos/${slug}/${route}`)
          .expect(404);
        expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
      }
    }
  }, 60_000);

  // 5. Limite de throttling dedicado

  test('5.1 playback-routes-dedicated-throttle-limit', async () => {
    const video = await readyVideo();

    for (let i = 0; i < 30; i++) {
      await request(app.getHttpServer())
        .get(`/videos/${video.slug}/stream`)
        .expect(302);
    }
  }, 60_000);

  // 6. Fluxo completo

  test('6.1 upload-process-and-stream-end-to-end', async () => {
    const draft = await createDraft('clipe.mp4', clip.length);
    expect(draft.status).toBe('draft');

    await uploadAndComplete(draft, clip);
    const details = await waitForFinalStatus(draft.id);

    expect(details.status).toBe('ready');
    expect(details.duration_seconds).toBeGreaterThan(0);
    expect(details.metadata?.video_codec).toBeTruthy();
    expect(details.has_thumbnail).toBe(true);

    const location = await redirectLocation(details.slug, 'stream');
    const res = await fetch(location, { headers: { Range: 'bytes=0-99' } });
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  }, 60_000);
});
