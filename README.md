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
scopehold --version
```

## Commands

```sh
scopehold connect --profile "<profile>"
scopehold agent provision --url "<provisioning-url>" --token "<one-time-token>" --profile "<profile>"
scopehold status --profile "<profile>"
scopehold inventory --profile "<profile>"
scopehold resolve openai/api_key --profile "<profile>"
scopehold run --secret DATABASE_URL=supabase/database_url -- npx prisma migrate deploy
scopehold run -- npm test
scopehold version
scopehold update --check
scopehold update
scopehold disconnect --profile "<profile>"
```

`scopehold update` checks npm and installs the latest global CLI when a newer version is available. Use `--check` when you only want to know whether you are behind:

```text
Current: 0.4.0
Latest:  0.4.1

Update available:
npm install -g @scopehold/cli@latest
```

## Connect

`scopehold connect` is the preferred way to connect a local agent profile. It uses the OAuth device authorization flow:

```sh
scopehold connect --profile scopehold-agent
```

In an interactive terminal, the command opens the approval URL in your browser.
It also prints a short user code and URL as a fallback:

```text
User code: ABCD-EFGH
Opening browser for approval.
Open: https://scopehold.com/authorize-agent?code=ABCD-EFGH
```

Approve the agent in ScopeHold, choose its project access and token lifetime, then return to the terminal. The CLI stores the returned OAuth credentials in the selected profile and silently refreshes access tokens when the chosen lifetime includes a refresh token.

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

`scopehold run` resolves secrets, injects them into the child process environment, and does not write resolved values to disk. For one-off commands, use inline `--secret` mappings:

```sh
scopehold run --secret DATABASE_URL=supabase/database_url -- npx prisma migrate deploy
scopehold run --secret RESEND_API_KEY=resend/api -- node scripts/check-email.js
```

Use the environment variable name the target tool already reads. Multiple inline mappings are supported:

```sh
scopehold run \
  --secret SUPABASE_KEY=supabase/service_role \
  --secret RESEND_API_KEY=resend/api \
  -- node scripts/check-supabase-and-email.js
```

The value after `=` is a locator, not a secret, so it is safe in shell history. Field selection is available with `provider/name:field`; supported fields are `value`, `username`, `password`, `loginUrl`, and `referenceId`:

```sh
scopehold run --secret DB_PASSWORD=supabase/db:password -- npm test
```

Commands run as argv by default, not through a shell. If the command needs shell interpolation, invoke the shell explicitly after `--` and single-quote the program so your outer shell does not expand the variable before ScopeHold injects it:

```sh
scopehold run --secret SUPABASE_KEY=supabase/service_role -- \
  sh -c 'curl https://example.com -H "Authorization: Bearer $SUPABASE_KEY"'
```

For repeated workflows, keep non-secret mappings in `.scopehold.json`:

```sh
scopehold run -- npm test
```

`exec` is a permanent, behaviour-identical alias, so `scopehold exec -- npm test` keeps working unchanged.

The API can mirror the underlying resolve calls, but it cannot launch a local process or inject environment variables by itself. API-only agents can reproduce the outcome by resolving each required secret through `/resolve` and setting environment variables in their own runtime.

The CLI removes ScopeHold token environment variables before launching the child process. Inline mappings merge with `.scopehold.json` and override config mappings or inherited environment variables with the same name.

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
