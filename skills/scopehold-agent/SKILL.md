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
- Prefer `scopehold exec` when `.scopehold.json` maps the required secrets and the target command can receive secrets through environment variables.
- Use `scopehold resolve` only when a secret value is required for the current task.
- If access is denied or a secret is missing, ask the human to grant access in ScopeHold.

## Provisioning

When given a ScopeHold setup prompt:

1. Read the assigned `ScopeHold CLI profile` from the prompt.
2. If the human has not selected a path, say that ScopeHold supports either the recommended CLI path or API-only operation. Explain that the CLI is recommended because it stores the Agent Key in a named local profile and can inject mapped secrets into commands without writing resolved values to disk.
3. Check whether the CLI is installed:

```sh
command -v scopehold
```

4. If the CLI is missing and the runtime can install Node packages, install the official npm package, then rerun the command check:

```sh
npm install -g @scopehold/cli
command -v scopehold
```

5. If npm reports a successful install but `command -v scopehold` is still empty, run `npm prefix -g` and use `<prefix>/bin/scopehold` for the remaining ScopeHold commands in this task.
6. If the runtime supports reusable skills, rules, or instruction files, install or register official ScopeHold Agent Guidance using that runtime's normal mechanism. This is optional and must not block CLI or API secret resolution.
7. If the CLI is available, redeem the prompt exactly into the assigned profile:

```sh
scopehold agent provision --url "<provisioning-url>" --token "<one-time-token>" --profile "<assigned-profile>"
scopehold status --profile "<assigned-profile>"
```

8. If the human selected API-only, or the CLI is unavailable and cannot be installed, use the complete API fallback in the setup prompt. Keep the returned Agent Key in the runtime's secure secret store for the assigned profile, or in a temporary shell variable only for the current run when no secure store exists.
9. Discard the one-time provisioning token after redemption.

## Project Config

Use the nearest `.scopehold.json` when present. It may define:

```json
{
  "apiUrl": "https://api.scopehold.com",
  "profile": "scopehold-agent-name-abc123",
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

The file must not contain Agent Keys, provider secret values, OAuth credentials, database URLs, or credential payloads.

## Normal Use

List accessible secrets:

```sh
scopehold inventory
```

Run a command with mapped secrets injected:

```sh
scopehold exec -- npm test
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

The API can mirror the underlying resolve calls, but it cannot launch a local process or inject environment variables by itself. For API-only operation, resolve the required values and set environment variables through the runtime's own secure mechanism.

Clear temporary shell variables and resolved secret values after the task. Keep the assigned CLI profile unless the human asks for rotation or revocation.
