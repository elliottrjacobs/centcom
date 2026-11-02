import type { ApiError } from '../shared/types.ts';

export type ErrorCode = NonNullable<ApiError['code']>;

/** An error that maps 1:1 onto an HTTP response with an `ApiError` body. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode | undefined;

  constructor(status: number, message: string, code?: ErrorCode) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }

  toJSON(): ApiError {
    return this.code ? { error: this.message, code: this.code } : { error: this.message };
  }
}

export const invalid = (message: string) => new HttpError(400, message, 'invalid');
export const unauthorized = (message: string) => new HttpError(401, message, 'forbidden');
export const forbidden = (message: string) => new HttpError(403, message, 'forbidden');
export const notFound = (message: string) => new HttpError(404, message, 'not_found');
export const conflict = (message: string) => new HttpError(409, message, 'conflict');
export const exists = (message: string) => new HttpError(409, message, 'exists');
export const tooLarge = (message: string) => new HttpError(413, message, 'invalid');

export function isErrno(err: unknown, ...codes: string[]): err is NodeJS.ErrnoException {
  if (!err || typeof err !== 'object' || !('code' in err)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return codes.length === 0 ? typeof code === 'string' : typeof code === 'string' && codes.includes(code);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
