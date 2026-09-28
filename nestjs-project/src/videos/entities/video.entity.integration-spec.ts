import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const TEN_GIB = 10 * 1024 * 1024 * 1024;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `owner${n}`,
        nickname: `owner${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Video {
    const id = randomUUID();
    return videoRepository.create({
      id,
      channel_id: channelId,
      slug: `slug${String(++counter).padStart(7, '0')}`,
      title: 'Meu vídeo',
      original_file_name: 'meu-video.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: `videos/${id}/original`,
      upload_id: 'upload-1',
      part_size_bytes: 64 * 1024 * 1024,
      part_count: 1,
      ...overrides,
    });
  }

  it('should persist the application-generated id and default status to draft', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id);

    await videoRepository.save(video);
    const stored = await videoRepository.findOneByOrFail({ id: video.id });

    expect(stored.id).toBe(video.id);
    expect(stored.status).toBe(VideoStatus.DRAFT);
    expect(stored.thumbnail_key).toBeNull();
    expect(stored.duration_seconds).toBeNull();
    expect(stored.metadata).toBeNull();
  });

  it('should enforce the unique slug constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, { slug: 'AbCdEfGhIjK' }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { slug: 'AbCdEfGhIjK' })),
    ).rejects.toThrow();
  });

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id);
    await videoRepository.save(video);

    await expect(
      dataSource.query(
        `UPDATE "videos" SET "status" = 'published' WHERE "id" = $1`,
        [video.id],
      ),
    ).rejects.toThrow();
  });

  it('should delete the videos of a channel when the channel is deleted', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id);
    await videoRepository.save(video);

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.findOneBy({ id: video.id })).toBeNull();
  });

  it('should read a 10 GiB size_bytes back as a number', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id, { size_bytes: TEN_GIB });
    await videoRepository.save(video);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });

    expect(stored.size_bytes).toBe(TEN_GIB);
    expect(typeof stored.size_bytes).toBe('number');
  });

  it('should round-trip the metadata jsonb and duration', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id, {
      status: VideoStatus.READY,
      duration_seconds: 3.04,
      metadata: {
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        video_codec: 'h264',
        audio_codec: 'aac',
        width: 320,
        height: 240,
        fps: 25,
        bitrate: 123456,
      },
    });
    await videoRepository.save(video);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });

    expect(stored.duration_seconds).toBeCloseTo(3.04);
    expect(stored.metadata).toEqual(video.metadata);
  });
});
