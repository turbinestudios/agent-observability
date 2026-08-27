/**
 * Public surface of @agent-observability/core.
 *
 * Consumers may also deep-import (`@agent-observability/core/src/telemetry/models`);
 * this barrel exists for the common entry points. It re-exports explicitly
 * rather than with `export *` on purpose — several subtrees define their own
 * `models.ts`, and star-exporting them would collide silently.
 *
 * Everything here is host-independent: no `vscode`, no Electron. That is
 * enforced by the `no-restricted-imports` rule in this package's eslint config.
 */

export {};
