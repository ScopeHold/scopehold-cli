const secretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bag[pt]_[A-Za-z0-9._~-]{16,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9._~-]{16,}\b/g
];

const scopeHoldSecretEnvNames = new Set(["SCOPEHOLD_AGENT_TOKEN", "SCOPEHOLD_TOKEN"]);

export function redactSensitiveText(value: string): string {
  return secretPatterns.reduce((redacted, pattern) => redacted.replace(pattern, "[redacted]"), value);
}

export function createChildEnvWithMappedSecrets(
  parentEnv: NodeJS.ProcessEnv,
  mappedSecrets: Record<string, string>
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...parentEnv };

  for (const name of scopeHoldSecretEnvNames) {
    delete childEnv[name];
  }

  for (const [name, value] of Object.entries(mappedSecrets)) {
    childEnv[name] = value;
  }

  return childEnv;
}
