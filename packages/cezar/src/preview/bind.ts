/**
 * The interface a preview publishes its ports on (spec 2026-11-24-preview-environments).
 *
 * Default: the interface the cockpit itself listens on, so a preview is never reachable from
 * anywhere the cockpit is not — no new exposure, no knob. `CEZ_PREVIEW_BIND` overrides it,
 * which a cockpit behind a reverse proxy (bound to loopback, viewed over the network) needs,
 * because the proxy carries the cockpit but not the preview ports.
 */

import { hostname } from 'node:os';

let serverBindHost = '127.0.0.1';
let cockpitHost: string | undefined;

/** Called once by `startServer` with the host it binds. */
export function noteServerBindHost(host: string | undefined): void {
  serverBindHost = host && host.trim() ? host.trim() : '127.0.0.1';
}

export function previewBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CEZ_PREVIEW_BIND?.trim();
  return explicit ? explicit : serverBindHost;
}

/** True when a preview bound here cannot be reached by a remote viewer of a hosted cockpit. */
export function bindUnreachableRemotely(bind: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const loopback = bind === 'localhost' || bind === '::1' || /^127\./.test(bind);
  return loopback && env.CEZ_REMOTE === '1';
}

/** Called by the request guard with the hostname a browser reached the cockpit on. */
export function notePreviewPublicHost(host: string): void {
  cockpitHost = host;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/**
 * The host a preview's app should name for itself — `{host}` in preview.yml's `serviceEnv`
 * (`NEXT_PUBLIC_API_URL: http://{host}:{port:backend}`). In order:
 *  - `CEZ_PREVIEW_HOST`, when set;
 *  - `localhost`, when the ports are published on loopback (nothing else could reach them);
 *  - the hostname the last browser reached the cockpit on — the address testers actually use;
 *  - a specific bind address;
 *  - this machine's hostname.
 */
export function previewPublicHost(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CEZ_PREVIEW_HOST?.trim();
  if (explicit) return explicit;
  const bind = previewBindHost(env);
  if (isLoopback(bind)) return 'localhost';
  if (cockpitHost && !isLoopback(cockpitHost)) return cockpitHost;
  if (bind !== '0.0.0.0' && bind !== '::' && bind !== '') return bind;
  return hostname() || 'localhost';
}
