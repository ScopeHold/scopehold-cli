#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { resolveScopeHoldSecret, ScopeHoldResolveError, type ResolveSecretResult } from "./resolve-client.js";
import { createChildEnvWithMappedSecrets, redactSensitiveText } from "./security.js";

type CommandHandler = (context: CliContext) => Promise<void>;

type OptionValue = string | boolean | string[];
type RunCommandAlias = "run" | "exec";
type AgentRunEvent = "start" | "complete" | "failed" | "aborted";

type ParsedArgs = {
  command: string | null;
  args: string[];
  options: Record<string, OptionValue>;
  afterDoubleDash: string[];
};

type CliContext = {
  parsed: ParsedArgs;
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
};

type CredentialsStore = {
  version: 1;
  profiles: Record<string, StoredProfile>;
};

type StoredProfile = {
  apiUrl: string;
  authType?: "agent_key" | "oauth";
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  tokenType?: string;
  agentId?: string;
  agentName?: string;
  createdAt: string;
  updatedAt: string;
};

type RuntimeConfig = {
  apiUrl?: string;
  profile?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  projectId?: string;
  projectSlug?: string;
  secrets?: Record<string, SecretMapping>;
};

type SecretMapping = {
  provider: string;
  name: string;
  environment?: string;
};

type InlineSecretField = "value" | "username" | "password" | "loginUrl" | "referenceId";

type InlineSecretMapping = SecretMapping & {
  field: InlineSecretField;
};

type RuntimeContext = {
  profileName?: string;
  profile?: StoredProfile;
  token: string;
  apiUrl: string;
  config?: RuntimeConfig;
  configPath?: string;
};

type InventoryResponse = {
  agent?: {
    id: string;
    workspaceId: string;
    projectId?: string | null;
  };
  secrets?: Array<{
    provider?: string | null;
    providerDisplayName?: string | null;
    name: string;
    environment?: string | null;
    kind?: string;
    scopeKind?: string;
    resolve?: unknown;
  }>;
};

type ProvisionResponse = {
  agent?: {
    id: string;
    displayName: string;
  };
  token?: string;
};

type OAuthAuthorizationServerMetadata = {
  issuer: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
};

type DeviceAuthorizationResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  agent?: {
    id: string;
    displayName: string;
    workspaceId?: string;
    projectId?: string | null;
  } | null;
};

type OAuthErrorResponse = {
  error?: string;
  error_description?: string;
};

type PackageManifestResponse = {
  version?: unknown;
};

const scopeHoldDirName = ".scopehold";
const credentialsFileName = "credentials.json";
const userConfigFileName = "config.json";
const projectConfigFileName = ".scopehold.json";
const defaultApiUrl = "https://api.scopehold.com";
const packageName = "@scopehold/cli";
const npmRegistryUrl = "https://registry.npmjs.org";
const booleanOptionNames = new Set(["help", "json", "metadata", "version", "check"]);
const repeatableOptionNames = new Set(["secret"]);
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const inlineSecretFields = new Set<InlineSecretField>(["value", "username", "password", "loginUrl", "referenceId"]);

class CliError extends Error {
  code: number;

