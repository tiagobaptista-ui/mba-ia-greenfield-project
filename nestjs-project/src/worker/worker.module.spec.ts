import { MODULE_METADATA } from '@nestjs/common/constants';
import { WorkerHost } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { FfmpegService } from '../media/ffmpeg.service';
import { StorageService } from '../storage/storage.service';
import { VideosService } from '../videos/videos.service';
import { VideoProcessor } from './video.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should resolve VideoProcessor with its collaborators', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const processor = moduleRef.get(VideoProcessor);
    expect(processor).toBeInstanceOf(VideoProcessor);
    expect(processor).toBeInstanceOf(WorkerHost);
    expect(moduleRef.get(VideosService)).toBeInstanceOf(VideosService);
    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
    expect(moduleRef.get(FfmpegService)).toBeInstanceOf(FfmpegService);
    await moduleRef.close();
  }, 30000);

  it('should not declare controllers of its own', () => {
    const controllers = (Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      WorkerModule,
    ) ?? []) as unknown[];

    expect(controllers).toHaveLength(0);
  });
});
