export type PullmintErrorCode =
  | 'api_unavailable'
  | 'authentication_failed'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'operation_failed'
  | 'invalid_response';

export class PullmintApiError extends Error {
  constructor(
    message: string,
    public readonly code: PullmintErrorCode,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'PullmintApiError';
  }
}

export function mapHttpError(status: number): PullmintApiError {
  if (status === 401 || status === 503) {
    return new PullmintApiError(
      'Pullmint local authentication is invalid or not configured',
      'authentication_failed',
      status
    );
  }
  if (status === 404) {
    return new PullmintApiError(
      'No stored Pullmint evidence exists for the requested item',
      'not_found',
      status
    );
  }
  if (status === 409) {
    return new PullmintApiError(
      'Fresh analysis cannot be triggered for this pull request',
      'conflict',
      status
    );
  }
  if (status === 429) {
    return new PullmintApiError(
      'Action not performed because an equivalent recent request is protected',
      'rate_limited',
      status
    );
  }
  return new PullmintApiError('Pullmint operation failed', 'operation_failed', status);
}
