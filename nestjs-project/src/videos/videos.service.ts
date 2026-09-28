import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  UnsupportedVideoFormatException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import {
  ACCEPTED_VIDEO_FORMATS,
  DEFAULT_VIDEO_TITLE,
  MAX_UPLOAD_PARTS,
  MAX_VIDEO_SIZE_BYTES,
  SLUG_COLUMN,
  SLUG_MAX_RETRIES,
} from './videos.constants';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Pre-registers the video as a draft and opens the S3 multipart upload the client
   * will PUT parts into directly (phase-03-videos/TD-04, TD-13).
   */
  async initiateUpload(userId: string, dto: CreateVideoDto): Promise<Video> {
    assertAcceptedFormat(dto.file_name, dto.content_type);
    if (dto.size_bytes > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const partSizeBytes = this.storage.uploadPartSizeBytes;
    const partCount = Math.max(1, Math.ceil(dto.size_bytes / partSizeBytes));
    if (partCount > MAX_UPLOAD_PARTS) {
      throw new VideoTooLargeException();
    }

    const id = randomUUID();
    const storageKey = videoOriginalKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    try {
      return await this.insertDraftWithUniqueSlug({
        id,
        channel_id: channel.id,
        title: dto.title ?? defaultTitle(dto.file_name),
        status: VideoStatus.DRAFT,
        original_file_name: dto.file_name,
        content_type: dto.content_type,
        size_bytes: dto.size_bytes,
        storage_key: storageKey,
        upload_id: uploadId,
        part_size_bytes: partSizeBytes,
        part_count: partCount,
      });
    } catch (err) {
      // Compensation: never leave an orphan multipart upload behind a failed insert.
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }
  }

  private async insertDraftWithUniqueSlug(
    fields: Omit<Partial<Video>, 'slug'>,
  ): Promise<Video> {
    return this.dataSource.transaction(async (manager) => {
      for (let attempt = 0; attempt < SLUG_MAX_RETRIES; attempt++) {
        // A failed INSERT aborts the transaction; the savepoint scopes the rollback to
        // this attempt so the next slug can be tried (typeorm-queries rule).
        const savepoint = `video_slug_attempt_${attempt}`;
        await manager.query(`SAVEPOINT ${savepoint}`);
        try {
          const video = await manager.save(
            manager.create(Video, { ...fields, slug: generateVideoSlug() }),
          );
          await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
          return video;
        } catch (err) {
          await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          if (!isPgUniqueViolationOnColumn(err, SLUG_COLUMN)) {
            throw err;
          }
        }
      }
      throw new Error(
        `Could not generate a unique video slug after ${SLUG_MAX_RETRIES} attempts`,
      );
    });
  }
}

function assertAcceptedFormat(fileName: string, contentType: string): void {
  const expectedContentType =
    ACCEPTED_VIDEO_FORMATS[extname(fileName).toLowerCase()];
  if (!expectedContentType || expectedContentType !== contentType) {
    throw new UnsupportedVideoFormatException();
  }
}

function defaultTitle(fileName: string): string {
  const withoutExtension = fileName
    .slice(0, fileName.length - extname(fileName).length)
    .trim();
  return (withoutExtension || DEFAULT_VIDEO_TITLE).slice(0, 100);
}
