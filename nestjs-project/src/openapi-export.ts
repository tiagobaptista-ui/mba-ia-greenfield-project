import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { AppModule } from './app.module';
import swaggerMetadata from './metadata';
import { buildSwaggerDocument } from './swagger/swagger-document';

export async function exportSpec(outputPath = 'openapi.json'): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  // ts-node/ts-jest skip the Swagger CLI plugin; the generated metadata (npm run
  // openapi:metadata) supplies the DTO schemas `nest build` would inject.
  await SwaggerModule.loadPluginMetadata(swaggerMetadata);
  const document = buildSwaggerDocument(app);
  writeFileSync(outputPath, JSON.stringify(document, null, 2));
  await app.close();
}

if (require.main === module) {
  void exportSpec();
}
