export interface ResolveSecretInput {
  apiUrl: string;
  token: string;
  provider: string;
  name: string;
  environment?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  projectId?: string;
  projectSlug?: string;
  clientId?: string;
  taskId?: string;
  source?: string;
  commandAlias?: "run" | "exec";
  runId?: string;
  purpose?: string;
  fetchImpl?: ResolveFetch;
}

export type SecretKind = "api_key" | "login_credential";

export interface LoginCredentialResult {
  username: string;
  password: string;
  loginUrl: string | null;
}

interface ResolveSecretMetadata {
  id: string;
  kind: SecretKind;
  name: string;
  environment: string | null;
  scopeKind: "workspace" | "project" | "agent";
  providerId: string;
  providerName: string;
  providerDisplayName: string;
  version: number;
}

export interface ResolveApiKeySecretResult {
  credentialType: "api_key";
  value: string;
  referenceId?: string | null;
  secret: ResolveSecretMetadata & {
    kind: "api_key";
  };
}

export interface ResolveLoginCredentialSecretResult {
  credentialType: "login_credential";
  credentials: LoginCredentialResult;
  secret: ResolveSecretMetadata & {
    kind: "login_credential";
  };
}

export type ResolveSecretResult = ResolveApiKeySecretResult | ResolveLoginCredentialSecretResult;

export interface ResolveFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type ResolveFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
) => Promise<ResolveFetchResponse>;

export class ScopeHoldResolveError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ScopeHoldResolveError";
    this.status = status;
  }
}

function required(value: string | undefined, label: string): string {
  if (!value || !value.trim()) {
    throw new ScopeHoldResolveError(400, `${label} is required.`);
  }

  return value.trim();
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function apiBaseUrl(apiUrl: string): string {
  return required(apiUrl, "apiUrl").replace(/\/+$/, "");
}

function globalFetch(): ResolveFetch | undefined {
  return (globalThis as { fetch?: ResolveFetch }).fetch;
}

function bodyWithoutUndefined(input: ResolveSecretInput): Record<string, string> {
  const body: Record<string, string | undefined> = {
    provider: required(input.provider, "provider"),
    name: required(input.name, "name"),
    environment: optional(input.environment),
    workspaceId: optional(input.workspaceId),
    workspaceSlug: optional(input.workspaceSlug),
    projectId: optional(input.projectId),
    projectSlug: optional(input.projectSlug),
    clientId: optional(input.clientId),
    taskId: optional(input.taskId),
    source: optional(input.source),
    commandAlias: optional(input.commandAlias),
    runId: optional(input.runId),
    purpose: optional(input.purpose)
  };

  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as Record<string, string>;
}

function fallbackErrorMessage(status: number): string {
  if (status === 400) {
    return "Resolve request is invalid.";
  }

  if (status === 401) {
    return "Authentication failed.";
  }

  if (status === 403 || status === 404) {
    return "Secret could not be resolved.";
  }

  if (status === 503) {
    return "ScopeHold API is unavailable.";
  }

  return "Resolve request failed.";
}

function readMessage(payload: unknown, status: number): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return fallbackErrorMessage(status);
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallbackErrorMessage(status);
}

async function readError(response: ResolveFetchResponse): Promise<ScopeHoldResolveError> {
  try {
    return new ScopeHoldResolveError(response.status, readMessage(await response.json(), response.status));
  } catch {
    return new ScopeHoldResolveError(response.status, fallbackErrorMessage(response.status));
  }
}

function assertResolveResult(payload: unknown): ResolveSecretResult {
  if (typeof payload !== "object" || payload === null) {
    throw new ScopeHoldResolveError(502, "Resolve response was invalid.");
  }

  const result = payload as Partial<ResolveSecretResult>;

  if (typeof result.credentialType !== "string" || typeof result.secret !== "object" || result.secret === null) {
    throw new ScopeHoldResolveError(502, "Resolve response was invalid.");
  }

  const secret = result.secret as Partial<ResolveSecretMetadata>;
  const scopeKinds = new Set(["workspace", "project", "agent"]);
  const secretKinds = new Set(["api_key", "login_credential"]);

  if (
    typeof secret.id !== "string" ||
    typeof secret.kind !== "string" ||
    !secretKinds.has(secret.kind) ||
    typeof secret.name !== "string" ||
    !(typeof secret.environment === "string" || secret.environment === null) ||
    typeof secret.scopeKind !== "string" ||
    !scopeKinds.has(secret.scopeKind) ||
    typeof secret.providerId !== "string" ||
    typeof secret.providerName !== "string" ||
    typeof secret.providerDisplayName !== "string" ||
    typeof secret.version !== "number"
  ) {
    throw new ScopeHoldResolveError(502, "Resolve response was invalid.");
  }

  if (result.credentialType !== secret.kind) {
    throw new ScopeHoldResolveError(502, "Resolve response was invalid.");
  }

  if (result.credentialType === "api_key") {
    const apiKeyResult = result as Partial<ResolveApiKeySecretResult>;

    if (
      typeof apiKeyResult.value !== "string" ||
      !(
        apiKeyResult.referenceId === undefined ||
        typeof apiKeyResult.referenceId === "string" ||
        apiKeyResult.referenceId === null
      )
    ) {
      throw new ScopeHoldResolveError(502, "Resolve response was invalid.");
    }

    return result as ResolveApiKeySecretResult;
  }

  if (result.credentialType === "login_credential") {
    const credentials = (result as Partial<ResolveLoginCredentialSecretResult>).credentials;

    if (
      typeof credentials !== "object" ||
      credentials === null ||
      typeof credentials.username !== "string" ||
      typeof credentials.password !== "string" ||
      !(typeof credentials.loginUrl === "string" || credentials.loginUrl === null)
    ) {
      throw new ScopeHoldResolveError(502, "Resolve response was invalid.");
    }

    return result as ResolveLoginCredentialSecretResult;
  }

  throw new ScopeHoldResolveError(502, "Resolve response was invalid.");
}

export async function resolveScopeHoldSecret(input: ResolveSecretInput): Promise<ResolveSecretResult> {
  const fetchImpl = input.fetchImpl ?? globalFetch();

  if (!fetchImpl) {
    throw new ScopeHoldResolveError(500, "fetch is not available in this runtime.");
  }

  const response = await fetchImpl(`${apiBaseUrl(input.apiUrl)}/resolve`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${required(input.token, "token")}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(bodyWithoutUndefined(input))
  });

  if (!response.ok) {
    throw await readError(response);
  }

  return assertResolveResult(await response.json());
}
