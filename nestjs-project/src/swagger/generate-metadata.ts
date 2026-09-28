import { PluginMetadataGenerator } from '@nestjs/cli/lib/compiler/plugins/plugin-metadata-generator';
// `@nestjs/swagger/plugin` re-exports this module without typings.
import { ReadonlyVisitor } from '@nestjs/swagger/dist/plugin';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const SOURCE_ROOT = join(PROJECT_ROOT, 'src');
export const METADATA_FILENAME = 'metadata.ts';

interface NestCliConfig {
  compilerOptions?: {
    plugins?: { name: string; options?: Record<string, unknown> }[];
  };
}

/** Same options `nest build` passes to the Swagger CLI plugin — nest-cli.json stays the single source. */
function swaggerPluginOptions(): Record<string, unknown> {
  const config = JSON.parse(
    readFileSync(join(PROJECT_ROOT, 'nest-cli.json'), 'utf-8'),
  ) as NestCliConfig;
  const plugin = config.compilerOptions?.plugins?.find(
    (p) => p.name === '@nestjs/swagger',
  );
  return plugin?.options ?? {};
}

/**
 * Writes the Swagger CLI plugin metadata (`src/metadata.ts`) by walking the TypeScript
 * program, so tools that do not compile through `nest build` — ts-node (`openapi:export`)
 * and ts-jest — produce the same DTO schemas as the running app. Loaded with
 * `SwaggerModule.loadPluginMetadata` (NestJS docs, OpenAPI → CLI plugin).
 */
export function generatePluginMetadata(outputDir = SOURCE_ROOT): void {
  const program = ReadonlyVisitor.createTsProgram(
    join(PROJECT_ROOT, 'tsconfig.build.json'),
  );
  new PluginMetadataGenerator().generate({
    visitors: [
      new ReadonlyVisitor({
        ...swaggerPluginOptions(),
        pathToSource: SOURCE_ROOT,
      }),
    ],
    outputDir,
    filename: METADATA_FILENAME,
    tsProgramRef: program,
  });
  normalizeForCommonJs(join(outputDir, METADATA_FILENAME));
}

/**
 * Adapts the printed file to this CommonJS build:
 * - `import("./x")` → `require("./x")`: under `module: nodenext` tsc keeps dynamic
 *   `import()` native in CommonJS output, and Node's ESM resolver cannot load the
 *   extensionless (or `.ts`) paths the printer emits — neither from `dist/` nor ts-node.
 *   `SwaggerModule.loadPluginMetadata` awaits each entry, so plain modules work.
 * - `t["./file"].Object` → `Object`: in readonly mode the visitor qualifies the `Object`
 *   it emits for interface-typed fields (e.g. the jsonb `Video.metadata`) with the
 *   declaring file's import, which does not compile; `nest build` emits the global one.
 */
function normalizeForCommonJs(filePath: string): void {
  const source = readFileSync(filePath, 'utf-8');
  writeFileSync(
    filePath,
    source
      .replace(/\bimport\("/g, 'require("')
      .replace(/t\["[^"]+"\]\.Object\b/g, 'Object'),
  );
}

if (require.main === module) {
  generatePluginMetadata();
}
