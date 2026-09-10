/** Separate from the interactive demo. Override for concurrent local runs. */
export const E2E_PORT = Number(process.env['GROVS_E2E_PORT'] ?? 4175);
if (!Number.isInteger(E2E_PORT) || E2E_PORT < 1 || E2E_PORT > 65535) {
  throw new Error('GROVS_E2E_PORT must be an integer between 1 and 65535.');
}
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
