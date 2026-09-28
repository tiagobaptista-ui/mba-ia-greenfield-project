import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { MediaModule } from '../media/media.module';
import type { ProcessVideoJobData } from '../queue/queue.types';
import {
  videoOriginalKey,
  videoThumbnailKey,
} from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { deleteObjectsByPrefix } from '../test/storage';
import {
  createTestMediaDir,
  generateNotAVideo,
  generateTestVideo,
  type TestMediaDir,
} from '../test/video-fixture';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generateVideoSlug } from '../videos/slug.util';
import { VideosModule } from '../videos/videos.module';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessor (integration — real DB + MinIO + FFmpeg)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let processor: VideoProcessor;
  let storageService: StorageService;
  let videoRepository: Repository<Video>;
  let media: TestMediaDir;
  let channelId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        StorageModule,
        MediaModule,
        VideosModule,
      ],
      providers: [VideoProcessor],
    }).compile();
    // init() runs lifecycle hooks, so close() also shuts down the BullMQ worker the
    // explorer attaches to @Processor (idle here: the test calls process() directly).
    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    processor = moduleRef.get(VideoProcessor);
    storageService = moduleRef.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
    media = await createTestMediaDir();
  }, 60_000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'worker@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'worker', nickname: 'worker', user_id: user.id });
    channelId = channel.id;
  });

  afterEach(async () => {
    await deleteObjectsByPrefix('videos/');
    await deleteObjectsByPrefix('thumbnails/');
  });

  afterAll(async () => {
    await media.cleanup();
    await moduleRef.close();
  });

  async function uploadedVideo(filePath: string): Promise<Video> {
    const id = randomUUID();
    const body = await readFile(filePath);
    await storageService.putObject(videoOriginalKey(id), body, 'video/mp4');
    return videoRepository.save({
      id,
      channel_id: channelId,
      slug: generateVideoSlug(),
      title: 'clip',
      status: VideoStatus.PROCESSING,
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: body.length,
      storage_key: videoOriginalKey(id),
      part_size_bytes: body.length,
      part_count: 1,
    });
  }

  function jobFor(video: Video, attemptsMade = 0): Job<ProcessVideoJobData> {
    return {
      data: { videoId: video.id },
      attemptsMade,
      opts: { attempts: 3 },
    } as Job<ProcessVideoJobData>;
  }

  it('should turn an uploaded clip into a ready video with metadata and a stored thumbnail', async () => {
    const video = await uploadedVideo(await generateTestVideo(media.dir));

    await expect(processor.process(jobFor(video))).resolves.toBe('ready');

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.READY);
    expect(stored.duration_seconds).toBeCloseTo(3, 0);
    expect(stored.metadata).toMatchObject({
      video_codec: 'h264',
      width: 320,
      height: 240,
      fps: 25,
    });
    expect(stored.thumbnail_key).toBe(videoThumbnailKey(video.id));
    expect(
      await storageService.headObjectSize(videoThumbnailKey(video.id)),
    ).toBeGreaterThan(0);
  }, 60_000);

  it('should fail a video whose file is not a video on the first attempt, without retries', async () => {
    const video = await uploadedVideo(await generateNotAVideo(media.dir));

    await expect(processor.process(jobFor(video))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.FAILED);
    expect(stored.processing_error).toContain('ffprobe');
    expect(stored.processing_error).not.toContain('X-Amz-Signature');
    expect(stored.thumbnail_key).toBeNull();
  }, 60_000);

  it('should leave an already ready video untouched when its job is reprocessed', async () => {
    const video = await uploadedVideo(await generateTestVideo(media.dir));
    await processor.process(jobFor(video));
    const before = await videoRepository.findOneByOrFail({ id: video.id });

    await expect(processor.process(jobFor(video))).resolves.toBe('skipped');

    const after = await videoRepository.findOneByOrFail({ id: video.id });
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.status).toBe(VideoStatus.READY);
  }, 60_000);
});
