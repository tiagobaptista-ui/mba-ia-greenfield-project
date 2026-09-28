import { Test } from '@nestjs/testing';
import { UnrecoverableError, type Job } from 'bullmq';
import { writeFile } from 'node:fs/promises';
import { FfmpegService } from '../media/ffmpeg.service';
import { InvalidMediaError } from '../media/media.errors';
import type { ProbeResult } from '../media/media.types';
import type { ProcessVideoJobData } from '../queue/queue.types';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideosService } from '../videos/videos.service';
import { VideoProcessor } from './video.processor';

const VIDEO_ID = '5b0c8a4e-6f7d-4a53-9b1e-2f4f0d6a9c11';
const SOURCE_URL = 'http://minio:9000/streamtube-media/videos/x/original?sig';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

const probeResult: ProbeResult = {
  duration_seconds: 3,
  metadata: {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    video_codec: 'h264',
    audio_codec: 'aac',
    width: 320,
    height: 240,
    fps: 25,
    bitrate: 180000,
  },
};

function buildJob(attemptsMade = 0, attempts = 3): Job<ProcessVideoJobData> {
  return {
    data: { videoId: VIDEO_ID },
    attemptsMade,
    opts: { attempts },
  } as Job<ProcessVideoJobData>;
}

function buildVideo(status: VideoStatus): Video {
  return {
    id: VIDEO_ID,
    status,
    storage_key: `videos/${VIDEO_ID}/original`,
  } as Video;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  const videosService = {
    findForProcessing: jest.fn<Promise<Video | null>, [string]>(),
    markProcessed: jest.fn<Promise<void>, [string, unknown]>(),
    markFailed: jest.fn<Promise<void>, [string, string]>(),
  };
  const storageService = {
    headObjectSize: jest.fn<Promise<number>, [string]>(),
    presignInternalGetObject: jest.fn<Promise<string>, [string]>(),
    putObject: jest.fn<Promise<void>, [string, Buffer, string]>(),
  };
  const ffmpegService = {
    probe: jest.fn<Promise<ProbeResult>, [string]>(),
    extractFrame: jest.fn<Promise<void>, [string, number, string]>(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    videosService.findForProcessing.mockResolvedValue(
      buildVideo(VideoStatus.PROCESSING),
    );
    storageService.headObjectSize.mockResolvedValue(4096);
    storageService.presignInternalGetObject.mockResolvedValue(SOURCE_URL);
    ffmpegService.probe.mockResolvedValue(probeResult);
    ffmpegService.extractFrame.mockImplementation(async (_input, _pos, out) =>
      writeFile(out, JPEG),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: VideosService, useValue: videosService },
        { provide: StorageService, useValue: storageService },
        { provide: FfmpegService, useValue: ffmpegService },
      ],
    }).compile();
    processor = moduleRef.get(VideoProcessor);
  });

  it('should probe, store the thumbnail and mark the video ready', async () => {
    await expect(processor.process(buildJob())).resolves.toBe('ready');

    expect(ffmpegService.probe).toHaveBeenCalledWith(SOURCE_URL);
    expect(ffmpegService.extractFrame).toHaveBeenCalledWith(
      SOURCE_URL,
      expect.closeTo(0.3) as number,
      expect.stringMatching(/thumbnail\.jpg$/) as string,
    );
    expect(storageService.putObject).toHaveBeenCalledWith(
      `thumbnails/${VIDEO_ID}.jpg`,
      JPEG,
      'image/jpeg',
    );
    expect(videosService.markProcessed).toHaveBeenCalledWith(VIDEO_ID, {
      ...probeResult,
      thumbnail_key: `thumbnails/${VIDEO_ID}.jpg`,
    });
    expect(videosService.markFailed).not.toHaveBeenCalled();
  });

  it.each([VideoStatus.READY, VideoStatus.FAILED, VideoStatus.DRAFT])(
    'should skip a video in status %s without touching it',
    async (status) => {
      videosService.findForProcessing.mockResolvedValue(buildVideo(status));

      await expect(processor.process(buildJob())).resolves.toBe('skipped');

      expect(ffmpegService.probe).not.toHaveBeenCalled();
      expect(videosService.markProcessed).not.toHaveBeenCalled();
      expect(videosService.markFailed).not.toHaveBeenCalled();
    },
  );

  it('should skip a job whose video no longer exists', async () => {
    videosService.findForProcessing.mockResolvedValue(null);

    await expect(processor.process(buildJob())).resolves.toBe('skipped');
    expect(ffmpegService.probe).not.toHaveBeenCalled();
  });

  it('should fail the video and stop retries when the media is invalid', async () => {
    ffmpegService.probe.mockRejectedValue(
      new InvalidMediaError('No video stream found in the input'),
    );

    await expect(processor.process(buildJob(0, 3))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(videosService.markFailed).toHaveBeenCalledWith(
      VIDEO_ID,
      'No video stream found in the input',
    );
    expect(storageService.putObject).not.toHaveBeenCalled();
  });

  it('should rethrow a transient failure on attempt 1 of 3 without failing the video', async () => {
    const transient = new Error('connect ECONNREFUSED minio:9000');
    storageService.headObjectSize.mockRejectedValue(transient);

    await expect(processor.process(buildJob(0, 3))).rejects.toBe(transient);
    expect(videosService.markFailed).not.toHaveBeenCalled();
  });

  it('should fail the video when the last attempt fails', async () => {
    const transient = new Error('ffmpeg failed to extract a frame');
    ffmpegService.extractFrame.mockRejectedValue(transient);

    await expect(processor.process(buildJob(2, 3))).rejects.toBe(transient);
    expect(videosService.markFailed).toHaveBeenCalledWith(
      VIDEO_ID,
      'ffmpeg failed to extract a frame',
    );
    expect(videosService.markProcessed).not.toHaveBeenCalled();
  });
});
