import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TestMediaDir {
  dir: string;
  cleanup: () => Promise<void>;
}

export async function createTestMediaDir(): Promise<TestMediaDir> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-media-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Generates a small H.264/AAC MP4 with FFmpeg's synthetic sources (testsrc + sine),
 * so tests exercise the real ffprobe/ffmpeg without committing binary fixtures.
 */
export async function generateTestVideo(
  dir: string,
  { durationSeconds = 3, fileName = 'clip.mp4' } = {},
): Promise<string> {
  const output = join(dir, fileName);
  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=320x240:rate=25`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${durationSeconds}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    output,
  ]);
  return output;
}

/** A file with a video extension whose content is plain text (not a video). */
export async function generateNotAVideo(
  dir: string,
  fileName = 'fake.mp4',
): Promise<string> {
  const output = join(dir, fileName);
  await writeFile(output, 'this is definitely not a video\n'.repeat(64));
  return output;
}
