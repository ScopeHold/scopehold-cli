import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const cliPath = path.resolve("dist/index.js");
const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const currentVersion = packageJson.version;

function runCli(args, input = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
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
  const currentUpdate = await runCli(["update", "--check", "--registry-url", currentRegistry.registryUrl]);
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
  const updateAvailable = await runCli(["update", "--check", "--registry-url", nextRegistry.registryUrl, "--json"]);
  assert.equal(updateAvailable.code, 0);
  assert.deepEqual(JSON.parse(updateAvailable.stdout), {
    current: currentVersion,
    latest: nextVersion,
    updateAvailable: true,
    installCommand: `npm install -g @scopehold/cli@latest --registry ${nextRegistry.registryUrl}`,
    updated: false
  });
  assert.equal(updateAvailable.stderr, "");
} finally {
  await nextRegistry.close();
}

const installRegistry = await listen(nextVersion);
const fakeBinDir = await mkdtemp(path.join(tmpdir(), "scopehold-cli-fake-npm-"));
const npmArgsPath = path.join(fakeBinDir, "npm-args.json");
const fakeNpmPath = path.join(fakeBinDir, "npm");
try {
  await writeFile(
    fakeNpmPath,
    `#!/usr/bin/env node\nconst { writeFileSync } = require("node:fs");\nwriteFileSync(${JSON.stringify(npmArgsPath)}, JSON.stringify(process.argv.slice(2)));\n`,
    "utf8"
  );
  await chmod(fakeNpmPath, 0o755);

  const updateResult = await runCli(["update", "--registry-url", installRegistry.registryUrl, "--json"], {
    env: {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });
  assert.equal(updateResult.code, 0);
  assert.deepEqual(JSON.parse(updateResult.stdout), {
    current: currentVersion,
    latest: nextVersion,
    updateAvailable: true,
    installCommand: `npm install -g @scopehold/cli@latest --registry ${installRegistry.registryUrl}`,
    updated: true,
    updatedVersion: nextVersion,
    manualCommand: null,
    error: null
  });
  assert.equal(updateResult.stderr, "");
  assert.deepEqual(JSON.parse(await readFile(npmArgsPath, "utf8")), [
    "install",
    "-g",
    "@scopehold/cli@latest",
    "--registry",
    installRegistry.registryUrl
  ]);
} finally {
  await installRegistry.close();
  await rm(fakeBinDir, {
    recursive: true,
    force: true
  });
}
