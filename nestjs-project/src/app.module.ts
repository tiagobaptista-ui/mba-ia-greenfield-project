import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { rootConfigModule } from './config/root-config';
import { rootTypeOrmModule } from './database/root-typeorm';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [rootConfigModule, rootTypeOrmModule, AuthModule, VideosModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
