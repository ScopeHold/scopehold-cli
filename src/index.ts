#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveScopeHoldSecret, ScopeHoldResolveError, type ResolveSecretResult } from "./resolve-client.js";

type CommandHandler = (context: CliContext) => Promise<void>;

type ParsedArgs = {
  command: string | null;
  args: string[];
  options: Record<string, string | boolean>;
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
  token: string;
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

const scopeHoldDirName = ".scopehold";
const credentialsFileName = "credentials.json";
const userConfigFileName = "config.json";
const projectConfigFileName = ".scopehold.json";
const defaultApiUrl = "https://api.scopehold.com";

class CliError extends Error {
  code: number;

  constructor(message: string, code = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

const commands: Record<string, CommandHandler> = {
  help: showHelp,
  status: statusCommand,
  inventory: inventoryCommand,
  resolve: resolveCommand,
  exec: execCommand,
  agent: agentCommand
};

function usage(): string {
  return `Usage: scopehold <command> [options]

Commands:
  agent provision   Redeem a one-time provisioning prompt into a named local profile
  status            Show selected profile and project config without printing secrets
  inventory         List secret metadata available to the selected Agent Key
  resolve           Resolve one secret by provider/name
  exec              Run a command with mapped secrets injected as environment variables

Global options:
  --profile <name>  Local ScopeHold profile name
  --api-url <url>   ScopeHold API URL override
  --json            Print JSON where supported
  --help            Show help

Project config:
  scopehold exec reads the nearest ${projectConfigFileName}. Store only non-secret context there.
`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const doubleDashIndex = argv.indexOf("--");
  const beforeDoubleDash = doubleDashIndex === -1 ? argv : argv.slice(0, doubleDashIndex);
  const afterDoubleDash = doubleDashIndex === -1 ? [] : argv.slice(doubleDashIndex + 1);
  const options: Record<string, string | boolean> = {};
  const args: string[] = [];

  for (let index = 0; index < beforeDoubleDash.length; index += 1) {
    const raw = beforeDoubleDash[index]!;

    if (!raw.startsWith("--")) {
      args.push(raw);
      continue;
    }

    const [name, inlineValue] = raw.slice(2).split("=", 2);
    if (!name) {
      throw new CliError("Invalid option.", 2);
    }

    if (name === "help" || name === "json" || name === "metadata") {
      options[name] = true;
      continue;
    }

    const value = inlineValue ?? beforeDoubleDash[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliError(`Missing value for --${name}.`, 2);
    }

    options[name] = value;
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

function optionString(options: Record<string, string | boolean>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionBoolean(options: Record<string, string | boolean>, name: string): boolean {
  return options[name] === true;
}

function requireOption(options: Record<string, string | boolean>, name: string): string {
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
  const store = await readJsonFile<CredentialsStore>(credentialsPath(homeDir));
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
    throw new CliError(`ScopeHold profile "${profileName}" was not found. Run scopehold agent provision first.`);
  }

  return profile;
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
    return {
      profileName: selectedProfile,
      profile,
      token: profile.token,
      apiUrl: normalizeApiUrl(optionString(context.parsed.options, "api-url") ?? project?.config.apiUrl ?? profile.apiUrl),
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
    return {
      profileName,
      profile,
      token: profile.token,
      apiUrl: normalizeApiUrl(optionString(context.parsed.options, "api-url") ?? project?.config.apiUrl ?? profile.apiUrl),
      config: project?.config,
      configPath: project?.configPath
    };
  }

  if (profileNames.length > 1) {
    throw new CliError(
      `Multiple ScopeHold profiles exist. Add "profile" to ${projectConfigFileName} or run with --profile <name>.`
    );
  }

  throw new CliError("No ScopeHold profile or Agent Key found. Run scopehold agent provision first.");
}

function withConfigContext(input: {
  config?: RuntimeConfig;
  options: Record<string, string | boolean>;
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

    throw new CliError(message, response.status === 400 ? 2 : 1);
  }

  return response.json();
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

async function resolveOne(input: {
  runtime: RuntimeContext;
  secret: {
    provider: string;
    name: string;
    environment?: string;
  };
  options?: Record<string, string | boolean>;
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
    source: optionString(input.options ?? {}, "source") ?? "cli",
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

async function execCommand(context: CliContext): Promise<void> {
  if (context.parsed.afterDoubleDash.length === 0) {
    throw new CliError("exec requires a command after --.", 2);
  }

  const runtime = await resolveRuntimeContext(context);
  if (!runtime.configPath || !runtime.config) {
    throw new CliError(`exec requires a ${projectConfigFileName} project config.`, 2);
  }

  const secrets = runtime.config.secrets ?? {};
  const childEnv: NodeJS.ProcessEnv = {
    ...context.env
  };

  for (const [envName, mapping] of Object.entries(secrets)) {
    const result = await resolveOne({
      runtime,
      secret: mapping,
      options: context.parsed.options
    });
    childEnv[envName] = serializeSecretValue(result);
  }

  const [command, ...args] = context.parsed.afterDoubleDash;
  const child = spawn(command!, args, {
    stdio: "inherit",
    env: childEnv,
    cwd: context.cwd
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  process.exit(exitCode);
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
    console.error(error.message);
    process.exit(error.status === 400 ? 2 : 1);
  }

  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(error.code);
  }

  console.error(error instanceof Error ? error.message : "ScopeHold CLI failed.");
  process.exit(1);
});
