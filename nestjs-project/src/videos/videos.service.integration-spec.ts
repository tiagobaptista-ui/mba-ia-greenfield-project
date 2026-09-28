import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
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
  let ownerId: string;
  let ownerChannelId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    videosService = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
  });

  beforeEach(async () => {
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
});
