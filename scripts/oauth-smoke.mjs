import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const cliPath = path.resolve("dist/index.js");
const deviceCode = `agdc_${"a".repeat(64)}`;
const accessToken1 = `agoa_${"b".repeat(48)}`;
const refreshToken1 = `agor_${"c".repeat(48)}`;
const accessToken2 = `agoa_${"d".repeat(48)}`;
const refreshToken2 = `agor_${"e".repeat(48)}`;

function runCli(args, input = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: input.cwd ?? process.cwd(),
      env: {
        ...process.env,
        HOME: input.homeDir,
        USERPROFILE: input.homeDir,
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

async function readBody(request) {
  let raw = "";

  for await (const chunk of request) {
    raw += chunk.toString("utf8");
  }

  return raw ? JSON.parse(raw) : {};
}

async function listen() {
  const state = {
    authorizeCount: 0,
    devicePollCount: 0,
    inventoryTokens: [],
    refreshCount: 0,
    revokedTokens: [],
    startBody: null
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const origin = `http://127.0.0.1:${server.address().port}`;

    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      response.writeHead(200, {
        "Content-Type": "application/json"
      });
      response.end(
        JSON.stringify({
          issuer: origin,
          device_authorization_endpoint: `${origin}/oauth/device/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          revocation_endpoint: `${origin}/oauth/revoke`
        })
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/oauth/device/authorize") {
      state.authorizeCount += 1;
      state.startBody = await readBody(request);
      response.writeHead(201, {
        "Content-Type": "application/json"
      });
      response.end(
        JSON.stringify({
          device_code: deviceCode,
          user_code: "TEST-CODE",
          verification_uri: "https://scopehold.com/authorize-agent",
          verification_uri_complete: "https://scopehold.com/authorize-agent?code=TEST-CODE",
          expires_in: 30,
          interval: 0
        })
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/oauth/token") {
      const body = await readBody(request);

      if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        assert.equal(body.device_code, deviceCode);
        state.devicePollCount += 1;

        if (state.devicePollCount === 1) {
          response.writeHead(400, {
            "Content-Type": "application/json"
          });
          response.end(
            JSON.stringify({
              error: "authorization_pending",
              error_description: "Waiting for approval."
            })
          );
          return;
        }

        response.writeHead(200, {
          "Content-Type": "application/json"
        });
        response.end(
          JSON.stringify({
            access_token: accessToken1,
            refresh_token: refreshToken1,
            token_type: "Bearer",
            expires_in: 1,
            agent: {
              id: "agent_oauth_test",
              displayName: "OAuth Test Agent",
              workspaceId: "workspace_test",
              projectId: "project_test"
            }
          })
        );
        return;
      }

      if (body.grant_type === "refresh_token") {
        assert.equal(body.refresh_token, refreshToken1);
        state.refreshCount += 1;
        response.writeHead(200, {
          "Content-Type": "application/json"
        });
        response.end(
          JSON.stringify({
            access_token: accessToken2,
            refresh_token: refreshToken2,
            token_type: "Bearer",
            expires_in: 3600,
            agent: {
              id: "agent_oauth_test",
              displayName: "OAuth Test Agent"
            }
          })
        );
        return;
      }
    }

    if (request.method === "POST" && url.pathname === "/oauth/revoke") {
      const body = await readBody(request);
      state.revokedTokens.push(body.token);
      response.writeHead(200, {
        "Content-Type": "application/json"
      });
      response.end(JSON.stringify({ revoked: true }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/resolve/inventory") {
      const authorization = request.headers.authorization ?? "";
      state.inventoryTokens.push(authorization.replace(/^Bearer\s+/i, ""));

      if (authorization !== `Bearer ${accessToken1}` && authorization !== `Bearer ${accessToken2}`) {
        response.writeHead(401, {
          "Content-Type": "application/json"
        });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      response.writeHead(200, {
        "Content-Type": "application/json"
      });
      response.end(
        JSON.stringify({
          agent: {
            id: "agent_oauth_test",
            workspaceId: "workspace_test",
            projectId: "project_test"
          },
          secrets: []
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
    state,
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
  const homeDir = await mkdtemp(path.join(tmpdir(), "scopehold-cli-oauth-"));
  const server = await listen();

  try {
    const connect = await runCli(
      ["connect", "--profile", "oauth-profile", "--api-url", server.apiUrl, "--agent-name", "Local Test Agent"],
      {
        homeDir
      }
    );

    assert.equal(connect.code, 0);
    assert.match(connect.stdout, /User code: TEST-CODE/);
    assert.match(connect.stdout, /https:\/\/scopehold\.com\/authorize-agent\?code=TEST-CODE/);
    assert.equal(connect.stdout.includes(deviceCode), false);
    assert.equal(connect.stdout.includes(accessToken1), false);
    assert.equal(connect.stdout.includes(refreshToken1), false);
    assert.equal(connect.stderr, "");
    assert.equal(server.state.authorizeCount, 1);
    assert.equal(server.state.devicePollCount, 2);
    assert.equal(server.state.startBody.agentName, "Local Test Agent");
    assert.equal(server.state.startBody.runtimeType, "scopehold-cli");

    const credentialsPath = path.join(homeDir, ".scopehold", "credentials.json");
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    assert.equal(credentials.profiles["oauth-profile"].authType, "oauth");
    assert.equal(credentials.profiles["oauth-profile"].accessToken, accessToken1);
    assert.equal(credentials.profiles["oauth-profile"].refreshToken, refreshToken1);

    const status = await runCli(["status", "--profile", "oauth-profile", "--json"], {
      homeDir
    });
    assert.equal(status.code, 0);
    assert.equal(status.stdout.includes(accessToken1), false);
    assert.equal(status.stdout.includes(refreshToken1), false);
    assert.equal(status.stderr, "");
    assert.equal(server.state.refreshCount, 1);

    const refreshedCredentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    assert.equal(refreshedCredentials.profiles["oauth-profile"].accessToken, accessToken2);
    assert.equal(refreshedCredentials.profiles["oauth-profile"].refreshToken, refreshToken2);

    const reusedConnect = await runCli(["connect", "--profile", "oauth-profile", "--api-url", server.apiUrl, "--json"], {
      homeDir
    });
    assert.equal(reusedConnect.code, 0);
    assert.equal(JSON.parse(reusedConnect.stdout).reused, true);
    assert.equal(reusedConnect.stderr, "");
    assert.equal(server.state.authorizeCount, 1);
    assert.ok(server.state.inventoryTokens.includes(accessToken2));

    const disconnect = await runCli(["disconnect", "--profile", "oauth-profile", "--api-url", server.apiUrl, "--json"], {
      homeDir
    });
    assert.equal(disconnect.code, 0);
    assert.equal(JSON.parse(disconnect.stdout).disconnected, true);
    assert.equal(disconnect.stderr, "");
    assert.deepEqual(server.state.revokedTokens, [refreshToken2]);

    const finalCredentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    assert.equal(finalCredentials.profiles["oauth-profile"], undefined);
  } finally {
    await server.close();
    await rm(homeDir, {
      recursive: true,
      force: true
    });
  }
}

await main();
