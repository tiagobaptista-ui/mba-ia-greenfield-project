import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { InvalidMediaError } from './media.errors';
import type { FfprobeOutput, ProbeResult } from './media.types';

const PROBE_TIMEOUT_MS = 60_000;
const FRAME_TIMEOUT_MS = 120_000;
const THUMBNAIL_POSITION_RATIO = 0.1;
const THUMBNAIL_POSITION_MAX_SECONDS = 60;

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Thin wrapper over the OS-packaged ffprobe/ffmpeg (phase-03-videos/TD-07). Inputs may be
 * local paths or (presigned) HTTP URLs — FFmpeg seeks remote inputs with Range requests,
 * so a 10GB original never has to be copied to local disk.
 */
@Injectable()
export class FfmpegService {
  async probe(input: string): Promise<ProbeResult> {
    const result = await runCommand(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      PROBE_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      throw new InvalidMediaError(
        `ffprobe could not read the input: ${lastLine(result.stderr)}`,
      );
    }
    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(result.stdout) as FfprobeOutput;
    } catch {
      throw new InvalidMediaError('ffprobe returned malformed output');
    }
    return normalizeProbeOutput(parsed);
  }

  async extractFrame(
    input: string,
    positionSeconds: number,
    outputPath: string,
  ): Promise<void> {
    const result = await runCommand(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        positionSeconds.toFixed(3),
        '-i',
        input,
        '-frames:v',
        '1',
        '-y',
        outputPath,
      ],
      FRAME_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      throw new Error(
        `ffmpeg failed to extract a frame: ${lastLine(result.stderr)}`,
      );
    }
  }
}

/** Frame used as thumbnail: 10% into the video (skips black intros), capped at 60 s. */
export function thumbnailPosition(durationSeconds: number): number {
  return Math.min(
    durationSeconds * THUMBNAIL_POSITION_RATIO,
    THUMBNAIL_POSITION_MAX_SECONDS,
  );
}

export function normalizeProbeOutput(output: FfprobeOutput): ProbeResult {
  const streams = output.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video) {
    throw new InvalidMediaError('No video stream found in the input');
  }
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  const duration =
    toNumber(output.format?.duration) ?? toNumber(video.duration);
  if (duration === null || duration <= 0) {
    throw new InvalidMediaError('Could not determine the video duration');
  }

  return {
    duration_seconds: duration,
    metadata: {
      container: output.format?.format_name ?? null,
      video_codec: video.codec_name ?? null,
      audio_codec: audio?.codec_name ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      fps:
        parseFrameRate(video.avg_frame_rate) ??
        parseFrameRate(video.r_frame_rate),
      bitrate: toNumber(output.format?.bit_rate),
    },
  };
}

function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return lines[lines.length - 1] || 'unknown error';
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
