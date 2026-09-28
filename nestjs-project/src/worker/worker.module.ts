import { Module } from '@nestjs/common';
import { rootConfigModule } from '../config/root-config';
import { rootTypeOrmModule } from '../database/root-typeorm';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { VideosModule } from '../videos/videos.module';
import { VideoProcessor } from './video.processor';

/**
 * Root module of the video worker process (phase-03-videos/TD-06): same config and
 * database as the API, no HTTP layer. Registering `VideoProcessor` here — and only
 * here — is what makes this process, not the API, consume `video-processing`.
 */
@Module({
  imports: [
    rootConfigModule,
    rootTypeOrmModule,
    QueueModule,
    StorageModule,
    MediaModule,
    VideosModule,
    // autoLoadEntities only knows entities registered via forFeature: Video → Channel →
    // User must all be loaded, and User is owned by UsersModule (the API gets it via Auth).
    UsersModule,
  ],
  providers: [VideoProcessor],
})
export class WorkerModule {}
