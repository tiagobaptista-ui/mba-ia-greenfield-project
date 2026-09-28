import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegService, thumbnailPosition } from '../media/ffmpeg.service';
import { InvalidMediaError } from '../media/media.errors';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import type { ProcessVideoJobData } from '../queue/queue.types';
import { videoThumbnailKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video.entity';
import { VideosService } from '../videos/videos.service';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

export type ProcessVideoOutcome = 'ready' | 'skipped';

/**
 * Consumes `process-video` jobs (phase-03-videos/TD-06, TD-07): probes the original
 * straight from storage over a presigned GET, extracts a thumbnail frame, stores it and
 * moves the video to `ready`. Only the worker entrypoint registers this provider, so the
 * API process never consumes jobs.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<ProcessVideoOutcome> {
    const { videoId } = job.data;
    const video = await this.videosService.findForProcessing(videoId);
    if (!video || video.status !== VideoStatus.PROCESSING) {
      // Duplicate or stale job (video deleted, already ready/failed): nothing to do.
      this.logger.warn(
        `process-video ${videoId}: skipped (status ${video?.status ?? 'missing'})`,
      );
      return 'skipped';
    }

    this.logger.log(
      `process-video ${videoId}: attempt ${job.attemptsMade + 1}/${maxAttempts(job)}`,
    );
    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    try {
      // HEAD first so an unreachable storage or a missing object surfaces as a
      // transient storage error (retried) instead of ffprobe's "unreadable input".
      await this.storageService.headObjectSize(video.storage_key);
      const source = await this.storageService.presignInternalGetObject(
        video.storage_key,
      );

      const { duration_seconds, metadata } =
        await this.ffmpegService.probe(source);

      const thumbnailPath = join(workDir, 'thumbnail.jpg');
      await this.ffmpegService.extractFrame(
        source,
        thumbnailPosition(duration_seconds),
        thumbnailPath,
      );
      const thumbnailKey = videoThumbnailKey(videoId);
      await this.storageService.putObject(
        thumbnailKey,
        await readFile(thumbnailPath),
        THUMBNAIL_CONTENT_TYPE,
      );

      await this.videosService.markProcessed(videoId, {
        duration_seconds,
        metadata,
        thumbnail_key: thumbnailKey,
      });
      this.logger.log(
        `process-video ${videoId}: ready (${duration_seconds.toFixed(2)} s)`,
      );
      return 'ready';
    } catch (err) {
      await this.handleFailure(job, err);
      throw err instanceof InvalidMediaError
        ? new UnrecoverableError(err.message)
        : err;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * TD-10/TD-13: invalid media fails the video at once (no retries); any other error
   * only fails it on the last attempt — earlier attempts rethrow so BullMQ retries with
   * exponential backoff while the video stays `processing`.
   */
  private async handleFailure(
    job: Job<ProcessVideoJobData>,
    err: unknown,
  ): Promise<void> {
    const reason = err instanceof Error ? err.message : String(err);
    const terminal =
      err instanceof InvalidMediaError ||
      job.attemptsMade + 1 >= maxAttempts(job);
    this.logger.error(
      `process-video ${job.data.videoId}: ${terminal ? 'failed' : 'will retry'} — ${reason}`,
    );
    if (terminal) {
      await this.videosService.markFailed(job.data.videoId, reason);
    }
  }
}

function maxAttempts(job: Job): number {
  return job.opts.attempts ?? 1;
}