  constructor(message: string, code = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

const commands: Record<string, CommandHandler> = {
  connect: connectCommand,
  disconnect: disconnectCommand,
  help: showHelp,
  version: versionCommand,
  update: updateCommand,
  status: statusCommand,
  inventory: inventoryCommand,
  resolve: resolveCommand,
  run: runCommand,
  exec: runCommand,
  agent: agentCommand
};

function usage(): string {
  return `Usage: scopehold <command> [options]

Commands:
  connect           Connect this machine with browser approval using a short code
  disconnect        Revoke and remove a connected OAuth profile
  version           Show the installed ScopeHold CLI version
  update            Upgrade the ScopeHold CLI, or check with --check
  agent provision   Redeem a one-time provisioning prompt into a named local profile
  status            Show selected profile and project config without printing secrets
  inventory         List secret metadata available to the selected profile
  resolve           Resolve one secret by provider/name
  run               Run a command with mapped secrets injected as environment variables (alias: exec)

Global options:
  --profile <name>  Local ScopeHold profile name
  --api-url <url>   ScopeHold API URL override
  --json            Print JSON where supported
  --help            Show help
  --version         Show version

Update options:
  --check           Check for updates without installing

Connect options:
  --agent-name <n>  Suggested agent name shown on the approval screen

Run options:
  --secret NAME=provider/name[:field]
                    Inject an inline secret into the child environment
                    field defaults to value; supported fields: value, username, password, loginUrl, referenceId

Project config:
  scopehold run reads the nearest ${projectConfigFileName}. Store only non-secret context there.

Examples:
  scopehold run --secret DATABASE_URL=supabase/database_url -- npx prisma migrate deploy
  scopehold run --secret TOKEN=provider/name -- sh -c 'curl https://example.com -H "Authorization: Bearer $TOKEN"'
`;
}

function setOption(options: Record<string, OptionValue>, name: string, value: string | boolean): void {
  if (!repeatableOptionNames.has(name)) {
    options[name] = value;
    return;
  }

  if (typeof value !== "string") {
    options[name] = value;
    return;
  }

  const existing = options[name];
  if (existing === undefined) {
    options[name] = [value];
    return;
  }

  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }

  if (typeof existing === "string") {
    options[name] = [existing, value];
    return;
  }

  throw new CliError(`--${name} cannot be repeated as a boolean option.`, 2);
}

function parseArgs(argv: string[]): ParsedArgs {
  const doubleDashIndex = argv.indexOf("--");
  const beforeDoubleDash = doubleDashIndex === -1 ? argv : argv.slice(0, doubleDashIndex);
  const afterDoubleDash = doubleDashIndex === -1 ? [] : argv.slice(doubleDashIndex + 1);
  const options: Record<string, OptionValue> = {};
  const args: string[] = [];

  for (let index = 0; index < beforeDoubleDash.length; index += 1) {
    const raw = beforeDoubleDash[index]!;

    if (raw === "-v") {
      setOption(options, "version", true);
      continue;
    }

    if (!raw.startsWith("--")) {
      args.push(raw);
      continue;
    }

    const optionBody = raw.slice(2);
    const equalsIndex = optionBody.indexOf("=");
    const name = equalsIndex === -1 ? optionBody : optionBody.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : optionBody.slice(equalsIndex + 1);
    if (!name) {
      throw new CliError("Invalid option.", 2);
    }

    if (booleanOptionNames.has(name)) {
      if (inlineValue !== undefined) {
        throw new CliError(`--${name} does not take a value.`, 2);
      }
      setOption(options, name, true);
      continue;
    }

    const value = inlineValue ?? beforeDoubleDash[index + 1];
    if (!value || (inlineValue === undefined && value.startsWith("--"))) {
      throw new CliError(`Missing value for --${name}.`, 2);
    }

    setOption(options, name, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const command = args.shift() ?? null;
  return {
    command,
    args,
    options,
    afterDoubleDash
  };
}

function optionString(options: Record<string, OptionValue>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionStrings(options: Record<string, OptionValue>, name: string): string[] {
  const value = options[name];
  if (Array.isArray(value)) {
    return value.map((entry) => entry.trim()).filter(Boolean);
  }

  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function optionBoolean(options: Record<string, OptionValue>, name: string): boolean {
  return options[name] === true;
}

function requireOption(options: Record<string, OptionValue>, name: string): string {
  const value = optionString(options, name);
  if (!value) {
    throw new CliError(`--${name} is required.`, 2);
  }

  return value;
}

function normalizeApiUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    throw new CliError("api-url must start with http:// or https://.", 2);
  }

  return trimmed;
}

function scopeHoldDir(homeDir: string): string {
  return path.join(homeDir, scopeHoldDirName);
}

function credentialsPath(homeDir: string): string {
  return path.join(scopeHoldDir(homeDir), credentialsFileName);
}

function userConfigPath(homeDir: string): string {
  return path.join(scopeHoldDir(homeDir), userConfigFileName);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureScopeHoldDir(homeDir: string): Promise<void> {
  const dir = scopeHoldDir(homeDir);
  await mkdir(dir, {
    recursive: true,
    mode: 0o700
  });
  await chmod(dir, 0o700);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    throw new CliError(`${filePath} could not be parsed as JSON.`);
  }
}

async function writePrivateJson(filePath: string, payload: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

async function readCredentials(homeDir: string): Promise<CredentialsStore> {
  const filePath = credentialsPath(homeDir);
  if (await pathExists(filePath)) {
    await chmod(filePath, 0o600);
  }

  const store = await readJsonFile<CredentialsStore>(filePath);
  if (!store) {
    return {
      version: 1,
      profiles: {}
    };
  }

  if (store.version !== 1 || typeof store.profiles !== "object" || store.profiles === null) {
    throw new CliError("ScopeHold credentials store is invalid.");
  }

  return store;
}

async function writeCredentials(homeDir: string, store: CredentialsStore): Promise<void> {
  await ensureScopeHoldDir(homeDir);
  await writePrivateJson(credentialsPath(homeDir), store);
}

async function ensureUserConfig(homeDir: string): Promise<void> {
  await ensureScopeHoldDir(homeDir);
  const filePath = userConfigPath(homeDir);
  if (await pathExists(filePath)) {
    await chmod(filePath, 0o600);
    return;
  }

  await writePrivateJson(filePath, {
    version: 1,
    profiles: {}
  });
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError(`${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function optionalStringRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseProjectConfig(payload: unknown, configPath: string): RuntimeConfig {
  const record = assertRecord(payload, configPath);
  const config: RuntimeConfig = {
    apiUrl: optionalStringRecord(record, "apiUrl"),
    profile: optionalStringRecord(record, "profile"),
    workspaceId: optionalStringRecord(record, "workspaceId"),
    workspaceSlug: optionalStringRecord(record, "workspaceSlug"),
    projectId: optionalStringRecord(record, "projectId"),
    projectSlug: optionalStringRecord(record, "projectSlug")
  };

  if ("secrets" in record) {
    const secrets = assertRecord(record.secrets, `${configPath} secrets`);
    config.secrets = {};

    for (const [envName, rawMapping] of Object.entries(secrets)) {
      const mapping = assertRecord(rawMapping, `${configPath} secrets.${envName}`);
      const provider = optionalStringRecord(mapping, "provider");
      const name = optionalStringRecord(mapping, "name");

      if (!provider || !name) {
        throw new CliError(`${configPath} secrets.${envName} requires provider and name.`);
      }

      config.secrets[envName] = {
        provider,
        name,
        environment: optionalStringRecord(mapping, "environment")
      };
    }
  }

  return config;
}

async function findProjectConfig(cwd: string): Promise<{ config: RuntimeConfig; configPath: string } | null> {
  let current = cwd;

  while (true) {
    const candidate = path.join(current, projectConfigFileName);
    if (await pathExists(candidate)) {
      const payload = await readJsonFile<unknown>(candidate);
      if (!payload) {
        throw new CliError(`${candidate} could not be read.`);
      }

      return {
        config: parseProjectConfig(payload, candidate),
        configPath: candidate
      };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function profileFromStore(store: CredentialsStore, profileName: string): StoredProfile {
  const profile = store.profiles[profileName];
  if (!profile) {
    throw new CliError(`ScopeHold profile "${profileName}" was not found. Run scopehold connect first.`);
  }

  return profile;
}

function storedProfileAuthType(profile: StoredProfile): "agent_key" | "oauth" {
  if (profile.authType === "oauth" || profile.refreshToken || profile.accessToken) {
    return "oauth";
  }

  return "agent_key";
}

function profileAccessToken(profile: StoredProfile): string | null {
  const token = storedProfileAuthType(profile) === "oauth" ? profile.accessToken ?? profile.token : profile.token;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

function profileRefreshToken(profile: StoredProfile): string | null {
  return typeof profile.refreshToken === "string" && profile.refreshToken.trim() ? profile.refreshToken.trim() : null;
}

function accessTokenNeedsRefresh(profile: StoredProfile): boolean {
  if (storedProfileAuthType(profile) !== "oauth") {
    return false;
  }

  const expiresAt = profile.accessTokenExpiresAt ? Date.parse(profile.accessTokenExpiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt)) {
    return true;
  }

  return expiresAt <= Date.now() + 60_000;
}

function profileNameForConnection(input: {
  explicitProfile?: string;
  project?: { config: RuntimeConfig; configPath: string } | null;
  store: CredentialsStore;
}): string {
  if (input.explicitProfile) {
    return input.explicitProfile;
  }

  if (input.project?.config.profile) {
    return input.project.config.profile;
  }

  const profileNames = Object.keys(input.store.profiles);
  if (profileNames.length === 1) {
    return profileNames[0]!;
  }

  return "default";
}

function apiUrlForProfile(input: {
  context: CliContext;
  profile?: StoredProfile;
  project?: { config: RuntimeConfig; configPath: string } | null;
}): string {
  return normalizeApiUrl(
    optionString(input.context.parsed.options, "api-url") ??
      input.project?.config.apiUrl ??
      input.profile?.apiUrl ??
      input.context.env.SCOPEHOLD_API_URL ??
      input.context.env.NEXT_PUBLIC_API_BASE_URL ??
      defaultApiUrl
  );
}

function requirePayloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new CliError(`ScopeHold OAuth response did not include ${key}.`);
  }

  return value.trim();
}

function optionalPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requirePayloadNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CliError(`ScopeHold OAuth response did not include ${key}.`);
  }

  return value;
}

async function fetchJsonResponse(input: {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
  url: string;
}): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const headers: Record<string, string> = {
    ...(input.headers ?? {})
  };

  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    payload
  };
}

function oauthErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) {
    return fallback;
  }

  const error = payload as OAuthErrorResponse;
  if (typeof error.error_description === "string" && error.error_description.trim()) {
    return error.error_description.trim();
  }

  if (typeof error.error === "string" && error.error.trim()) {
    return error.error.trim();
  }

  return fallback;
}

function isInteractiveStream(stream: NodeJS.WriteStream): boolean {
  return stream.isTTY === true;
}

async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore"
    });
    let settled = false;
    const settle = (opened: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(opened);
    };

    child.once("error", () => settle(false));
    child.once("spawn", () => {
      child.unref();
      settle(true);
    });
  });
}

async function discoverOAuthServer(apiUrl: string): Promise<OAuthAuthorizationServerMetadata> {
  const metadataUrl = `${normalizeApiUrl(apiUrl)}/.well-known/oauth-authorization-server`;
  const response = await fetchJsonResponse({
    url: metadataUrl
  });

  if (!response.ok || typeof response.payload !== "object" || response.payload === null) {
    throw new CliError(`Could not read ScopeHold OAuth discovery from ${metadataUrl}.`);
  }

  const payload = response.payload as Record<string, unknown>;

  return {
    issuer: requirePayloadString(payload, "issuer"),
    device_authorization_endpoint: requirePayloadString(payload, "device_authorization_endpoint"),
    token_endpoint: requirePayloadString(payload, "token_endpoint"),
    revocation_endpoint: requirePayloadString(payload, "revocation_endpoint")
  };
}

function parseDeviceAuthorization(payload: unknown): DeviceAuthorizationResponse {
  const record = assertRecord(payload, "device authorization response");

  return {
    device_code: requirePayloadString(record, "device_code"),
    user_code: requirePayloadString(record, "user_code"),
    verification_uri: requirePayloadString(record, "verification_uri"),
    verification_uri_complete: optionalPayloadString(record, "verification_uri_complete"),
    expires_in: requirePayloadNumber(record, "expires_in"),
    interval: typeof record.interval === "number" && Number.isFinite(record.interval) ? record.interval : undefined
  };
}

function parseOAuthTokenResponse(payload: unknown): OAuthTokenResponse {
  const record = assertRecord(payload, "token response");
  const agentValue = record.agent;
  let agent: OAuthTokenResponse["agent"] = null;

  if (typeof agentValue === "object" && agentValue !== null && !Array.isArray(agentValue)) {
    const agentRecord = agentValue as Record<string, unknown>;
    agent = {
      id: requirePayloadString(agentRecord, "id"),
      displayName: requirePayloadString(agentRecord, "displayName"),
      workspaceId: optionalPayloadString(agentRecord, "workspaceId"),
      projectId: optionalPayloadString(agentRecord, "projectId") ?? null
    };
  }

  return {
    access_token: requirePayloadString(record, "access_token"),
    refresh_token: optionalPayloadString(record, "refresh_token"),
    token_type: requirePayloadString(record, "token_type"),
    expires_in: requirePayloadNumber(record, "expires_in"),
    agent
  };
}

async function refreshOAuthProfile(input: {
  apiUrl: string;
  homeDir: string;
  profile: StoredProfile;
  profileName: string;
  store: CredentialsStore;
}): Promise<StoredProfile> {
  const refreshToken = profileRefreshToken(input.profile);
  if (!refreshToken) {
    throw new CliError(`ScopeHold profile "${input.profileName}" has no refresh token. Run scopehold connect again.`);
  }

  const metadata = await discoverOAuthServer(input.apiUrl);
  const response = await fetchJsonResponse({
    url: metadata.token_endpoint,
    method: "POST",
    body: {
      grant_type: "refresh_token",
      refresh_token: refreshToken
    }
  });

  if (!response.ok) {
    const detail = oauthErrorMessage(response.payload, "The refresh token was rejected.");
    throw new CliError(
      `ScopeHold profile "${input.profileName}" could not refresh: ${detail} Run scopehold connect --profile "${input.profileName}" to re-approve access.`
    );
  }

  const tokenResponse = parseOAuthTokenResponse(response.payload);
  const now = new Date().toISOString();
  const updated: StoredProfile = {
    ...input.profile,
    apiUrl: input.apiUrl,
    authType: "oauth",
    token: tokenResponse.access_token,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    tokenType: tokenResponse.token_type,
    accessTokenExpiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
    updatedAt: now
  };

  const latestStore = await readCredentials(input.homeDir);
  latestStore.profiles[input.profileName] = updated;
  await writeCredentials(input.homeDir, latestStore);
  input.store.profiles[input.profileName] = updated;
  return updated;
}

async function tokenForProfile(input: {
  apiUrl: string;
  homeDir: string;
  profile: StoredProfile;
  profileName: string;
  store: CredentialsStore;
}): Promise<{ profile: StoredProfile; token: string }> {
  if (storedProfileAuthType(input.profile) === "agent_key") {
    const token = profileAccessToken(input.profile);
    if (!token) {
      throw new CliError(`ScopeHold profile "${input.profileName}" does not contain a token. Run scopehold connect again.`);
    }

    return {
      profile: input.profile,
      token
    };
  }

  let refreshedProfile = input.profile;
  if (accessTokenNeedsRefresh(input.profile)) {
    if (!profileRefreshToken(input.profile)) {
      throw new CliError(
        `ScopeHold profile "${input.profileName}" has expired. It was connected with the session lifetime, which has no refresh token, so it cannot renew automatically. Run scopehold connect --profile "${input.profileName}" to reconnect.`
      );
    }

    refreshedProfile = await refreshOAuthProfile(input);
  }
  const token = profileAccessToken(refreshedProfile);

  if (!token) {
    throw new CliError(`ScopeHold profile "${input.profileName}" does not contain an access token. Run scopehold connect again.`);
  }

  return {
    profile: refreshedProfile,
    token
  };
}

async function resolveRuntimeContext(context: CliContext): Promise<RuntimeContext> {
  const project = await findProjectConfig(context.cwd);
  const store = await readCredentials(context.homeDir);
  const explicitProfile = optionString(context.parsed.options, "profile");
  const configProfile = project?.config.profile;
  const envToken = context.env.SCOPEHOLD_AGENT_TOKEN ?? context.env.SCOPEHOLD_TOKEN;
  const envApiUrl = context.env.SCOPEHOLD_API_URL ?? context.env.NEXT_PUBLIC_API_BASE_URL;
  const profileNames = Object.keys(store.profiles);

  if (explicitProfile && configProfile && explicitProfile !== configProfile) {
    throw new CliError(`--profile ${explicitProfile} does not match ${projectConfigFileName} profile ${configProfile}.`);
  }

  const selectedProfile = explicitProfile ?? configProfile;
  if (selectedProfile) {
    const profile = profileFromStore(store, selectedProfile);
    const apiUrl = normalizeApiUrl(optionString(context.parsed.options, "api-url") ?? project?.config.apiUrl ?? profile.apiUrl);
    const usable = await tokenForProfile({
      apiUrl,
      homeDir: context.homeDir,
      profile,
      profileName: selectedProfile,
      store
    });

    return {
      profileName: selectedProfile,
      profile: usable.profile,
      token: usable.token,
      apiUrl,
      config: project?.config,
      configPath: project?.configPath
    };
  }

  if (envToken) {
    return {
      token: envToken,
      apiUrl: normalizeApiUrl(optionString(context.parsed.options, "api-url") ?? project?.config.apiUrl ?? envApiUrl ?? defaultApiUrl),
      config: project?.config,
      configPath: project?.configPath
    };
  }

  if (profileNames.length === 1) {
    const profileName = profileNames[0]!;
    const profile = profileFromStore(store, profileName);
    const apiUrl = normalizeApiUrl(optionString(context.parsed.options, "api-url") ?? project?.config.apiUrl ?? profile.apiUrl);
    const usable = await tokenForProfile({
      apiUrl,
      homeDir: context.homeDir,
      profile,
      profileName,
      store
    });

    return {
      profileName,
      profile: usable.profile,
      token: usable.token,
      apiUrl,
      config: project?.config,
      configPath: project?.configPath
    };
  }

  if (profileNames.length > 1) {
    throw new CliError(
      `Multiple ScopeHold profiles exist. Add "profile" to ${projectConfigFileName} or run with --profile <name>.`
    );
  }

  throw new CliError("No ScopeHold profile or Agent Key found. Run scopehold connect first.");
}

function withConfigContext(input: {
  config?: RuntimeConfig;
  options: Record<string, OptionValue>;
}): {
  workspaceId?: string;
  workspaceSlug?: string;
  projectId?: string;
  projectSlug?: string;
} {
  return {
    workspaceId: optionString(input.options, "workspace-id") ?? input.config?.workspaceId,
    workspaceSlug: optionString(input.options, "workspace-slug") ?? input.config?.workspaceSlug,
    projectId: optionString(input.options, "project-id") ?? input.config?.projectId,
    projectSlug: optionString(input.options, "project-slug") ?? input.config?.projectSlug
  };
}

async function showHelp(context: CliContext): Promise<void> {
  context.stdout.write(usage());
}

async function readPackageVersion(): Promise<string> {
  const packageUrl = new URL("../package.json", import.meta.url);
  const payload = JSON.parse(await readFile(packageUrl, "utf8")) as { version?: unknown };
  if (typeof payload.version !== "string" || !payload.version.trim()) {
    throw new CliError("ScopeHold CLI package version could not be read.");
  }

  return payload.version.trim();
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split("-", 1)[0]!.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split("-", 1)[0]!.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index]! : 0;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index]! : 0;

    if (leftValue > rightValue) {
      return 1;
    }

    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

function npmLatestManifestUrl(registryUrl: string): string {
  return `${registryUrl.trim().replace(/\/+$/, "")}/${encodeURIComponent(packageName).replace("%40", "@")}/latest`;
}

function normalizedRegistryUrl(registryUrl: string): string {
  return registryUrl.trim().replace(/\/+$/, "");
}

function npmInstallArgs(registryUrl: string): string[] {
  const args = ["install", "-g", `${packageName}@latest`];
  const normalizedRegistry = normalizedRegistryUrl(registryUrl);
  if (normalizedRegistry !== npmRegistryUrl) {
    args.push("--registry", normalizedRegistry);
  }

  return args;
}

function npmInstallCommand(registryUrl: string): string {
  return ["npm", ...npmInstallArgs(registryUrl)].join(" ");
}

async function fetchLatestPackageVersion(registryUrl: string): Promise<string> {
  const response = await fetchJsonResponse({
    url: npmLatestManifestUrl(registryUrl)
  });

  if (!response.ok || typeof response.payload !== "object" || response.payload === null) {
    throw new CliError(`Could not check ${packageName} on npm.`);
  }

  const payload = response.payload as PackageManifestResponse;
  if (typeof payload.version !== "string" || !payload.version.trim()) {
    throw new CliError(`npm did not return a latest version for ${packageName}.`);
  }

  return payload.version.trim();
}

async function runNpmUpdate(registryUrl: string): Promise<void> {
  const args = npmInstallArgs(registryUrl);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `npm exited with code ${code ?? 1}.`));
    });
  });
}

async function versionCommand(context: CliContext): Promise<void> {
  const version = await readPackageVersion();

  if (optionBoolean(context.parsed.options, "json")) {
    context.stdout.write(`${JSON.stringify({ version }, null, 2)}\n`);
    return;
  }

  context.stdout.write(`${version}\n`);
}

async function updateCommand(context: CliContext): Promise<void> {
  const currentVersion = await readPackageVersion();
  const registryUrl = optionString(context.parsed.options, "registry-url") ?? npmRegistryUrl;
  const latestVersion = await fetchLatestPackageVersion(registryUrl);
  const installCommand = npmInstallCommand(registryUrl);
  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
  const checkOnly = optionBoolean(context.parsed.options, "check");

  if (checkOnly || !updateAvailable) {
    if (optionBoolean(context.parsed.options, "json")) {
      context.stdout.write(
        `${JSON.stringify(
          {
            current: currentVersion,
            latest: latestVersion,
            updateAvailable,
            installCommand: updateAvailable ? installCommand : null,
            updated: false
          },
          null,
          2
        )}\n`
      );
      return;
    }

    context.stdout.write(`Current: ${currentVersion}\n`);
    context.stdout.write(`Latest:  ${latestVersion}\n`);
    context.stdout.write("\n");

    if (updateAvailable) {
      context.stdout.write("Update available:\n");
      context.stdout.write(`${installCommand}\n`);
      return;
    }

    context.stdout.write(`ScopeHold CLI is up to date: ${currentVersion}\n`);
    return;
  }

  let updated = false;
  let updateError: string | null = null;
  try {
    await runNpmUpdate(registryUrl);
    updated = true;
  } catch (error) {
    updateError = error instanceof Error && error.message.trim() ? error.message.trim() : "npm update failed.";
  }

  if (optionBoolean(context.parsed.options, "json")) {
    context.stdout.write(
      `${JSON.stringify(
        {
          current: currentVersion,
          latest: latestVersion,
          updateAvailable,
          installCommand,
          updated,
          updatedVersion: updated ? latestVersion : null,
          manualCommand: updated ? null : installCommand,
          error: updateError
        },
        null,
        2
      )}\n`
    );
    if (!updated) {
      process.exit(1);
    }
    return;
  }

  context.stdout.write(`Current: ${currentVersion}\n`);
  context.stdout.write(`Latest:  ${latestVersion}\n`);
  context.stdout.write("\n");

  if (updated) {
    context.stdout.write(`Updated ScopeHold CLI to ${latestVersion}.\n`);
    context.stdout.write("Run scopehold --version to verify your shell is using the updated binary.\n");
    return;
  }

  context.stderr.write(redactSensitiveText(`ScopeHold CLI could not self-update: ${updateError ?? "unknown error"}\n`));
  context.stderr.write(`Run manually:\n${installCommand}\n`);
  process.exit(1);
}

async function statusCommand(context: CliContext): Promise<void> {
  let runtime: RuntimeContext | null = null;
  let runtimeError: Error | null = null;

  try {
    runtime = await resolveRuntimeContext(context);
  } catch (error) {
    runtimeError = error instanceof Error ? error : new Error("ScopeHold status failed.");
  }

  const project = await findProjectConfig(context.cwd);
  const payload = {
    profile: runtime?.profileName ?? null,
    apiUrl: runtime?.apiUrl ?? null,
    authType: runtime?.profile ? storedProfileAuthType(runtime.profile) : runtime ? "environment_token" : null,
    agent: runtime?.profile
      ? {
          id: runtime.profile.agentId ?? null,
          displayName: runtime.profile.agentName ?? null
        }
      : null,
    projectConfig: project
      ? {
          path: project.configPath,
          profile: project.config.profile ?? null,
          workspaceSlug: project.config.workspaceSlug ?? null,
          projectSlug: project.config.projectSlug ?? null,
          secretCount: Object.keys(project.config.secrets ?? {}).length,
          hasContext: Boolean(
            project.config.workspaceId ??
              project.config.workspaceSlug ??
              project.config.projectId ??
              project.config.projectSlug
          )
        }
      : null,
    ready: Boolean(runtime),
    error: runtimeError?.message ?? null
  };

  if (optionBoolean(context.parsed.options, "json")) {
    context.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (payload.ready) {
    context.stdout.write("ScopeHold is configured.\n");
    context.stdout.write(`Profile: ${payload.profile ?? "environment token"}\n`);
    context.stdout.write(`Auth: ${payload.authType ?? "unknown"}\n`);
    context.stdout.write(`API URL: ${payload.apiUrl}\n`);
    if (payload.agent?.displayName || payload.agent?.id) {
      context.stdout.write(`Agent: ${payload.agent.displayName ?? "unknown"} (${payload.agent.id ?? "unknown id"})\n`);
    }
  } else {
    context.stdout.write("ScopeHold is not configured.\n");
    if (payload.error) {
      context.stdout.write(`Reason: ${payload.error}\n`);
    }
  }

  if (payload.projectConfig) {
    context.stdout.write(`Project config: ${payload.projectConfig.path}\n`);
    context.stdout.write(`Project profile: ${payload.projectConfig.profile ?? "not set"}\n`);
    context.stdout.write(`Project context: ${payload.projectConfig.hasContext ? "set" : "not set"}\n`);
    context.stdout.write(`Mapped secrets: ${payload.projectConfig.secretCount}\n`);
  } else {
    context.stdout.write(`Project config: not found (${projectConfigFileName})\n`);
  }
}

async function fetchJson(input: {
  apiUrl: string;
  path: string;
  token?: string;
  method?: string;
  body?: unknown;
}): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (input.token) {
    headers.Authorization = `Bearer ${input.token}`;
  }
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${input.apiUrl.replace(/\/+$/, "")}${input.path}`, {
    method: input.method ?? "GET",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  });

  if (!response.ok) {
    let message = `ScopeHold request failed with ${response.status}.`;
    try {
      const payload = await response.json();
      if (typeof payload === "object" && payload !== null && "error" in payload) {
        const error = (payload as { error?: unknown }).error;
        if (typeof error === "string") {
          message = error;
        } else if (typeof error === "object" && error !== null && "message" in error) {
          const nestedMessage = (error as { message?: unknown }).message;
          if (typeof nestedMessage === "string") {
            message = nestedMessage;
          }
        }
      }
    } catch {
      // Preserve fallback message.
    }

    throw new CliError(redactSensitiveText(message), response.status === 400 ? 2 : 1);
  }

  return response.json();
}

async function profileCanAuthenticate(input: {
  apiUrl: string;
  homeDir: string;
  profile: StoredProfile;
  profileName: string;
  store: CredentialsStore;
}): Promise<boolean> {
  try {
    const usable = await tokenForProfile(input);
    await fetchJson({
      apiUrl: input.apiUrl,
      path: "/resolve/inventory",
      token: usable.token
    });
    return true;
  } catch {
    return false;
  }
}

function suggestedRepoSlug(project: { config: RuntimeConfig; configPath: string } | null, cwd: string): string {
  if (project?.config.workspaceSlug && project.config.projectSlug) {
    return `${project.config.workspaceSlug}/${project.config.projectSlug}`.slice(0, 200);
  }

  if (project?.config.projectSlug) {
    return project.config.projectSlug.slice(0, 200);
  }

  if (project?.config.workspaceSlug) {
    return `${project.config.workspaceSlug}/all-projects`.slice(0, 200);
  }

  return path.basename(cwd).slice(0, 200);
}

async function startDeviceAuthorization(input: {
  agentName: string;
  context: CliContext;
  metadata: OAuthAuthorizationServerMetadata;
  project: { config: RuntimeConfig; configPath: string } | null;
}): Promise<DeviceAuthorizationResponse> {
  const response = await fetchJsonResponse({
    url: input.metadata.device_authorization_endpoint,
    method: "POST",
    body: {
      agentName: input.agentName.slice(0, 80),
      hostname: hostname().slice(0, 120),
      runtimeType: "scopehold-cli",
      repoSlug: suggestedRepoSlug(input.project, input.context.cwd)
    }
  });

  if (!response.ok) {
    throw new CliError(oauthErrorMessage(response.payload, "ScopeHold could not start device authorization."));
  }

  return parseDeviceAuthorization(response.payload);
}

async function pollDeviceToken(input: {
  device: DeviceAuthorizationResponse;
  metadata: OAuthAuthorizationServerMetadata;
}): Promise<OAuthTokenResponse> {
  let intervalSeconds = Math.max(0, input.device.interval ?? 5);
  const expiresAt = Date.now() + input.device.expires_in * 1000;

  while (Date.now() < expiresAt) {
    await sleep(intervalSeconds * 1000);

    const response = await fetchJsonResponse({
      url: input.metadata.token_endpoint,
      method: "POST",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: input.device.device_code
      }
    });

    if (response.ok) {
      return parseOAuthTokenResponse(response.payload);
    }

    const error = typeof response.payload === "object" && response.payload !== null ? (response.payload as OAuthErrorResponse).error : null;

    if (error === "authorization_pending") {
      continue;
    }

    if (error === "slow_down") {
      intervalSeconds += 5;
      continue;
    }

    if (error === "access_denied") {
      throw new CliError("ScopeHold authorization was denied.");
    }

    if (error === "expired_token") {
      throw new CliError("ScopeHold authorization expired. Run scopehold connect again.");
    }

    throw new CliError(oauthErrorMessage(response.payload, "ScopeHold authorization failed."));
  }

  throw new CliError("ScopeHold authorization expired. Run scopehold connect again.");
}

async function connectCommand(context: CliContext): Promise<void> {
  const project = await findProjectConfig(context.cwd);
  const store = await readCredentials(context.homeDir);
  const explicitProfile = optionString(context.parsed.options, "profile");
  const profileName = profileNameForConnection({
    explicitProfile,
    project,
    store
  });
  const existing = store.profiles[profileName];
  const apiUrl = apiUrlForProfile({
    context,
    profile: existing,
    project
  });

  if (existing) {
    const works = await profileCanAuthenticate({
      apiUrl,
      homeDir: context.homeDir,
      profile: existing,
      profileName,
      store
    });

    if (works) {
      if (optionBoolean(context.parsed.options, "json")) {
        context.stdout.write(
          `${JSON.stringify(
            {
              profile: profileName,
              apiUrl,
              reused: true,
              authType: storedProfileAuthType(store.profiles[profileName] ?? existing),
              agent: {
                id: store.profiles[profileName]?.agentId ?? existing.agentId ?? null,
                displayName: store.profiles[profileName]?.agentName ?? existing.agentName ?? null
              }
            },
            null,
            2
          )}\n`
        );
        return;
      }

      context.stdout.write(`ScopeHold profile "${profileName}" is already connected.\n`);
      context.stdout.write("No new authorization flow was started.\n");
      return;
    }

    const stream = optionBoolean(context.parsed.options, "json") ? context.stderr : context.stdout;
    stream.write(`ScopeHold profile "${profileName}" could not authenticate. Starting a new connection.\n`);
  }

  const metadata = await discoverOAuthServer(apiUrl);
  const agentName =
    optionString(context.parsed.options, "agent-name") ??
    existing?.agentName ??
    `ScopeHold CLI on ${hostname() || "this machine"}`;
  const device = await startDeviceAuthorization({
    agentName,
    context,
    metadata,
    project
  });
  const approvalUrl = device.verification_uri_complete ?? device.verification_uri;

  const stream = optionBoolean(context.parsed.options, "json") ? context.stderr : context.stdout;
  stream.write("Authorize this ScopeHold CLI profile in your browser.\n");
  stream.write(`User code: ${device.user_code}\n`);
  if (isInteractiveStream(stream) && (await openBrowser(approvalUrl))) {
    stream.write("Opening browser for approval.\n");
  }
  stream.write(`Open: ${approvalUrl}\n`);
  if (device.verification_uri_complete) {
    stream.write(`Or go to ${device.verification_uri} and enter the code above.\n`);
  }
  stream.write("Waiting for approval...\n");

  const tokenResponse = await pollDeviceToken({
    device,
    metadata
  });

  await ensureUserConfig(context.homeDir);
  const latestStore = await readCredentials(context.homeDir);
  const now = new Date().toISOString();
  const latestExisting = latestStore.profiles[profileName];
  latestStore.profiles[profileName] = {
    apiUrl,
    authType: "oauth",
    token: tokenResponse.access_token,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    tokenType: tokenResponse.token_type,
    accessTokenExpiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
    agentId: tokenResponse.agent?.id,
    agentName: tokenResponse.agent?.displayName,
    createdAt: latestExisting?.createdAt ?? now,
    updatedAt: now
  };
  await writeCredentials(context.homeDir, latestStore);

  if (optionBoolean(context.parsed.options, "json")) {
    context.stdout.write(
      `${JSON.stringify(
        {
          profile: profileName,
          apiUrl,
          reused: false,
          agent: tokenResponse.agent ?? null,
          credentialsPath: credentialsPath(context.homeDir)
        },
        null,
        2
      )}\n`
    );
    return;
  }

  context.stdout.write(`Connected ScopeHold profile: ${profileName}\n`);
  context.stdout.write(`Agent: ${tokenResponse.agent?.displayName ?? "unknown"} (${tokenResponse.agent?.id ?? "unknown id"})\n`);
  context.stdout.write(`Credentials: ${credentialsPath(context.homeDir)}\n`);
}

async function disconnectCommand(context: CliContext): Promise<void> {
  const project = await findProjectConfig(context.cwd);
  const store = await readCredentials(context.homeDir);
  const profileName = profileNameForConnection({
    explicitProfile: optionString(context.parsed.options, "profile"),
    project,
    store
  });
  const profile = profileFromStore(store, profileName);

  if (storedProfileAuthType(profile) !== "oauth") {
    throw new CliError(
      `ScopeHold profile "${profileName}" uses a legacy Agent Key. Revoke it in ScopeHold, or remove it from ${credentialsPath(context.homeDir)}.`
    );
  }

  const token = profileRefreshToken(profile) ?? profileAccessToken(profile);
  if (!token) {
    throw new CliError(`ScopeHold profile "${profileName}" has no OAuth token to revoke.`);
  }

  const apiUrl = apiUrlForProfile({
    context,
    profile,
    project
  });
  let revocationWarning: string | null = null;
  try {
    const metadata = await discoverOAuthServer(apiUrl);
    const response = await fetchJsonResponse({
      url: metadata.revocation_endpoint,
      method: "POST",
      body: {
        token
      }
    });

    if (!response.ok) {
      revocationWarning = oauthErrorMessage(response.payload, "The ScopeHold API rejected the revocation request.");
    }
  } catch (error) {
    revocationWarning = error instanceof Error && error.message.trim() ? error.message : "Could not reach the ScopeHold API.";
  }

  const latestStore = await readCredentials(context.homeDir);
  delete latestStore.profiles[profileName];
  await writeCredentials(context.homeDir, latestStore);

  if (revocationWarning) {
    context.stderr.write(
      redactSensitiveText(
        `Warning: server-side revocation failed (${revocationWarning}). Local tokens for "${profileName}" were removed anyway; revoke the agent's access from the Connected Agents panel in ScopeHold.\n`
      )
    );
  }

  if (optionBoolean(context.parsed.options, "json")) {
    context.stdout.write(
      `${JSON.stringify(
        {
          profile: profileName,
          disconnected: true,
          revoked: revocationWarning === null
        },
        null,
        2
      )}\n`
    );
    return;
  }

  context.stdout.write(`Disconnected ScopeHold profile: ${profileName}\n`);
}

async function inventoryCommand(context: CliContext): Promise<void> {
  const runtime = await resolveRuntimeContext(context);
  const payload = (await fetchJson({
    apiUrl: runtime.apiUrl,
    path: "/resolve/inventory",
    token: runtime.token
  })) as InventoryResponse;

  if (optionBoolean(context.parsed.options, "json")) {
    context.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const secrets = payload.secrets ?? [];
  context.stdout.write(`Accessible secrets: ${secrets.length}\n`);
  for (const secret of secrets) {
    const environment = secret.environment ? `:${secret.environment}` : "";
    context.stdout.write(`- ${secret.provider ?? "unknown"}/${secret.name}${environment}`);
    if (secret.scopeKind) {
      context.stdout.write(` (${secret.scopeKind})`);
    }
    context.stdout.write("\n");
  }
}

function parseSecretRef(value: string): { provider: string; name: string } {
  const [provider, ...nameParts] = value.split("/");
  const name = nameParts.join("/");

  if (!provider || !name) {
    throw new CliError("Secret reference must be provider/name.", 2);
  }

  return {
    provider,
    name
  };
}

function serializeSecretValue(result: ResolveSecretResult): string {
  if (result.credentialType === "login_credential") {
    return JSON.stringify(result.credentials);
  }

  return result.value;
}

function parseInlineSecretMapping(value: string): { envName: string; mapping: InlineSecretMapping } {
  const equalsIndex = value.indexOf("=");
  if (equalsIndex <= 0 || equalsIndex === value.length - 1) {
    throw new CliError("--secret must be NAME=provider/name[:field].", 2);
  }

  const envName = value.slice(0, equalsIndex).trim();
  const locator = value.slice(equalsIndex + 1).trim();
  if (!envNamePattern.test(envName)) {
    throw new CliError(`--secret environment name "${envName}" is invalid. Use a shell-safe env var name.`, 2);
  }

  const fieldSeparatorIndex = locator.lastIndexOf(":");
  let ref = locator;
  let field: InlineSecretField = "value";

  if (fieldSeparatorIndex !== -1) {
    const maybeField = locator.slice(fieldSeparatorIndex + 1).trim();
    if (!inlineSecretFields.has(maybeField as InlineSecretField)) {
      throw new CliError(
        `Unsupported --secret field "${maybeField}". Use value, username, password, loginUrl, or referenceId.`,
        2
      );
    }

    ref = locator.slice(0, fieldSeparatorIndex);
    field = maybeField as InlineSecretField;
  }

  const parsedRef = parseSecretRef(ref);
  return {
    envName,
    mapping: {
      ...parsedRef,
      field
    }
  };
}

function serializeInlineSecretValue(result: ResolveSecretResult, field: InlineSecretField): string {
  if (field === "referenceId") {
    if (result.credentialType !== "api_key") {
      throw new CliError(
        `Secret ${result.secret.providerName}/${result.secret.name} is a login credential. Select username, password, or loginUrl.`
      );
    }

    if (typeof result.referenceId !== "string" || !result.referenceId.trim()) {
      throw new CliError(`Secret ${result.secret.providerName}/${result.secret.name} does not have a referenceId value.`);
    }

    return result.referenceId;
  }

  if (field === "value") {
    if (result.credentialType !== "api_key") {
      throw new CliError(
        `Secret ${result.secret.providerName}/${result.secret.name} is a login credential. Select username, password, or loginUrl.`
      );
    }

    return result.value;
  }

  if (result.credentialType !== "login_credential") {
    throw new CliError(
      `Secret ${result.secret.providerName}/${result.secret.name} is an API key. Select value or referenceId.`
    );
  }

  const value = result.credentials[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new CliError(`Secret ${result.secret.providerName}/${result.secret.name} does not have a ${field} value.`);
  }

  return value;
}

function generatedRunId(): string {
  return `run_${randomUUID()}`;
}

function runCommandAlias(command: string | null): RunCommandAlias {
  return command === "exec" ? "exec" : "run";
}

function summarizeCommand(command: string, args: string[]): string {
  const commandName = path.basename(command) || command;
  const argLabel = args.length === 1 ? "arg" : "args";
  return `${commandName} (+${args.length} ${argLabel})`.slice(0, 160);
}

function uniqueSecretEnvNames(
  configSecrets: Record<string, SecretMapping>,
  inlineSecrets: Array<{ envName: string; mapping: InlineSecretMapping }>
): string[] {
  const names = new Set<string>();

  for (const envName of Object.keys(configSecrets)) {
    if (!envNamePattern.test(envName)) {
      throw new CliError(`${projectConfigFileName} secret environment name "${envName}" is invalid. Use a shell-safe env var name.`, 2);
    }

    names.add(envName);
  }

  for (const inlineSecret of inlineSecrets) {
    names.add(inlineSecret.envName);
  }

  return [...names];
}

async function recordAgentRunEvent(input: {
  runtime: RuntimeContext;
  options: Record<string, OptionValue>;
  runId: string;
  event: AgentRunEvent;
  commandAlias: RunCommandAlias;
  commandSummary: string;
  secretEnvNames: string[];
  durationMs?: number;
  exitCode?: number;
}): Promise<void> {
  const contextFields = withConfigContext({
    config: input.runtime.config,
    options: input.options
  });

  await fetchJson({
    apiUrl: input.runtime.apiUrl,
    path: "/agent-runs/events",
    method: "POST",
    token: input.runtime.token,
    body: {
      event: input.event,
      runId: input.runId,
      source: "scopehold_run",
      commandAlias: input.commandAlias,
      commandSummary: input.commandSummary,
      secretEnvNames: input.secretEnvNames,
      durationMs: input.durationMs,
      exitCode: input.exitCode,
      taskId: optionString(input.options, "task-id"),
      purpose: optionString(input.options, "purpose"),
      ...contextFields
    }
  });
}

async function resolveOne(input: {
  runtime: RuntimeContext;
  secret: {
    provider: string;
    name: string;
    environment?: string;
  };
  options?: Record<string, OptionValue>;
  runMetadata?: {
    commandAlias: RunCommandAlias;
    runId: string;
  };
}): Promise<ResolveSecretResult> {
  const contextFields = withConfigContext({
    config: input.runtime.config,
    options: input.options ?? {}
  });

  return resolveScopeHoldSecret({
    apiUrl: input.runtime.apiUrl,
    token: input.runtime.token,
    provider: input.secret.provider,
    name: input.secret.name,
    environment: input.secret.environment,
    clientId: optionString(input.options ?? {}, "client-id") ?? input.runtime.profileName,
    taskId: optionString(input.options ?? {}, "task-id"),
    source: input.runMetadata ? "scopehold_run" : optionString(input.options ?? {}, "source") ?? "cli",
    commandAlias: input.runMetadata?.commandAlias,
    runId: input.runMetadata?.runId,
    purpose: optionString(input.options ?? {}, "purpose"),
    ...contextFields
  });
}

async function resolveCommand(context: CliContext): Promise<void> {
  const secretRef = context.parsed.args[0];
  if (!secretRef) {
    throw new CliError("resolve requires provider/name.", 2);
  }

  const runtime = await resolveRuntimeContext(context);
  const parsedRef = parseSecretRef(secretRef);
  const result = await resolveOne({
    runtime,
    secret: {
      ...parsedRef,
      environment: optionString(context.parsed.options, "environment")
    },
    options: context.parsed.options
  });

  if (optionBoolean(context.parsed.options, "json") || optionBoolean(context.parsed.options, "metadata")) {
    context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  context.stdout.write(`${serializeSecretValue(result)}\n`);
}

async function runCommand(context: CliContext): Promise<void> {
  if (context.parsed.afterDoubleDash.length === 0) {
    throw new CliError("run requires a command after --.", 2);
  }

  const [command, ...args] = context.parsed.afterDoubleDash;
  if (!command) {
    throw new CliError("run requires a command after --.", 2);
  }

  const inlineSecrets = optionStrings(context.parsed.options, "secret").map(parseInlineSecretMapping);
  const runtime = await resolveRuntimeContext(context);
  if (!runtime.configPath && inlineSecrets.length === 0) {
    throw new CliError(`run requires a ${projectConfigFileName} project config or at least one --secret mapping.`, 2);
  }

  const secrets = runtime.config?.secrets ?? {};
  const runId = generatedRunId();
  const commandAlias = runCommandAlias(context.parsed.command);
  const commandSummary = summarizeCommand(command, args);
  const secretEnvNames = uniqueSecretEnvNames(secrets, inlineSecrets);
  const startedAt = Date.now();
  let started = false;
  let childExited = false;
  let finalEventRecorded = false;
  const mappedSecrets: Record<string, string> = {};

  try {
    await recordAgentRunEvent({
      runtime,
      options: context.parsed.options,
      runId,
      event: "start",
      commandAlias,
      commandSummary,
      secretEnvNames
    });
    started = true;

    for (const [envName, mapping] of Object.entries(secrets)) {
      const result = await resolveOne({
        runtime,
        secret: mapping,
        options: context.parsed.options,
        runMetadata: {
          commandAlias,
          runId
        }
      });
      mappedSecrets[envName] = serializeSecretValue(result);
    }

    for (const inlineSecret of inlineSecrets) {
      const result = await resolveOne({
        runtime,
        secret: inlineSecret.mapping,
        options: context.parsed.options,
        runMetadata: {
          commandAlias,
          runId
        }
      });
      mappedSecrets[inlineSecret.envName] = serializeInlineSecretValue(result, inlineSecret.mapping.field);
    }

    const childEnv = createChildEnvWithMappedSecrets(context.env, mappedSecrets);

    const child = spawn(command, args, {
      stdio: "inherit",
      env: childEnv,
      cwd: context.cwd
    });

    for (const envName of Object.keys(mappedSecrets)) {
      delete mappedSecrets[envName];
      delete childEnv[envName];
    }

    const childResult = await new Promise<{ exitCode: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) =>
        resolve({
          exitCode: code ?? 1,
          signal
        })
      );
    });
    childExited = true;

    const event: AgentRunEvent =
      childResult.signal === null ? (childResult.exitCode === 0 ? "complete" : "failed") : "aborted";
    await recordAgentRunEvent({
      runtime,
      options: context.parsed.options,
      runId,
      event,
      commandAlias,
      commandSummary,
      secretEnvNames,
      durationMs: Date.now() - startedAt,
      exitCode: childResult.signal === null ? childResult.exitCode : undefined
    });
    finalEventRecorded = true;

    process.exit(childResult.exitCode);
  } catch (error) {
    for (const envName of Object.keys(mappedSecrets)) {
      delete mappedSecrets[envName];
    }

    if (started && !childExited && !finalEventRecorded) {
      try {
        await recordAgentRunEvent({
          runtime,
          options: context.parsed.options,
          runId,
          event: "failed",
          commandAlias,
          commandSummary,
          secretEnvNames,
          durationMs: Date.now() - startedAt
        });
      } catch {
        // Preserve the original failure; the CLI caller should see why the run failed.
      }
    }

    throw error;
  }
}

async function agentCommand(context: CliContext): Promise<void> {
  const subcommand = context.parsed.args.shift();
  if (subcommand !== "provision") {
    throw new CliError("Usage: scopehold agent provision --url <url> --token <token> --profile <name>", 2);
  }

  await agentProvisionCommand(context);
}

async function agentProvisionCommand(context: CliContext): Promise<void> {
  const redeemUrl = requireOption(context.parsed.options, "url");
  const provisioningToken = requireOption(context.parsed.options, "token");
  const profileName = requireOption(context.parsed.options, "profile");
  const url = new URL(redeemUrl);
  const apiUrl = normalizeApiUrl(optionString(context.parsed.options, "api-url") ?? url.origin);

  const payload = (await fetchJson({
    apiUrl: "",
    path: redeemUrl,
    method: "POST",
    body: {
      token: provisioningToken
    }
  })) as ProvisionResponse;

  const agentToken = typeof payload.token === "string" && payload.token.trim() ? payload.token : null;
  if (!agentToken) {
    throw new CliError("ScopeHold did not return an Agent Key.");
  }

  await ensureUserConfig(context.homeDir);
  const store = await readCredentials(context.homeDir);
  const now = new Date().toISOString();
  const existing = store.profiles[profileName];
  store.profiles[profileName] = {
    apiUrl,
    authType: "agent_key",
    token: agentToken,
    agentId: payload.agent?.id,
    agentName: payload.agent?.displayName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await writeCredentials(context.homeDir, store);

  if (optionBoolean(context.parsed.options, "json")) {
    context.stdout.write(
      `${JSON.stringify(
        {
          profile: profileName,
          apiUrl,
          agent: payload.agent ?? null,
          credentialsPath: credentialsPath(context.homeDir)
        },
        null,
        2
      )}\n`
    );
    return;
  }

  context.stdout.write(`Stored ScopeHold profile: ${profileName}\n`);
  context.stdout.write(`Agent: ${payload.agent?.displayName ?? "unknown"} (${payload.agent?.id ?? "unknown id"})\n`);
  context.stdout.write(`Credentials: ${credentialsPath(context.homeDir)}\n`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const context: CliContext = {
    parsed,
    cwd: process.cwd(),
    env: process.env,
    homeDir: homedir(),
    stdout: process.stdout,
    stderr: process.stderr
  };

  if (optionBoolean(parsed.options, "version")) {
    await versionCommand(context);
    return;
  }

  if (!parsed.command || optionBoolean(parsed.options, "help")) {
    await showHelp(context);
    return;
  }

  const handler = commands[parsed.command];
  if (!handler) {
    throw new CliError(`Unknown command: ${parsed.command}`, 2);
  }

  await handler(context);
}

main().catch((error: unknown) => {
  if (error instanceof ScopeHoldResolveError) {
    console.error(redactSensitiveText(error.message));
    process.exit(error.status === 400 ? 2 : 1);
  }

  if (error instanceof CliError) {
    console.error(redactSensitiveText(error.message));
    process.exit(error.code);
  }

  console.error(error instanceof Error ? redactSensitiveText(error.message) : "ScopeHold CLI failed.");
  process.exit(1);
});
