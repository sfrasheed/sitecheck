/** JSON responses, and errors that carry a status instead of a stack trace. */

export class HttpError extends Error {
  readonly status: number;
  readonly detail: string | undefined;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export const badRequest = (message: string, detail?: string) =>
  new HttpError(400, message, detail);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string, detail?: string) =>
  new HttpError(409, message, detail);

export function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function fail(status: number, message: string, detail?: string): Response {
  return ok({ error: message, detail: detail ?? null }, status);
}
