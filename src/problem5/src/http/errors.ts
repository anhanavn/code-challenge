/**
 * An error that maps directly to an HTTP response. The error handler renders it
 * as an RFC 9457 (formerly 7807) `application/problem+json` body.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
    this.name = 'HttpError';
  }
}

export interface FieldError {
  field: string;
  message: string;
}

export const badRequest = (detail: string) => new HttpError(400, 'Bad Request', detail);

export const validationFailed = (errors: FieldError[]) =>
  new HttpError(400, 'Validation Failed', 'The request contains invalid fields', { errors });

export const unauthorized = () =>
  new HttpError(401, 'Unauthorized', 'A valid API key is required (Authorization: Bearer <key>)');

export const notFound = (detail: string) => new HttpError(404, 'Not Found', detail);

export const preconditionFailed = (detail: string) => new HttpError(412, 'Precondition Failed', detail);

export const unsupportedMediaType = () =>
  new HttpError(415, 'Unsupported Media Type', 'Content-Type must be application/json');
