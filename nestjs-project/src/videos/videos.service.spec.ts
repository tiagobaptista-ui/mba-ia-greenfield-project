import { S3ServiceException } from '@aws-sdk/client-s3';
import { QueryFailedError } from 'typeorm';
import type { ChannelsService } from '../channels/channels.service';
import type { Channel } from '../channels/entities/channel.entity';
import {
  InvalidPartNumberException,
  InvalidUploadPartsException,
  InvalidVideoStateException,
  UnsupportedVideoFormatException,
  UploadSizeMismatchException,
  VideoAccessDeniedException,
  VideoNotFoundException,
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
      {} as never,
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

describe('VideosService — upload lifecycle (unit)', () => {
  const ownerId = 'owner-1';
  const ownChannel = { id: 'channel-1' } as Channel;
  const otherChannel = { id: 'channel-2' } as Channel;
  const MAX = 10 * 1024 * 1024 * 1024;

  let videoRepository: {
    findOne: jest.Mock<Promise<Video | null>, [unknown]>;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let storageService: {
    presignUploadPart: jest.Mock<Promise<string>, [string, string, number]>;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    headObjectSize: jest.Mock<Promise<number>, [string]>;
    deleteObject: jest.Mock;
    presignExpiresSeconds: number;
  };
  let channelsService: { findByUserId: jest.Mock<Promise<Channel>, [string]> };
  let producer: { enqueueVideoProcessing: jest.Mock };
  let service: VideosService;

  const draftVideo = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-1',
      channel_id: ownChannel.id,
      slug: 'AbCdEfGhIjK',
      title: 'clip',
      status: VideoStatus.DRAFT,
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 3000,
      storage_key: 'videos/video-1/original',
      upload_id: 'upload-1',
      part_size_bytes: 1000,
      part_count: 3,
      thumbnail_key: null,
      duration_seconds: null,
      metadata: null,
      processing_error: null,
      ...overrides,
    }) as Video;

  const allParts = [
    { part_number: 1, etag: '"a"' },
    { part_number: 2, etag: '"b"' },
    { part_number: 3, etag: '"c"' },
  ];

  beforeEach(() => {
    videoRepository = {
      findOne: jest
        .fn<Promise<Video | null>, [unknown]>()
        .mockResolvedValue(draftVideo()),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    storageService = {
      presignUploadPart: jest.fn<Promise<string>, [string, string, number]>(
        (_key, _uploadId, partNumber) =>
          Promise.resolve(`http://minio:9000/part-${partNumber}`),
      ),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObjectSize: jest
        .fn<Promise<number>, [string]>()
        .mockResolvedValue(3000),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      presignExpiresSeconds: 3600,
    };
    channelsService = {
      findByUserId: jest
        .fn<Promise<Channel>, [string]>()
        .mockResolvedValue(ownChannel),
    };
    producer = {
      enqueueVideoProcessing: jest.fn().mockResolvedValue(undefined),
    };
    service = new VideosService(
      videoRepository as never,
      {} as never,
      storageService as unknown as StorageService,
      channelsService as unknown as ChannelsService,
      producer as never,
      { uploadPartSizeBytes: 1000 } as ConfigType<typeof storageConfig>,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('findOwnedVideo', () => {
    it('should throw VIDEO_NOT_FOUND when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValueOnce(null);

      await expect(
        service.findOwnedVideo(ownerId, 'missing'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should throw VIDEO_ACCESS_DENIED when the video belongs to another channel', async () => {
      channelsService.findByUserId.mockResolvedValueOnce(otherChannel);

      await expect(
        service.findOwnedVideo('intruder', 'video-1'),
      ).rejects.toBeInstanceOf(VideoAccessDeniedException);
    });
  });

  describe('signPartUrls', () => {
    it('should return one presigned URL per requested part and the expiry', async () => {
      const result = await service.signPartUrls(ownerId, 'video-1', [1, 3]);

      expect(result).toEqual({
        parts: [
          { part_number: 1, url: 'http://minio:9000/part-1' },
          { part_number: 3, url: 'http://minio:9000/part-3' },
        ],
        expires_in_seconds: 3600,
      });
    });

    it('should reject part numbers outside 1..part_count', async () => {
      await expect(
        service.signPartUrls(ownerId, 'video-1', [1, 4]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should reject a video that is not a draft', async () => {
      videoRepository.findOne.mockResolvedValueOnce(
        draftVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.signPartUrls(ownerId, 'video-1', [1]),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
    });
  });

  describe('completeUpload', () => {
    it('should complete, move the video to processing and enqueue it', async () => {
      const result = await service.completeUpload(ownerId, 'video-1', allParts);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        [
          { partNumber: 1, etag: '"a"' },
          { partNumber: 2, etag: '"b"' },
          { partNumber: 3, etag: '"c"' },
        ],
      );
      expect(videoRepository.update).toHaveBeenCalledWith('video-1', {
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      expect(producer.enqueueVideoProcessing).toHaveBeenCalledWith('video-1');
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });

    it.each([
      ['a missing part', allParts.slice(0, 2)],
      [
        'a duplicated part',
        [...allParts.slice(0, 2), { part_number: 2, etag: '"x"' }],
      ],
      [
        'a part outside the plan',
        [...allParts.slice(0, 2), { part_number: 4, etag: '"d"' }],
      ],
    ])(
      'should reject %s with INVALID_UPLOAD_PARTS before calling storage',
      async (_label, parts) => {
        await expect(
          service.completeUpload(ownerId, 'video-1', parts),
        ).rejects.toBeInstanceOf(InvalidUploadPartsException);
        expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
        expect(producer.enqueueVideoProcessing).not.toHaveBeenCalled();
      },
    );

    it('should map a 4xx storage rejection to INVALID_UPLOAD_PARTS and keep the draft', async () => {
      storageService.completeMultipartUpload.mockRejectedValueOnce(
        new S3ServiceException({
          name: 'InvalidPart',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
          message: 'One or more of the specified parts could not be found',
        }),
      );

      await expect(
        service.completeUpload(ownerId, 'video-1', allParts),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(producer.enqueueVideoProcessing).not.toHaveBeenCalled();
    });

    it('should rethrow a non-client storage failure unchanged', async () => {
      const failure = new Error('connection reset');
      storageService.completeMultipartUpload.mockRejectedValueOnce(failure);

      await expect(
        service.completeUpload(ownerId, 'video-1', allParts),
      ).rejects.toBe(failure);
    });

    it.each([
      ['differs from the declared size', 2999],
      ['exceeds 10 GiB', MAX + 1],
    ])(
      'should delete the object and fail the video when the real size %s',
      async (_label, realSize) => {
        storageService.headObjectSize.mockResolvedValueOnce(realSize);
        if (realSize > MAX) {
          videoRepository.findOne.mockResolvedValueOnce(
            draftVideo({ size_bytes: realSize }),
          );
        }

        await expect(
          service.completeUpload(ownerId, 'video-1', allParts),
        ).rejects.toBeInstanceOf(UploadSizeMismatchException);
        expect(storageService.deleteObject).toHaveBeenCalledWith(
          'videos/video-1/original',
        );
        expect(videoRepository.update).toHaveBeenCalledWith(
          'video-1',
          expect.objectContaining({
            status: VideoStatus.FAILED,
            upload_id: null,
          }) as unknown,
        );
        expect(producer.enqueueVideoProcessing).not.toHaveBeenCalled();
      },
    );
  });

  describe('abortUpload', () => {
    it('should abort the multipart upload and delete the draft', async () => {
      await service.abortUpload(ownerId, 'video-1');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
      );
      expect(videoRepository.delete).toHaveBeenCalledWith('video-1');
    });

    it('should reject a video that is not a draft', async () => {
      videoRepository.findOne.mockResolvedValueOnce(
        draftVideo({ status: VideoStatus.READY, upload_id: null }),
      );

      await expect(
        service.abortUpload(ownerId, 'video-1'),
      ).rejects.toBeInstanceOf(InvalidVideoStateException);
      expect(videoRepository.delete).not.toHaveBeenCalled();
    });
  });
});

describe('VideosService — getPlaybackUrl (unit)', () => {
  const SIGNED = 'http://localhost:9000/streamtube-media/signed';

  let videoRepository: {
    findOneBy: jest.Mock<Promise<Video | null>, [unknown]>;
  };
  let storageService: {
    presignGetObject: jest.Mock<
      Promise<string>,
      [string, { downloadFileName?: string }?]
    >;
  };
  let service: VideosService;

  const readyVideo = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-1',
      slug: 'AbCdEfGhIjK',
      status: VideoStatus.READY,
      original_file_name: 'minha viagem.mp4',
      storage_key: 'videos/video-1/original',
      thumbnail_key: 'thumbnails/video-1.jpg',
      ...overrides,
    }) as Video;

  beforeEach(() => {
    videoRepository = {
      findOneBy: jest
        .fn<Promise<Video | null>, [unknown]>()
        .mockResolvedValue(readyVideo()),
    };
    storageService = {
      presignGetObject: jest
        .fn<Promise<string>, [string, { downloadFileName?: string }?]>()
        .mockResolvedValue(SIGNED),
    };
    service = new VideosService(
      videoRepository as never,
      {} as never,
      storageService as unknown as StorageService,
      {} as never,
      {} as never,
      {} as ConfigType<typeof storageConfig>,
    );
  });

  it('should sign the original for streaming a ready video, looked up by slug', async () => {
    await expect(service.getPlaybackUrl('AbCdEfGhIjK', 'stream')).resolves.toBe(
      SIGNED,
    );
    expect(videoRepository.findOneBy).toHaveBeenCalledWith({
      slug: 'AbCdEfGhIjK',
    });
    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      'videos/video-1/original',
    );
  });

  it('should sign the original as an attachment named after the uploaded file for download', async () => {
    await service.getPlaybackUrl('AbCdEfGhIjK', 'download');

    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      'videos/video-1/original',
      { downloadFileName: 'minha viagem.mp4' },
    );
  });

  it('should sign the thumbnail object for the thumbnail', async () => {
    await service.getPlaybackUrl('AbCdEfGhIjK', 'thumbnail');

    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      'thumbnails/video-1.jpg',
    );
  });

  it('should throw VIDEO_NOT_FOUND for an unknown slug', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(
      service.getPlaybackUrl('unknown0000', 'stream'),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
    expect(storageService.presignGetObject).not.toHaveBeenCalled();
  });

  it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
    'should throw VIDEO_NOT_FOUND for a %s video',
    async (status) => {
      videoRepository.findOneBy.mockResolvedValue(readyVideo({ status }));

      await expect(
        service.getPlaybackUrl('AbCdEfGhIjK', 'download'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    },
  );
});
