export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_FAILED') { super(message); }
}
export function publicError(error: unknown): string {
  return error instanceof AppError ? error.message : 'The request could not be completed. Please try again.';
}
