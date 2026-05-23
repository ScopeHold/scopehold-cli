---
name: scopehold-agent
description: Use when an agent is given a ScopeHold provisioning prompt, Agent Key, ScopeHold CLI profile, .scopehold.json project config, or needs to list or resolve ScopeHold-managed secrets safely.
---

# ScopeHold Agent

Use ScopeHold to resolve only the secrets required for the current task. Never ask the human to paste raw provider credentials or Agent Keys into chat.

## Safety Rules

- Do not print, paste, commit, log, screenshot, or store Agent Keys or resolved secret values in chat, GitHub, docs, logs, OpComet memory, or repo files.
- Store long-lived Agent Keys only through the official ScopeHold CLI profile flow or the runtime's secure secret store.
- Store project context in `.scopehold.json` only when it contains no secrets.
- Prefer `scopehold inventory` before resolving so you only request task-required secrets.
- Use `scopehold resolve` only when a secret value is required for the current task.
- If access is denied or a secret is missing, ask the human to grant access in ScopeHold.

## Provisioning

When given a ScopeHold setup prompt:

1. Read the assigned `ScopeHold CLI profile` from the prompt.
2. Check whether the CLI is installed:

```sh
command -v scopehold
```

3. If the CLI is missing and the runtime can install Node packages, install from the official public repo, then rerun the command check:

```sh
npm install -g github:ScopeHold/scopehold-cli
command -v scopehold
```

4. If the CLI is available, redeem the prompt exactly into the assigned profile:

```sh
scopehold agent provision --url "<provisioning-url>" --token "<one-time-token>" --profile "<assigned-profile>"
scopehold status --profile "<assigned-profile>"
```

5. If the CLI is unavailable and cannot be installed, use the complete API fallback in the setup prompt. Keep the returned Agent Key in the runtime's secure secret store for the assigned profile, or in a temporary shell variable only for the current run when no secure store exists.
6. Discard the one-time provisioning token after redemption.

## Project Config

Use the nearest `.scopehold.json` when present. It may define:

```json
{
  "apiUrl": "https://api.scopehold.com",
  "profile": "scopehold-agent-name-abc123",
  "workspaceSlug": "workspace",
  "projectSlug": "project"
}
```

The file must not contain Agent Keys, provider secret values, OAuth credentials, database URLs, or credential payloads.

## Normal Use

List accessible secrets:

```sh
scopehold inventory
```

Resolve one specific secret:

```sh
scopehold resolve openai/api_key
```

Show selected profile and config without printing secrets:

```sh
scopehold status
```

## API Fallback

If the CLI is unavailable, use the API flow from the setup prompt:

```sh
curl "$SCOPEHOLD_API_URL/resolve/inventory" -H "Authorization: Bearer <Agent Key>"
curl "$SCOPEHOLD_API_URL/resolve" \
  -H "Authorization: Bearer <Agent Key>" \
  -H "Content-Type: application/json" \
  -d '{"provider":"<provider-slug>","name":"<secret-name>","environment":"<optional-environment>"}'
```

Clear temporary shell variables and resolved secret values after the task. Keep the assigned CLI profile unless the human asks for rotation or revocation.
