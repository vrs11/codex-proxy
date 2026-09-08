export class ProxyError extends Error {
  constructor(message, status = 502, code = 'upstream_error', param = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

export function invalid(message, param, code = 'unsupported_parameter') {
  return new ProxyError(message, 400, code, param);
}

export function errorBody(error) {
  return {
    error: {
      message: error.message,
      type: error.status === 401 ? 'authentication_error'
        : error.status === 429 ? 'rate_limit_error'
        : error.status >= 500 ? 'server_error' : 'invalid_request_error',
      code: error.code ?? 'proxy_error',
      param: error.param ?? null,
      ...error.upstreamError,
    },
  };
}

export function responseFailure(response) {
  const detail = response?.error ?? response;
  const code = detail?.code;
  const status = ['rate_limit_exceeded', 'insufficient_quota'].includes(code) ? 429
    : code === 'context_length_exceeded' ? 400 : 502;
  const error = new ProxyError(detail?.message ?? 'Upstream generation failed.', status, code);
  if (detail && typeof detail === 'object') error.upstreamError = detail;
  return error;
}
