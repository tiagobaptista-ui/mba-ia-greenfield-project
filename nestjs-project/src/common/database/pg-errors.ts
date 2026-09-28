import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';

// TypeORM copies the pg driver error fields (code, detail) onto QueryFailedError.
type PgQueryFailedError = QueryFailedError & {
  code?: unknown;
  detail?: unknown;
};

export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as PgQueryFailedError;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
