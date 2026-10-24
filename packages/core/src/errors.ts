/** Structured domain error. `code` is stable and machine-readable; `message` is user-facing. */
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what: string) => new DomainError('not_found', `${what} not found.`, 404);
export const forbidden = (message = 'You do not have permission to do that.') =>
  new DomainError('forbidden', message, 403);
export const conflict = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, 409, details);
export const invalid = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, 400, details);
