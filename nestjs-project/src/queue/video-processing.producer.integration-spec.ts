import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import queueConfig from '../config/queue.config';
import { obliterateQueue } from '../test/queue';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './queue.constants';
import { QueueModule } from './queue.module';
import type { ProcessVideoJobData } from './queue.types';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration — real Redis)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    producer = moduleRef.get(VideoProcessingProducer);
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  beforeEach(async () => {
    await obliterateQueue(queue);
  });

  afterAll(async () => {
    await obliterateQueue(queue);
    await moduleRef.close();
  });

  it('should add a process-video job with the video id as payload and jobId', async () => {
    const videoId = randomUUID();

    await producer.enqueueVideoProcessing(videoId);

    const waiting = await queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].name).toBe(PROCESS_VIDEO_JOB);
    expect(waiting[0].id).toBe(videoId);
    expect(waiting[0].data).toEqual({ videoId });
  });

  it('should not duplicate the job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueueVideoProcessing(videoId);
    await producer.enqueueVideoProcessing(videoId);

    expect(await queue.getJobCountByTypes('waiting')).toBe(1);
  });

  it('should create the job with 3 attempts and exponential backoff of 1000 ms', async () => {
    const videoId = randomUUID();

    await producer.enqueueVideoProcessing(videoId);

    const job = await queue.getJob(videoId);
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
  });

  it('should store the queue keys under the configured QUEUE_PREFIX', async () => {
    const videoId = randomUUID();
    const { prefix } = queueConfig();

    await producer.enqueueVideoProcessing(videoId);

    expect(prefix).toBe('streamtube-test');
    expect(queue.qualifiedName).toBe(`${prefix}:${VIDEO_PROCESSING_QUEUE}`);
    expect(queue.toKey(videoId)).toBe(
      `${prefix}:${VIDEO_PROCESSING_QUEUE}:${videoId}`,
    );
    expect(await queue.getJob(videoId)).toBeDefined();
  });
});
