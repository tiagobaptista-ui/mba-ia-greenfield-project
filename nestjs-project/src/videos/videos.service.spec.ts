import { QueryFailedError } from 'typeorm';
import type { ChannelsService } from '../channels/channels.service';
import type { Channel } from '../channels/entities/channel.entity';
import {
  UnsupportedVideoFormatException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import type storageConfig from '../config/storage.config';
import type { ConfigType } from '@nestjs/config';
import type { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

type PgUniqueViolationError = QueryFailedError & {
  code: string;
  detail: string;
};

function makeUniqueError(column: string): QueryFailedError {
  const err = new QueryFailedError(
    'INSERT',
    [],
    new Error(),
  ) as PgUniqueViolationError;
  err.code = '23505';
  err.detail = `Key (${column})=(abc) already exists.`;
  return err;
}

const PART_SIZE = 64 * 1024 * 1024;
const TEN_GIB = 10 * 1024 * 1024 * 1024;

describe('VideosService — initiateUpload (unit)', () => {
  const userId = 'user-1';
  const channel = { id: 'channel-1' } as Channel;

  let manager: {
    query: jest.Mock;
    create: jest.Mock;
    save: jest.Mock<Promise<Video>, [Video]>;
  };
  let dataSource: { transaction: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock<Promise<string>, [string, string]>;
    abortMultipartUpload: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let service: VideosService;

  beforeEach(() => {
    manager = {
      query: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(
        (_entity: unknown, fields: Partial<Video>) => fields as Video,
      ),
      save: jest.fn((video: Video) => Promise.resolve(video)),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => Promise<Video>) =>
        cb(manager),
      ),
    };
    storageService = {
      createMultipartUpload: jest
        .fn<Promise<string>, [string, string]>()
        .mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    };
    const config = {
      uploadPartSizeBytes: PART_SIZE,
    } as ConfigType<typeof storageConfig>;
    service = new VideosService(
      {} as never,
      dataSource as never,
      storageService as unknown as StorageService,
      channelsService as unknown as ChannelsService,
      config,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const dto = (overrides: Partial<CreateVideoDto> = {}): CreateVideoDto => ({
    file_name: 'minha-viagem.mp4',
    size_bytes: 1024,
    content_type: 'video/mp4',
    ...overrides,
  });

  it('should create a draft with the file name (no extension) as default title and an 11-char slug', async () => {
    const video = await service.initiateUpload(userId, dto());

    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.title).toBe('minha-viagem');
    expect(video.channel_id).toBe(channel.id);
    expect(video.upload_id).toBe('upload-1');
    expect(video.slug).toMatch(/^[0-9A-Za-z]{11}$/);
    expect(video.storage_key).toBe(`videos/${video.id}/original`);
    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      `videos/${video.id}/original`,
      'video/mp4',
    );
  });

  it('should keep an explicit title', async () => {
    const video = await service.initiateUpload(
      userId,
      dto({ title: 'Férias 2026' }),
    );

    expect(video.title).toBe('Férias 2026');
  });

  it('should compute part_count as ceil(size / part size) with a minimum of 1', async () => {
    const small = await service.initiateUpload(userId, dto({ size_bytes: 1 }));
    const exact = await service.initiateUpload(
      userId,
      dto({ size_bytes: 2 * PART_SIZE }),
    );
    const max = await service.initiateUpload(
      userId,
      dto({ size_bytes: TEN_GIB }),
    );

    expect(small.part_count).toBe(1);
    expect(exact.part_count).toBe(2);
    expect(max.part_count).toBe(160);
    expect(max.part_size_bytes).toBe(PART_SIZE);
  });

  it('should reject a declared size above 10 GiB without opening a multipart upload', async () => {
    await expect(
      service.initiateUpload(userId, dto({ size_bytes: TEN_GIB + 1 })),
    ).rejects.toBeInstanceOf(VideoTooLargeException);
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a non-video content type',
      { file_name: 'doc.pdf', content_type: 'application/pdf' },
    ],
    [
      'a disallowed extension',
      { file_name: 'notes.txt', content_type: 'video/mp4' },
    ],
    [
      'a content type that does not match the extension',
      { file_name: 'clip.mp4', content_type: 'video/webm' },
    ],
  ])(
    'should reject %s with UNSUPPORTED_VIDEO_FORMAT',
    async (_label, overrides) => {
      await expect(
        service.initiateUpload(userId, dto(overrides)),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    },
  );

  it('should retry with a new slug when the slug collides', async () => {
    manager.save
      .mockRejectedValueOnce(makeUniqueError('slug'))
      .mockImplementationOnce((video: Video) => Promise.resolve(video));

    const video = await service.initiateUpload(userId, dto());

    expect(manager.save).toHaveBeenCalledTimes(2);
    const firstSlug = manager.save.mock.calls[0][0].slug;
    expect(video.slug).not.toBe(firstSlug);
    expect(manager.query).toHaveBeenCalledWith(
      'ROLLBACK TO SAVEPOINT video_slug_attempt_0',
    );
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('should abort the multipart upload and rethrow when persisting the draft fails', async () => {
    const failure = new Error('db down');
    manager.save.mockRejectedValueOnce(failure);

    await expect(service.initiateUpload(userId, dto())).rejects.toBe(failure);
    const key = storageService.createMultipartUpload.mock.calls[0][0];
    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      key,
      'upload-1',
    );
  });
});
