import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { UploadSizeMismatchException } from '../common/exceptions/domain.exception';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { obliterateQueue } from '../test/queue';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { deleteObjectsByPrefix, putToPresignedUrl } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — real DB + MinIO)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let ownerId: string;
  let ownerChannelId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    videosService = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  beforeEach(async () => {
    await obliterateQueue(queue);
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'uploader', nickname: 'uploader', user_id: user.id });
    ownerId = user.id;
    ownerChannelId = channel.id;
  });

  afterEach(async () => {
    await deleteObjectsByPrefix('videos/');
  });

  afterAll(async () => {
    await obliterateQueue(queue);
    await moduleRef.close();
  });

  describe('initiateUpload', () => {
    it('should persist a draft in the user channel with the upload id and an open multipart upload', async () => {
      const video = await videosService.initiateUpload(ownerId, {
        file_name: 'passeio.mp4',
        size_bytes: 2048,
        content_type: 'video/mp4',
      });

      const stored = await videoRepository.findOneByOrFail({ id: video.id });
      expect(stored.status).toBe(VideoStatus.DRAFT);
      expect(stored.channel_id).toBe(ownerChannelId);
      expect(stored.title).toBe('passeio');
      expect(stored.slug).toMatch(/^[0-9A-Za-z]{11}$/);
      expect(stored.storage_key).toBe(`videos/${video.id}/original`);
      expect(stored.upload_id).toEqual(expect.any(String));
      expect(stored.part_count).toBe(1);

      // The multipart upload exists: a part can be PUT into it.
      const partUrl = await storageService.presignUploadPart(
        stored.storage_key,
        stored.upload_id!,
        1,
      );
      await expect(
        putToPresignedUrl(partUrl, randomBytes(2048)),
      ).resolves.toEqual(expect.any(String));
      await storageService.abortMultipartUpload(
        stored.storage_key,
        stored.upload_id!,
      );
    });

    it('should give distinct slugs to videos of the same channel', async () => {
      const dto = {
        file_name: 'clip.webm',
        size_bytes: 100,
        content_type: 'video/webm',
      };

      const first = await videosService.initiateUpload(ownerId, dto);
      const second = await videosService.initiateUpload(ownerId, dto);

      expect(first.slug).not.toBe(second.slug);
      expect(
        await videoRepository.countBy({ channel_id: ownerChannelId }),
      ).toBe(2);
    });

    it('should abort the multipart upload when the draft cannot be persisted', async () => {
      const abortSpy = jest.spyOn(storageService, 'abortMultipartUpload');
      jest
        .spyOn(dataSource, 'transaction')
        .mockRejectedValueOnce(new Error('insert failed'));

      await expect(
        videosService.initiateUpload(ownerId, {
          file_name: 'clip.mp4',
          size_bytes: 100,
          content_type: 'video/mp4',
        }),
      ).rejects.toThrow('insert failed');

      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(await videoRepository.count()).toBe(0);
      jest.restoreAllMocks();
    });
  });

  describe('completeUpload', () => {
    async function startUpload(declaredSize: number): Promise<Video> {
      return videosService.initiateUpload(ownerId, {
        file_name: 'clip.mp4',
        size_bytes: declaredSize,
        content_type: 'video/mp4',
      });
    }

    async function uploadSinglePart(
      video: Video,
      body: Buffer<ArrayBuffer>,
    ): Promise<string> {
      const {
        parts: [part],
      } = await videosService.signPartUrls(ownerId, video.id, [1]);
      return putToPresignedUrl(part.url, body);
    }

    it('should complete the upload, mark the video processing and enqueue its job', async () => {
      const body = randomBytes(4096);
      const video = await startUpload(body.length);
      const etag = await uploadSinglePart(video, body);

      const result = await videosService.completeUpload(ownerId, video.id, [
        { part_number: 1, etag },
      ]);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      const stored = await videoRepository.findOneByOrFail({ id: video.id });
      expect(stored.status).toBe(VideoStatus.PROCESSING);
      expect(stored.upload_id).toBeNull();
      expect(await storageService.headObjectSize(stored.storage_key)).toBe(
        body.length,
      );
      const job = await queue.getJob(video.id);
      expect(job?.data).toEqual({ videoId: video.id });
    });

    it('should fail the video and delete the object when the real size differs from the declared one', async () => {
      const body = randomBytes(4096);
      const video = await startUpload(body.length + 10);
      const etag = await uploadSinglePart(video, body);

      await expect(
        videosService.completeUpload(ownerId, video.id, [
          { part_number: 1, etag },
        ]),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      const stored = await videoRepository.findOneByOrFail({ id: video.id });
      expect(stored.status).toBe(VideoStatus.FAILED);
      expect(stored.processing_error).toContain('does not match');
      await expect(
        storageService.headObjectSize(stored.storage_key),
      ).rejects.toThrow();
      expect(await queue.getJob(video.id)).toBeUndefined();
    });
  });

  describe('abortUpload', () => {
    it('should remove the draft and invalidate the multipart upload', async () => {
      const video = await videosService.initiateUpload(ownerId, {
        file_name: 'clip.mp4',
        size_bytes: 1024,
        content_type: 'video/mp4',
      });
      const {
        parts: [part],
      } = await videosService.signPartUrls(ownerId, video.id, [1]);

      await videosService.abortUpload(ownerId, video.id);

      expect(await videoRepository.findOneBy({ id: video.id })).toBeNull();
      const res = await fetch(part.url, {
        method: 'PUT',
        body: randomBytes(1024),
      });
      expect(res.status).toBe(404);
    });
  });
});
