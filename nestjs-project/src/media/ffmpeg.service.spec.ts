import { normalizeProbeOutput, thumbnailPosition } from './ffmpeg.service';
import { InvalidMediaError } from './media.errors';
import type { FfprobeOutput } from './media.types';

const videoStream = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
  avg_frame_rate: '30000/1001',
  r_frame_rate: '30000/1001',
};

describe('normalizeProbeOutput', () => {
  it('maps a video with audio to duration and metadata', () => {
    const output: FfprobeOutput = {
      format: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        duration: '12.500000',
        bit_rate: '4500000',
      },
      streams: [videoStream, { codec_type: 'audio', codec_name: 'aac' }],
    };

    expect(normalizeProbeOutput(output)).toEqual({
      duration_seconds: 12.5,
      metadata: {
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        video_codec: 'h264',
        audio_codec: 'aac',
        width: 1920,
        height: 1080,
        fps: 29.97,
        bitrate: 4500000,
      },
    });
  });

  it('reports a null audio codec for a video without audio', () => {
    const result = normalizeProbeOutput({
      format: { format_name: 'matroska,webm', duration: '5' },
      streams: [{ ...videoStream, codec_name: 'vp9' }],
    });

    expect(result.metadata.audio_codec).toBeNull();
    expect(result.metadata.video_codec).toBe('vp9');
    expect(result.metadata.bitrate).toBeNull();
  });

  it('falls back to the stream duration and r_frame_rate when the format omits them', () => {
    const result = normalizeProbeOutput({
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
      streams: [
        {
          ...videoStream,
          avg_frame_rate: '0/0',
          r_frame_rate: '25/1',
          duration: '7.2',
        },
      ],
    });

    expect(result.duration_seconds).toBe(7.2);
    expect(result.metadata.fps).toBe(25);
  });

  it('rejects an input without a video stream', () => {
    expect(() =>
      normalizeProbeOutput({
        format: { format_name: 'mp3', duration: '180' },
        streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
      }),
    ).toThrow(InvalidMediaError);
  });

  it('rejects a video without a positive duration', () => {
    expect(() =>
      normalizeProbeOutput({
        format: { format_name: 'image2', duration: 'N/A' },
        streams: [videoStream],
      }),
    ).toThrow(InvalidMediaError);
  });
});

describe('thumbnailPosition', () => {
  it('uses 10% of the duration for short videos', () => {
    expect(thumbnailPosition(3)).toBeCloseTo(0.3);
  });

  it('caps the position at 60 seconds for long videos', () => {
    expect(thumbnailPosition(3600)).toBe(60);
  });
});
