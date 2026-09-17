/** OpenAI-style error object shared by all failure responses. */
export type ApiErrorCode =
  | 'invalid_api_key'
  | 'invalid_request'
  | 'invalid_correlation_id'
  | 'unsupported_parameter'
  | 'model_not_found'
  | 'not_found'
  | 'insufficient_quota'
  | 'rate_limit_exceeded'
  | 'context_length_exceeded'
  | 'upstream_authentication_error'
  | 'upstream_timeout'
  | 'upstream_error'
  | 'upstream_protocol_error'
  | 'internal_error';

const TYPE_BY_CODE: Record<ApiErrorCode, string> = {
  invalid_api_key: 'authentication_error',
  invalid_request: 'invalid_request_error',
  invalid_correlation_id: 'invalid_request_error',
  unsupported_parameter: 'invalid_request_error',
  model_not_found: 'invalid_request_error',
  not_found: 'invalid_request_error',
  insufficient_quota: 'insufficient_quota',
  rate_limit_exceeded: 'rate_limit_error',
  context_length_exceeded: 'invalid_request_error',
  upstream_authentication_error: 'upstream_authentication_error',
  upstream_timeout: 'timeout_error',
  upstream_error: 'upstream_error',
  upstream_protocol_error: 'upstream_protocol_error',
  internal_error: 'internal_error',
};

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  invalid_api_key: 401,
  invalid_request: 400,
  invalid_correlation_id: 400,
  unsupported_parameter: 400,
  model_not_found: 404,
  not_found: 404,
  insufficient_quota: 429,
  rate_limit_exceeded: 429,
  context_length_exceeded: 400,
  upstream_authentication_error: 502,
  upstream_timeout: 504,
  upstream_error: 502,
  upstream_protocol_error: 502,
  internal_error: 500,
};

const PARAM_BY_CODE: Partial<Record<ApiErrorCode, string>> = {
  model_not_found: 'model',
};

export function openAiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  param: string | null = null,
) {
  return {
    statusCode: status,
    body: {
      error: {
        message,
        type: TYPE_BY_CODE[code],
        param: param ?? PARAM_BY_CODE[code] ?? null,
        code,
      },
    },
  };
}

/** status for a code, so callers don't duplicate the mapping table */
export function statusForCode(code: ApiErrorCode): number {
  return STATUS_BY_CODE[code];
}
