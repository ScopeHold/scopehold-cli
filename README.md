# ScopeHold CLI

Official ScopeHold CLI and agent skill for provisioning agent profiles, listing accessible secrets, and resolving ScopeHold-managed credentials from local developer and agent runtimes.

The CLI is a thin wrapper around ScopeHold's public API. It is the recommended path because it gives agents a repeatable local profile and restrictive credential-file permissions. The same provisioning, inventory, and resolve workflows remain available through direct API calls when a user chooses API-only operation or the CLI cannot be installed.

## Install

Install from npm:

```sh
npm install -g @scopehold/cli
```

If npm installs successfully but your shell cannot find `scopehold`, check the global npm prefix:

```sh
npm prefix -g
<prefix>/bin/scopehold --help
```

Check the install:

```sh
scopehold --help
```

## Commands

```sh
scopehold agent provision --url "<provisioning-url>" --token "<one-time-token>" --profile "<profile>"
scopehold status --profile "<profile>"
scopehold inventory --profile "<profile>"
scopehold resolve openai/api_key --profile "<profile>"
scopehold exec -- npm test
```

## Local Files

The CLI stores long-lived Agent Key material under the user's home directory, outside the repo:

```text
~/.scopehold/
  config.json
  credentials.json
```

The directory is written with `0700` permissions. Credential files are written with `0600` permissions.

Project-local `.scopehold.json` files must contain only non-secret context and optional env-var-to-secret mappings:

```json
{
  "apiUrl": "https://api.scopehold.com",
  "profile": "scopehold-agent-abc123",
  "workspaceSlug": "workspace",
  "projectSlug": "project",
  "secrets": {
    "OPENAI_API_KEY": {
      "provider": "openai",
      "name": "api_key"
    }
  }
}
```

Do not store Agent Keys, provider secret values, OAuth credentials, database URLs, or credential payloads in `.scopehold.json`.

## Exec

`scopehold exec` resolves the mapped secrets in `.scopehold.json`, injects them into the child process environment, and does not write resolved values to disk:

```sh
scopehold exec -- npm test
```

The API can mirror the underlying resolve calls, but it cannot launch a local process or inject environment variables by itself. API-only agents can reproduce the outcome by resolving each required secret through `/resolve` and setting environment variables in their own runtime.

## Agent Skill

The official agent skill lives at:

```text
skills/scopehold-agent/SKILL.md
```

Use it when an agent receives a ScopeHold provisioning prompt, Agent Key, CLI profile, `.scopehold.json` config, or needs to list or resolve ScopeHold-managed secrets safely.

## API Fallback

Provisioning:

```sh
curl "<provisioning-url>" \
  -H "Content-Type: application/json" \
  -d '{"token":"<one-time-token>"}'
```

Inventory:

```sh
curl "https://api.scopehold.com/resolve/inventory" \
  -H "Authorization: Bearer <Agent Key>"
```

Resolve:

```sh
curl "https://api.scopehold.com/resolve" \
  -H "Authorization: Bearer <Agent Key>" \
  -H "Content-Type: application/json" \
  -d '{"provider":"<provider-slug>","name":"<secret-name>","environment":"<optional-environment>"}'
```

Never paste Agent Keys or resolved secret values into chat, GitHub issues, PRs, docs, logs, or repo files.
