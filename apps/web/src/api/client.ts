// The REST client (LLD §5): an anonymous session until Phase 4 auth, projects, the op log and
// generation jobs. Every error is an `ApiError {code, message, retryable}`; a server that cannot be
// reached is `offline` (retryable), so the editor keeps working locally (LLD §14).
import type {
  AnonymousSession,
  ApiError,
  AppendOk,
  AppendOps,
  GenerateRequest,
  JobAccepted,
  Project,
  ProjectSnapshot,
} from "../gen/contract.ts";

export class ApiFailure extends Error {
  readonly status: number;
  readonly error: ApiError;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.status = status;
    this.error = error;
  }

  get code(): string {
    return this.error.code;
  }

  get retryable(): boolean {
    return !!this.error.retryable;
  }
}

/** True for a failure that means "the server is not there" rather than "the server said no". */
export const isOffline = (e: unknown): boolean => e instanceof ApiFailure && e.code === "offline";

/** Where the session token lives between visits; a stub in tests. */
export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

export function localTokenStore(key = "circuit-forge.session"): TokenStore {
  // Storage can be missing or throw (private windows, blocked site data): the token is then per tab.
  let memory: string | null = null;
  return {
    get() {
      try {
        return localStorage.getItem(key) ?? memory;
      } catch {
        return memory;
      }
    },
    set(token) {
      memory = token;
      try {
        if (token) localStorage.setItem(key, token);
        else localStorage.removeItem(key);
      } catch {
        // kept in memory only
      }
    },
  };
}

export interface ApiClientOptions {
  /** API origin and prefix, e.g. "" (same origin) or "https://api.example.com". */
  base: string;
  tokens: TokenStore;
  fetch?: typeof fetch;
}

export class ApiClient {
  readonly base: string;
  private readonly tokens: TokenStore;
  private readonly fetchFn: typeof fetch;
  private session: Promise<string> | null = null;

  constructor(opts: ApiClientOptions) {
    this.base = opts.base.replace(/\/$/, "");
    this.tokens = opts.tokens;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
  }

  url(path: string): string {
    return `${this.base}${path}`;
  }

  /** The bearer token, creating an anonymous session on first use. */
  async token(): Promise<string> {
    const stored = this.tokens.get();
    if (stored) return stored;
    this.session ??= this.call<AnonymousSession>("POST", "/v1/auth/anonymous", undefined, false)
      .then((s) => {
        this.tokens.set(s.token);
        return s.token;
      })
      .finally(() => {
        this.session = null;
      });
    return this.session;
  }

  async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.token()}` };
  }

  /** Forget a token the server refused (expired, or signed by another deployment's secret). */
  dropToken(): void {
    this.tokens.set(null);
  }

  createProject(title?: string): Promise<Project> {
    return this.authed("POST", "/v1/projects", title ? { title } : undefined);
  }

  getProject(id: string): Promise<ProjectSnapshot> {
    return this.authed("GET", `/v1/projects/${encodeURIComponent(id)}`);
  }

  appendOps(id: string, body: AppendOps): Promise<AppendOk> {
    return this.authed("POST", `/v1/projects/${encodeURIComponent(id)}/ops`, body);
  }

  generate(id: string, req: GenerateRequest): Promise<JobAccepted> {
    return this.authed("POST", `/v1/projects/${encodeURIComponent(id)}/generate`, req);
  }

  async cancel(jobId: string): Promise<void> {
    await this.authed("POST", `/v1/jobs/${encodeURIComponent(jobId)}/cancel`);
  }

  eventsUrl(jobId: string): string {
    return this.url(`/v1/jobs/${encodeURIComponent(jobId)}/events`);
  }

  /** A call with the session token. A 401 means the token is no longer valid: a new anonymous
   * session cannot open the old one's projects, so the 401 is passed on after dropping it. */
  private async authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.call<T>(method, path, body, true);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) this.dropToken();
      throw e;
    }
  }

  private async call<T>(method: string, path: string, body: unknown, auth: boolean): Promise<T> {
    const headers: Record<string, string> = auth ? await this.authHeaders() : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new ApiFailure(0, { code: "offline", message: `cannot reach the server (${(e as Error).message})`, retryable: true });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.ok && json !== undefined) return json as T;
    if (res.ok && !text) return undefined as T; // 202 Accepted with no body (cancel)
    if (res.ok) throw new ApiFailure(res.status, { code: "bad_response", message: `${method} ${path}: not JSON`, retryable: true });
    const err = json as Partial<ApiError> | undefined;
    if (err && typeof err.code === "string" && typeof err.message === "string") throw new ApiFailure(res.status, err as ApiError);
    // Not the API's own error body. A 5xx is then a proxy or load balancer (or the dev server's
    // proxy) in front of an API that is down: offline, not a refusal.
    if (res.status >= 500) throw new ApiFailure(res.status, { code: "offline", message: `the server is not reachable (HTTP ${res.status})`, retryable: true });
    throw new ApiFailure(res.status, { code: "http_error", message: `${method} ${path}: HTTP ${res.status}` });
  }
}
