import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1790616024522 } from './migrations/1790616024522-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

// Enum types outlive DROP TABLE ... CASCADE; leaving them makes the migrations'
// CREATE TYPE fail whenever the shared DB was already migrated or synchronized.
const MANAGED_ENUM_TYPES = [
  'verification_tokens_type_enum',
  'videos_status_enum',
];

const enumExists = async (
  dataSource: DataSource,
  name: string,
): Promise<boolean> => {
  const rows = await dataSource.query<{ typname: string }[]>(
    `SELECT typname FROM pg_type WHERE typname = $1`,
    [name],
  );
  return rows.length > 0;
};

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1790616024522,
        ],
      },
    );

    await dataSource.initialize();

    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    for (const type of MANAGED_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE IF EXISTS "public"."${type}"`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving the videos table missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    try {
      await dataSource.runMigrations();
    } finally {
      await dataSource.destroy();
    }
  });

  it('should apply all migrations and create all managed tables and enums', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
    expect(await enumExists(dataSource, 'videos_status_enum')).toBe(true);
  });

  it('should revert the last migration (CreateVideos) and remove the videos table and its enum', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(result).toHaveLength(0);
    expect(await enumExists(dataSource, 'videos_status_enum')).toBe(false);
  });
});
