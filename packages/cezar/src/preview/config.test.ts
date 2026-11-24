import { describe, expect, it } from 'vitest';
import { loadPreviewConfig, looksLikeSecret, PREVIEW_CONFIG_PATH, type RepoFileReader } from './config.ts';

const reader = (files: Record<string, string>): RepoFileReader => async (path) => files[path] ?? null;

describe('loadPreviewConfig', () => {
  it('with no preview.yml and no compose file, fails with a sentence — never throws (empty-input case)', async () => {
    const res = await loadPreviewConfig(reader({}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no compose file found/);
  });

  it('with no preview.yml, discovers the compose file in compose\'s own order', async () => {
    const res = await loadPreviewConfig(reader({ 'docker-compose.yml': 'services: {}', 'compose.yml': 'services: {}' }));
    expect(res).toMatchObject({ ok: true, fromFile: false, composeFiles: ['compose.yml'], config: {} });
  });

  it('reads a full preview.yml', async () => {
    const yml = [
      'compose: [docker/compose.yml, docker/compose.preview.yml]',
      'copyFromRoot: [.envs/.env]',
      'expose:',
      '  frontend: { service: web, port: 5173 }',
      '  backend: { service: api, port: 8000, path: /admin/ }',
      'ready: { url: backend, path: /health/ }',
      'seed: [{ service: api, command: "python manage.py loaddata dummy" }]',
      'credentials: [{ label: Admin, url: backend, user: admin, password: admin123 }]',
    ].join('\n');
    const res = await loadPreviewConfig(
      reader({ [PREVIEW_CONFIG_PATH]: yml, 'docker/compose.yml': 'x', 'docker/compose.preview.yml': 'y' }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fromFile).toBe(true);
    expect(res.composeFiles).toEqual(['docker/compose.yml', 'docker/compose.preview.yml']);
    expect(res.config.expose?.frontend).toEqual({ service: 'web', port: 5173, path: '/' });
    expect(res.config.ready).toEqual({ url: 'backend', path: '/health/', timeoutSec: 300 });
    expect(res.warnings).toEqual([]);
  });

  it.each([
    ['an unknown key', 'exposee: {}', /exposee|Unrecognized/],
    ['a path escaping the repo', 'copyFromRoot: [../secrets/.env]', /inside the repository/],
    ['an absolute path', 'compose: /etc/compose.yml', /relative to the repository root/],
    ['a ready url that is not an expose label', 'expose: { web: { service: web, port: 80 } }\nready: { url: api }', /ready.url "api"/],
    ['a credential pointing at an unknown label', 'credentials: [{ label: A, url: nope, user: u, password: p }]', /points at url "nope"/],
    ['invalid YAML', 'expose: [', /not valid YAML/],
  ])('rejects %s', async (_name, yml, error) => {
    const res = await loadPreviewConfig(reader({ [PREVIEW_CONFIG_PATH]: yml, 'compose.yaml': 'services: {}' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(error);
  });

  it('fails when a named compose file does not exist', async () => {
    const res = await loadPreviewConfig(reader({ [PREVIEW_CONFIG_PATH]: 'compose: missing.yml' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/"missing.yml".*does not exist/);
  });

  it('warns (does not refuse) when a credential looks like a real secret', async () => {
    const yml = 'credentials: [{ label: Bot, user: bot, password: ghp_abcdefghijklmnopqrstuvwxyz0123 }]';
    const res = await loadPreviewConfig(reader({ [PREVIEW_CONFIG_PATH]: yml, 'compose.yaml': '' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warnings[0]).toMatch(/looks like a real secret/);
  });
});

describe('looksLikeSecret', () => {
  it('lets seeded test passwords through', () => {
    for (const p of ['admin', 'admin123', 'Demo!2024', 'password']) expect(looksLikeSecret(p)).toBe(false);
  });
  it('flags token shapes', () => {
    for (const p of ['sk-ant-0123456789abcdefghij', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'AKIAABCDEFGHIJKLMNOP']) expect(looksLikeSecret(p)).toBe(true);
  });
});
