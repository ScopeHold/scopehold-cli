# ScopeHold CLI

Official ScopeHold CLI and agent skill for connecting agent profiles, listing accessible secrets, and resolving ScopeHold-managed credentials from local developer and agent runtimes.

The CLI is a thin wrapper around ScopeHold's public API. It is the recommended path because it gives agents a repeatable local profile, browser-approved access, refreshable OAuth tokens, and restrictive credential-file permissions. Prompt provisioning remains available as a fallback for CI, scripts, and runtimes that cannot complete browser approval.

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
scopehold connect --profile "<profile>"
scopehold agent provision --url "<provisioning-url>" --token "<one-time-token>" --profile "<profile>"
scopehold status --profile "<profile>"
scopehold inventory --profile "<profile>"
scopehold resolve openai/api_key --profile "<profile>"
scopehold run -- npm test
scopehold disconnect --profile "<profile>"
```

## Connect

`scopehold connect` is the preferred way to connect a local agent profile. It uses the OAuth device authorization flow:

```sh
scopehold connect --profile scopehold-agent
```

The command prints a short user code and an approval URL:

```text
User code: ABCD-EFGH
Open: https://scopehold.com/authorize-agent?code=ABCD-EFGH
```

Open the URL, approve the agent in ScopeHold, choose its project access and token lifetime, then return to the terminal. The CLI stores the returned access and refresh tokens in the selected profile and silently refreshes access tokens when you run `status`, `inventory`, `resolve`, or `run`.

If the selected profile can already authenticate, `scopehold connect` reuses it and exits without starting a new approval flow.

You can pass a suggested agent name for the approval screen:

```sh
scopehold connect --profile scopehold-agent --agent-name "Local Codex"
```

To revoke a connected OAuth profile and remove it from the local credential store:

```sh
scopehold disconnect --profile scopehold-agent
```

If server-side revocation fails (for example, the API is unreachable), the local tokens are still removed and the CLI prints a warning — revoke the agent's access from the Connected Agents panel in ScopeHold in that case. If a refresh ever fails, re-run `scopehold connect --profile <profile>`; the approval screen re-links your existing agent identity.

## Local Files

The CLI stores profile credentials under the user's home directory, outside the repo:

```text
~/.scopehold/
  config.json
  credentials.json
```

The directory is written with `0700` permissions. Credential files are written with `0600` permissions. The credential store may contain OAuth access and refresh tokens for `scopehold connect` profiles or legacy Agent Keys for fallback provisioning profiles. Do not print, paste, commit, or log these values.

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

Do not store Agent Keys, OAuth tokens, provider secret values, database URLs, or credential payloads in `.scopehold.json`.

## Run

`scopehold run` resolves the mapped secrets in `.scopehold.json`, injects them into the child process environment, and does not write resolved values to disk:

```sh
scopehold run -- npm test
```

`exec` is a permanent, behaviour-identical alias, so `scopehold exec -- npm test` keeps working unchanged.

The API can mirror the underlying resolve calls, but it cannot launch a local process or inject environment variables by itself. API-only agents can reproduce the outcome by resolving each required secret through `/resolve` and setting environment variables in their own runtime.

The CLI removes ScopeHold token environment variables before launching the child process. Only the secrets mapped in `.scopehold.json` are added to the child process environment.

## Agent Skill

The npm package includes reusable ScopeHold Agent Guidance at:

```text
skills/scopehold-agent/SKILL.md
```

Use it when an agent receives a ScopeHold connection instruction, provisioning prompt, Agent Key, CLI profile, `.scopehold.json` config, or needs to list or resolve ScopeHold-managed secrets safely. Install or register it using the normal mechanism for your agent runtime. The CLI does not install skills or rules because Claude Code, Codex, Cursor, and other agents use different extension formats and locations.

## API Fallback

OAuth discovery:

```sh
curl "https://api.scopehold.com/.well-known/oauth-authorization-server"
```

Prompt provisioning fallback:

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

Never paste Agent Keys, OAuth tokens, device codes, refresh tokens, or resolved secret values into chat, GitHub issues, PRs, docs, logs, or repo files.
