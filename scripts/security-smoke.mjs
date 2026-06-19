import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const cliPath = path.resolve("dist/index.js");
const fakeAgentKey = `agt_${"1234567890abcdef".repeat(3)}`;
const fakeProvisioningToken = `agp_${"abcdef1234567890".repeat(3)}`;
const fakeSecretValue = "fake-secret-value-from-test";
const fakeInlineSecretValue = "inline-secret-value-from-test";
const fakeInlineReferenceId = "ref_inline_access_key_id";
const fakeDbPassword = "inline-db-password-from-test";

function runCli(args, input = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: input.cwd ?? process.cwd(),
      env: {
        ...process.env,
        HOME: input.homeDir,
        USERPROFILE: input.homeDir,
        SCOPEHOLD_TOKEN: "agt_parent_scopehold_token_should_not_reach_child",
        SCOPEHOLD_AGENT_TOKEN: "agt_parent_agent_token_should_not_reach_child",
        ...(input.env ?? {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr
      });
    });
  });
}

async function fileMode(filePath) {
  return (await stat(filePath)).mode & 0o777;
}

async function listen() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "POST" && url.pathname === "/provision") {
      response.writeHead(200, {
        "Content-Type": "application/json"
      });
      response.end(
        JSON.stringify({
          agent: {
            id: "agent_test",
            displayName: "Test Agent"
          },
          token: fakeAgentKey
        })
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/resolve/inventory") {
      response.writeHead(500, {
        "Content-Type": "application/json"
      });
      response.end(
        JSON.stringify({
          error: `upstream rejected Bearer ${fakeAgentKey} and ${fakeProvisioningToken}`
        })
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/resolve") {
      let body = {};
      for await (const chunk of request) {
        body = JSON.parse(String(chunk));
      }

      if (body.provider === "missing") {
        response.writeHead(404, {
          "Content-Type": "application/json"
        });
        response.end(JSON.stringify({ error: "Secret could not be resolved." }));
        return;
      }

      if (body.provider === "supabase" && body.name === "db") {
        response.writeHead(200, {
          "Content-Type": "application/json"
        });
        response.end(
          JSON.stringify({
            credentialType: "login_credential",
            credentials: {
              username: "postgres",
              password: fakeDbPassword,
              loginUrl: "https://database.example.com"
            },
            secret: {
              id: "secret_login_test",
              kind: "login_credential",
              name: "db",
              environment: null,
              scopeKind: "project",
              providerId: "provider_supabase",
              providerName: "supabase",
              providerDisplayName: "Supabase",
              version: 1
            }
          })
        );
        return;
      }

      response.writeHead(200, {
        "Content-Type": "application/json"
      });
      response.end(
        JSON.stringify({
          credentialType: "api_key",
          value: body.provider === "inline" ? fakeInlineSecretValue : fakeSecretValue,
          referenceId: body.provider === "inline" ? fakeInlineReferenceId : null,
          secret: {
            id: body.provider === "inline" ? "secret_inline_test" : "secret_test",
            kind: "api_key",
            name: body.name ?? "api_key",
            environment: null,
            scopeKind: "project",
            providerId: body.provider === "inline" ? "provider_inline" : "provider_test",
            providerName: body.provider ?? "stripe",
            providerDisplayName: body.provider === "inline" ? "Inline" : "Stripe",
            version: 1
          }
        })
      );
      return;
    }

    response.writeHead(404, {
      "Content-Type": "application/json"
    });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}

async function main() {
  await access(cliPath, fsConstants.X_OK);
  const homeDir = await mkdtemp(path.join(tmpdir(), "scopehold-cli-security-"));
  const projectDir = await mkdtemp(path.join(tmpdir(), "scopehold-cli-project-"));
  const server = await listen();

  try {
    const provision = await runCli(
      [
        "agent",
        "provision",
        "--url",
        `${server.apiUrl}/provision`,
        "--token",
        fakeProvisioningToken,
        "--profile",
        "test-profile",
        "--json"
      ],
      {
        homeDir
      }
    );

    assert.equal(provision.code, 0);
    assert.equal(provision.stdout.includes(fakeAgentKey), false);
    assert.equal(provision.stdout.includes(fakeProvisioningToken), false);
    assert.equal(provision.stderr, "");

    const scopeHoldDir = path.join(homeDir, ".scopehold");
    const credentialsPath = path.join(scopeHoldDir, "credentials.json");
    assert.equal(await fileMode(scopeHoldDir), 0o700);
    assert.equal(await fileMode(credentialsPath), 0o600);

    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    assert.equal(credentials.profiles["test-profile"].token, fakeAgentKey);

    await chmod(credentialsPath, 0o644);
    const status = await runCli(["status", "--profile", "test-profile"], { homeDir });
    assert.equal(status.code, 0);
    assert.equal(await fileMode(credentialsPath), 0o600);

    const inventory = await runCli(["inventory", "--profile", "test-profile"], { homeDir });
    assert.equal(inventory.code, 1);
    assert.equal(inventory.stderr.includes(fakeAgentKey), false);
    assert.equal(inventory.stderr.includes(fakeProvisioningToken), false);
    assert.match(inventory.stderr, /\[redacted\]/);

    await writeFile(
      path.join(projectDir, ".scopehold.json"),
      JSON.stringify(
        {
          profile: "test-profile",
          secrets: {
            TEST_SECRET: {
              provider: "stripe",
              name: "api_key"
            }
          }
        },
        null,
        2
      )
    );

    const execResult = await runCli(
      [
        "exec",
        "--profile",
        "test-profile",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write([process.env.TEST_SECRET, process.env.SCOPEHOLD_TOKEN || '', process.env.SCOPEHOLD_AGENT_TOKEN || ''].join('|'))"
      ],
      {
        homeDir,
        cwd: projectDir
      }
    );

    assert.equal(execResult.code, 0);
    assert.equal(execResult.stdout, `${fakeSecretValue}||`);
    assert.equal(execResult.stderr, "");

    // D-023: `run` is the documented verb and must behave identically to `exec`.
    const runResult = await runCli(
      [
        "run",
        "--profile",
        "test-profile",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write([process.env.TEST_SECRET, process.env.SCOPEHOLD_TOKEN || '', process.env.SCOPEHOLD_AGENT_TOKEN || ''].join('|'))"
      ],
      {
        homeDir,
        cwd: projectDir
      }
    );

    assert.equal(runResult.code, 0);
    assert.equal(runResult.stdout, `${fakeSecretValue}||`);
    assert.equal(runResult.stderr, "");

    const inlineWithoutConfig = await runCli(
      [
        "run",
        "--profile",
        "test-profile",
        "--secret",
        "INLINE_SECRET=inline/api_key",
        "--secret",
        "DB_PASSWORD=supabase/db:password",
        "--secret",
        "SECRET_REFERENCE=inline/api_key:referenceId",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write([process.env.INLINE_SECRET, process.env.DB_PASSWORD, process.env.SECRET_REFERENCE].join('|'))"
      ],
      {
        homeDir
      }
    );

    assert.equal(inlineWithoutConfig.code, 0);
    assert.equal(inlineWithoutConfig.stdout, `${fakeInlineSecretValue}|${fakeDbPassword}|${fakeInlineReferenceId}`);
    assert.equal(inlineWithoutConfig.stderr, "");

    const loginReferenceId = await runCli(
      [
        "run",
        "--profile",
        "test-profile",
        "--secret",
        "LOGIN_REFERENCE=supabase/db:referenceId",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write('child-ran')"
      ],
      {
        homeDir
      }
    );

    assert.equal(loginReferenceId.code, 1);
    assert.equal(loginReferenceId.stdout, "");
    assert.match(loginReferenceId.stderr, /login credential/);

    const inlineOverridesConfig = await runCli(
      [
        "run",
        "--profile",
        "test-profile",
        "--secret",
        "TEST_SECRET=inline/api_key",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(process.env.TEST_SECRET || '')"
      ],
      {
        homeDir,
        cwd: projectDir
      }
    );

    assert.equal(inlineOverridesConfig.code, 0);
    assert.equal(inlineOverridesConfig.stdout, fakeInlineSecretValue);
    assert.equal(inlineOverridesConfig.stderr, "");

    const inlineWinsOverInheritedEnv = await runCli(
      [
        "run",
        "--profile",
        "test-profile",
        "--secret",
        "INLINE_SECRET=inline/api_key",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(process.env.INLINE_SECRET || '')"
      ],
      {
        homeDir,
        env: {
          INLINE_SECRET: "inherited-value-should-not-win"
        }
      }
    );

    assert.equal(inlineWinsOverInheritedEnv.code, 0);
    assert.equal(inlineWinsOverInheritedEnv.stdout, fakeInlineSecretValue);
    assert.equal(inlineWinsOverInheritedEnv.stderr, "");

    const failFast = await runCli(
      [
        "run",
        "--profile",
        "test-profile",
        "--secret",
        "MISSING_SECRET=missing/api_key",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write('child-ran')"
      ],
      {
        homeDir
      }
    );

    assert.equal(failFast.code, 1);
    assert.equal(failFast.stdout, "");
    assert.equal(failFast.stderr.includes(fakeAgentKey), false);
    assert.match(failFast.stderr, /Secret could not be resolved/);
  } finally {
    await server.close();
    await rm(homeDir, {
      recursive: true,
      force: true
    });
    await rm(projectDir, {
      recursive: true,
      force: true
    });
  }
}

await main();
