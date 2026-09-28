import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

async function bootstrap(): Promise<void> {
  // Application context only: no HTTP server, no ports (phase-03-videos/TD-06).
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM → app.close() → the BullMQ worker finishes the current job before exiting.
  app.enableShutdownHooks();
  new Logger('VideoWorker').log('Consuming the video-processing queue');
}
void bootstrap();
