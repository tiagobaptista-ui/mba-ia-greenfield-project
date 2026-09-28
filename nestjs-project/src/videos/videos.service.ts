import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { DataSource, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
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
import storageConfig from '../config/storage.config';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
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
  PROCESSING_ERROR_MAX_LENGTH,
  SLUG_COLUMN,
  SLUG_MAX_RETRIES,
} from './videos.constants';
import type {
  ProcessedVideoResult,
  SignedPartUrls,
  UploadedPartInput,
  VideoDetails,
} from './videos.types';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    private readonly videoProcessingProducer: VideoProcessingProducer,
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

  /** Loads a video the caller owns: missing → VIDEO_NOT_FOUND, other channel → VIDEO_ACCESS_DENIED. */
  async findOwnedVideo(userId: string, videoId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new VideoAccessDeniedException();
    }
    return video;
  }

  async getOwnedVideo(userId: string, videoId: string): Promise<VideoDetails> {
    return toVideoDetails(await this.findOwnedVideo(userId, videoId));
  }

  /** Signs `UploadPart` URLs in batch; the client PUTs each part straight to storage (TD-04). */
  async signPartUrls(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<SignedPartUrls> {
    const video = await this.findOwnedVideo(userId, videoId);
    const uploadId = assertUploadInProgress(video);
    if (partNumbers.some((n) => n < 1 || n > video.part_count)) {
      throw new InvalidPartNumberException();
    }

    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          uploadId,
          partNumber,
        ),
      })),
    );
    return {
      parts,
      expires_in_seconds: this.storageService.presignExpiresSeconds,
    };
  }

  /**
   * Finalizes the multipart upload, checks the real object size against the declared one
   * and hands the video to the worker queue (TD-05, TD-13).
   */
  async completeUpload(
    userId: string,
    videoId: string,
    parts: UploadedPartInput[],
  ): Promise<Video> {
    const video = await this.findOwnedVideo(userId, videoId);
    const uploadId = assertUploadInProgress(video);
    assertPartsCoverPlan(parts, video.part_count);

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        uploadId,
        parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (err) {
      if (isClientSideStorageError(err)) {
        throw new InvalidUploadPartsException(
          `Storage rejected the uploaded parts: ${err.name}`,
        );
      }
      throw err;
    }

    const realSize = await this.storageService.headObjectSize(
      video.storage_key,
    );
    if (realSize !== video.size_bytes || realSize > MAX_VIDEO_SIZE_BYTES) {
      await this.storageService.deleteObject(video.storage_key);
      await this.videoRepository.update(video.id, {
        status: VideoStatus.FAILED,
        upload_id: null,
        processing_error: truncate(
          `Uploaded size ${realSize} bytes does not match the declared ${video.size_bytes} bytes (limit ${MAX_VIDEO_SIZE_BYTES})`,
        ),
      });
      throw new UploadSizeMismatchException();
    }

    await this.videoRepository.update(video.id, {
      status: VideoStatus.PROCESSING,
      upload_id: null,
    });
    await this.videoProcessingProducer.enqueueVideoProcessing(video.id);
    return { ...video, status: VideoStatus.PROCESSING, upload_id: null };
  }

  /** Aborts an upload in progress and removes the draft (TD-10). */
  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedVideo(userId, videoId);
    const uploadId = assertUploadInProgress(video);
    await this.storageService.abortMultipartUpload(video.storage_key, uploadId);
    await this.videoRepository.delete(video.id);
  }

  /** Worker lookup: `null` means the job refers to a video that no longer exists. */
  async findForProcessing(videoId: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id: videoId });
  }

  /**
   * `processing → ready`. Guarded by the current status so a duplicate or late job can
   * never overwrite a video that already left `processing` (TD-10).
   */
  async markProcessed(
    videoId: string,
    result: ProcessedVideoResult,
  ): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: result.duration_seconds,
        metadata: result.metadata,
        thumbnail_key: result.thumbnail_key,
        processing_error: null,
      },
    );
  }

  /** `processing → failed` with the reason truncated to the column size (TD-10). */
  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, processing_error: truncate(reason) },
    );
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

function assertUploadInProgress(video: Video): string {
  if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
    throw new InvalidVideoStateException(
      `Upload operations require a draft video (current status: ${video.status})`,
    );
  }
  return video.upload_id;
}

function assertPartsCoverPlan(
  parts: UploadedPartInput[],
  partCount: number,
): void {
  const numbers = new Set(parts.map((part) => part.part_number));
  const coversPlan =
    parts.length === partCount &&
    numbers.size === partCount &&
    [...numbers].every((n) => n >= 1 && n <= partCount);
  if (!coversPlan) {
    throw new InvalidUploadPartsException(
      `Parts must cover exactly 1..${partCount} once each`,
    );
  }
}

// 4xx from S3 on CompleteMultipartUpload (InvalidPart, InvalidPartOrder, EntityTooSmall,
// NoSuchUpload, ...) means the client-provided parts are wrong, not an infrastructure fault.
function isClientSideStorageError(err: unknown): err is S3ServiceException {
  if (!(err instanceof S3ServiceException)) return false;
  const status = err.$metadata?.httpStatusCode ?? 0;
  return status >= 400 && status < 500;
}

function truncate(message: string): string {
  return message.slice(0, PROCESSING_ERROR_MAX_LENGTH);
}

function toVideoDetails(video: Video): VideoDetails {
  return {
    id: video.id,
    slug: video.slug,
    title: video.title,
    status: video.status,
    original_file_name: video.original_file_name,
    content_type: video.content_type,
    size_bytes: video.size_bytes,
    duration_seconds: video.duration_seconds,
    metadata: video.metadata,
    has_thumbnail: video.thumbnail_key !== null,
    processing_error: video.processing_error,
    created_at: video.created_at,
    updated_at: video.updated_at,
  };
}
