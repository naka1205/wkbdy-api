import { randomUUID } from 'node:crypto';
import { parseProductConfig, toExposedModel, type ProductConfig } from './catalog.js';
import { stripBearer, type WorkBuddyCredential } from './credentials.js';
import { AppError, errorMessage } from './errors.js';
import { fromExposed } from './models.js';
import type { Store } from './store.js';
import type { IssuedCredential } from './upstream.js';

/** WorkBuddy serves the client product configuration (models, agents) here. */
export const CATALOG_ENDPOINT_PATH = '/v3/config';

/**
 * How long a catalog fetch may take. The panel waits for it, so a hanging
 * upstream must fail the request instead of blocking the sync button.
 */
const CATALOG_TIMEOUT_MS = 15_000;

/**
 * The catalog lives next to the chat upstream: the client asks
 * `{endpoint}/v3/config`, so the URL is derived from the configured
 * chat-completions URL unless `WKB2API_CATALOG_URL` overrides it.
 */
export function resolveCatalogUrl(upstreamUrl: string, override?: string): string {
  const explicit = override?.trim();
  const url = new URL(explicit || CATALOG_ENDPOINT_PATH, upstreamUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The catalog URL must be HTTP(S)');
  return url.toString();
}

export type CatalogFailure = 'network' | 'http' | 'invalid';

/** A failed catalog fetch: unreachable upstream, rejected request or bad payload. */
export class CatalogFetchError extends Error {
  constructor(
    message: string,
    readonly failure: CatalogFailure,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CatalogFetchError';
  }
}

export type CatalogFetchOptions = {
  url: string;
  credential: Pick<WorkBuddyCredential, 'accessToken' | 'userId' | 'domain'>;
  userAgent: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

/** Ask the upstream for the product catalog and validate the payload. */
export async function fetchProductConfig(options: CatalogFetchOptions): Promise<ProductConfig> {
  const { url, credential, userAgent } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CATALOG_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${stripBearer(credential.accessToken)}`,
        'X-User-Id': credential.userId,
        'X-Domain': credential.domain,
        'X-Product': 'SaaS',
        'X-Request-ID': randomUUID(),
        'User-Agent': userAgent,
      },
      signal: controller.signal,
    });
  } catch (error) {
    throw new CatalogFetchError(
      `Cannot reach the product catalog at ${url}: ${errorMessage(error)}`,
      'network',
      undefined,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new CatalogFetchError(
      `The product catalog at ${url} answered ${response.status}${detail ? `: ${detail}` : ''}`,
      'http',
      response.status,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new CatalogFetchError(`The product catalog at ${url} did not return JSON`, 'invalid', undefined, {
      cause: error,
    });
  }
  try {
    return parseProductConfig(payload);
  } catch (error) {
    throw new CatalogFetchError(errorMessage(error), 'invalid', undefined, { cause: error });
  }
}

/** The account pool surface a catalog sync needs (satisfied by `Accounts`). */
export type CatalogCredentials = {
  getCredential: () => Promise<IssuedCredential>;
  /** Retry once with a fresh token when the upstream rejects the credential. */
  refreshRejected?: (credential: IssuedCredential) => Promise<IssuedCredential>;
};

export type CatalogSyncOptions = {
  store: Store;
  /** Resolved per sync, so a changed upstream setting takes effect immediately. */
  catalogUrl: () => string;
  userAgent: () => string;
  credentials: CatalogCredentials;
  fetchFn?: typeof fetch;
};

export type CatalogSyncSummary = { added: number; updated: number; removed: number };

/**
 * Fetch the product catalog from the upstream and merge it into the model
 * table. Panel state (enabled flags, chosen context windows) survives, models
 * the payload no longer lists are dropped. An empty or invalid payload leaves
 * the stored catalog untouched.
 */
export async function syncCatalogFromUpstream(options: CatalogSyncOptions): Promise<CatalogSyncSummary> {
  const url = options.catalogUrl();
  const fetchConfig = (credential: IssuedCredential) =>
    fetchProductConfig({
      url,
      credential,
      userAgent: options.userAgent(),
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    });

  let credential = await options.credentials.getCredential();
  let config: ProductConfig;
  try {
    config = await fetchConfig(credential);
  } catch (error) {
    const expired = error instanceof CatalogFetchError && error.failure === 'http' && error.status === 401;
    if (!expired || !options.credentials.refreshRejected) throw catalogError(error, url);
    try {
      credential = await options.credentials.refreshRejected(credential);
      config = await fetchConfig(credential);
    } catch (retry) {
      // A failed refresh means the credential is still the problem, so report
      // the rejection rather than the refresh error.
      throw catalogError(retry instanceof CatalogFetchError ? retry : error, url);
    }
  }

  return options.store.importCatalog({
    models: config.data.models.map((model) => fromExposed(toExposedModel(model))),
    agents: config.data.agents.map((agent) => ({
      name: agent.name,
      models: agent.models,
      ...(agent.modelTags ? { modelTags: agent.modelTags } : {}),
    })),
    ...(config.data.endpoint ? { endpoint: config.data.endpoint } : {}),
  });
}

/** Translate a fetch failure into the admin-facing error the panel reports. */
function catalogError(error: unknown, url: string): unknown {
  if (!(error instanceof CatalogFetchError)) return error;
  if (error.status === 401 || error.status === 403) {
    return new AppError(
      502,
      'catalog_unauthorized',
      `The upstream rejected the account used to read ${url}. Add or re-authorize an account.`,
      { cause: error },
    );
  }
  if (error.failure === 'invalid') {
    return new AppError(
      502,
      'catalog_invalid',
      `The product catalog at ${url} was rejected: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  return new AppError(502, 'catalog_unreachable', error.message, { cause: error });
}
