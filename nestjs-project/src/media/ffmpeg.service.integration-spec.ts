import { Test } from '@nestjs/testing';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestMediaDir,
  generateNotAVideo,
  generateTestVideo,
  type TestMediaDir,
} from '../test/video-fixture';
import { FfmpegService } from './ffmpeg.service';
import { MediaModule } from './media.module';
import { InvalidMediaError } from './media.errors';

describe('FfmpegService (integration)', () => {
  let service: FfmpegService;
  let media: TestMediaDir;
  let clipPath: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();
    service = moduleRef.get(FfmpegService);

    media = await createTestMediaDir();
    clipPath = await generateTestVideo(media.dir);
  }, 60_000);

  afterAll(async () => {
    await media.cleanup();
  });

  it('probes duration and metadata of a real clip', async () => {
    const result = await service.probe(clipPath);

    expect(result.duration_seconds).toBeCloseTo(3, 0);
    expect(result.metadata).toMatchObject({
      video_codec: 'h264',
      audio_codec: 'aac',
      width: 320,
      height: 240,
      fps: 25,
    });
    expect(result.metadata.container).toContain('mp4');
    expect(result.metadata.bitrate).toBeGreaterThan(0);
  });

  it('rejects a file that is not a video with InvalidMediaError', async () => {
    const fakePath = await generateNotAVideo(media.dir);

    await expect(service.probe(fakePath)).rejects.toBeInstanceOf(
      InvalidMediaError,
    );
  });

  it('extracts a non-empty JPEG frame', async () => {
    const outputPath = join(media.dir, 'thumb.jpg');

    await service.extractFrame(clipPath, 0.3, outputPath);

    const info = await stat(outputPath);
    expect(info.size).toBeGreaterThan(0);
    const bytes = await readFile(outputPath);
    // JPEG SOI marker
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});
