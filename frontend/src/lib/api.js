import { API_BASE_URL } from './config';

const DEFAULT_TIMEOUT_MS = 8000;

export class ApiError extends Error {
  constructor(message, { status = null, code = 'UNKNOWN', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function buildMessage(responsePayload, fallbackMessage) {
  if (responsePayload && typeof responsePayload === 'object' && responsePayload.error) {
    return responsePayload.error;
  }

  if (typeof responsePayload === 'string' && responsePayload.trim()) {
    return responsePayload;
  }

  return fallbackMessage;
}

async function parseResponse(response) {
  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    return response.json().catch(() => null);
  }

  return response.text().catch(() => null);
}

export async function apiRequest(path, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    token,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const requestHeaders = new Headers(headers);

  if (token) {
    requestHeaders.set('Authorization', `Bearer ${token}`);
  }

  let requestBody = body;
  if (
    body != null &&
    !(body instanceof FormData) &&
    !(body instanceof URLSearchParams) &&
    typeof body === 'object'
  ) {
    if (!requestHeaders.has('Content-Type')) {
      requestHeaders.set('Content-Type', 'application/json');
    }
    requestBody = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal
    });

    const data = await parseResponse(response);

    if (!response.ok) {
      throw new ApiError(
        buildMessage(data, `La solicitud falló con estado ${response.status}.`),
        {
          status: response.status,
          code: 'HTTP_ERROR',
          details: data
        }
      );
    }

    return data;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error.name === 'AbortError') {
      throw new ApiError('La solicitud tardó demasiado. Reintenta.', {
        code: 'TIMEOUT'
      });
    }

    throw new ApiError('No pudimos conectarnos con el servidor.', {
      code: 'NETWORK'
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function isAuthError(error) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}
