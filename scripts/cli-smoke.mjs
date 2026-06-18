import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const cliPath = path.resolve("dist/index.js");
const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const currentVersion = packageJson.version;

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: process.cwd(),
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

async function listen(latestVersion) {
  const state = {
    requests: []
  };

  const server = createServer((request, response) => {
    state.requests.push(request.url);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/@scopehold%2Fcli/latest") {
      response.writeHead(200, {
        "Content-Type": "application/json"
      });
      response.end(JSON.stringify({ version: latestVersion }));
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
    registryUrl: `http://127.0.0.1:${address.port}`,
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

const versionFlag = await runCli(["--version"]);
assert.equal(versionFlag.code, 0);
assert.equal(versionFlag.stdout, `${currentVersion}\n`);
assert.equal(versionFlag.stderr, "");

const versionCommand = await runCli(["version", "--json"]);
assert.equal(versionCommand.code, 0);
assert.deepEqual(JSON.parse(versionCommand.stdout), { version: currentVersion });
assert.equal(versionCommand.stderr, "");

const currentRegistry = await listen(currentVersion);
try {
  const currentUpdate = await runCli(["update", "--registry-url", currentRegistry.registryUrl]);
  assert.equal(currentUpdate.code, 0);
  assert.match(currentUpdate.stdout, new RegExp(`Current: ${currentVersion}`));
  assert.match(currentUpdate.stdout, new RegExp(`Latest:  ${currentVersion}`));
  assert.match(currentUpdate.stdout, /up to date/);
  assert.equal(currentUpdate.stderr, "");
  assert.deepEqual(currentRegistry.state.requests, ["/@scopehold%2Fcli/latest"]);
} finally {
  await currentRegistry.close();
}

const nextVersion = "999.0.0";
const nextRegistry = await listen(nextVersion);
try {
  const updateAvailable = await runCli(["update", "--registry-url", nextRegistry.registryUrl, "--json"]);
  assert.equal(updateAvailable.code, 0);
  assert.deepEqual(JSON.parse(updateAvailable.stdout), {
    current: currentVersion,
    latest: nextVersion,
    updateAvailable: true,
    installCommand: "npm install -g @scopehold/cli@latest"
  });
  assert.equal(updateAvailable.stderr, "");
} finally {
  await nextRegistry.close();
}
