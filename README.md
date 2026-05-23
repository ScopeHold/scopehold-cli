# ScopeHold CLI

Official ScopeHold CLI and agent skill for provisioning agent profiles, listing accessible secrets, and resolving ScopeHold-managed credentials from local developer and agent runtimes.

The CLI is a thin wrapper around ScopeHold's public API. It is the recommended path because it gives agents a repeatable local profile and restrictive credential-file permissions. The same provisioning, inventory, and resolve workflows remain available through direct API calls when a user chooses API-only operation or the CLI cannot be installed.

## Install

Early public install from GitHub:

```sh
npm install -g github:ScopeHold/scopehold-cli
```

After the npm package is published:

```sh
npm install -g @scopehold/cli
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
```

## Local Files

The CLI stores long-lived Agent Key material under the user's home directory, outside the repo:

```text
~/.scopehold/
  config.json
  credentials.json
```

The directory is written with `0700` permissions. Credential files are written with `0600` permissions.

Project-local `.scopehold.json` files must contain only non-secret context:

```json
{
  "apiUrl": "https://api.scopehold.com",
  "profile": "scopehold-agent-abc123",
  "workspaceSlug": "workspace",
  "projectSlug": "project"
}
```

Do not store Agent Keys, provider secret values, OAuth credentials, database URLs, or credential payloads in `.scopehold.json`.

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
