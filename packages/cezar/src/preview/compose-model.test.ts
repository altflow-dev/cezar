import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { lintComposeModel, planPorts, renderOverride, renderServiceEnv, type ComposeModel } from './compose-model.ts';

/** A dev compose of the AltflowMetrics shape: the DB publishes 5456 and has a fixed name. */
const model: ComposeModel = {
  services: {
    web: { ports: [{ target: 5173, published: '5173' }] },
    api: { ports: [{ target: 8000, published: '8000' }], volumes: [{ type: 'bind', source: '/srv/wt/backend', target: '/app' }] },
    db: { ports: [{ target: 5432, published: '5456' }], container_name: 'altflow-db', volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }] },
    worker: {},
  },
};

describe('planPorts', () => {
  it('without expose, links every published port, labelled by service', () => {
    const res = planPorts(model, {});
    expect(res).toEqual({
      ok: true,
      ports: [
        { label: 'web', service: 'web', port: 5173, path: '/' },
        { label: 'api', service: 'api', port: 8000, path: '/' },
        { label: 'db', service: 'db', port: 5432, path: '/' },
      ],
    });
  });

  it('with expose, links exactly those', () => {
    const res = planPorts(model, { expose: { frontend: { service: 'web', port: 5173, path: '/' }, backend: { service: 'api', port: 8000, path: '/admin/' } } });
    expect(res.ok && res.ports.map((p) => p.label)).toEqual(['frontend', 'backend']);
  });

  it('names the services when expose points at one that does not exist', () => {
    const res = planPorts(model, { expose: { x: { service: 'nope', port: 1, path: '/' } } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/"nope".*web, api, db, worker/);
  });

  it('fails when there is nothing to link to', () => {
    expect(planPorts({ services: { a: {} } }, {}).ok).toBe(false);
  });
});

describe('renderOverride', () => {
  const planned = [
    { label: 'frontend', service: 'web', port: 5173, path: '/' },
    { label: 'backend', service: 'api', port: 8000, path: '/' },
  ];
  const text = renderOverride(model, planned, [41000, 41001], '0.0.0.0');

  it('publishes only the allocated ports for exposed services, on the bind host', () => {
    expect(text).toContain('"web":\n    ports: !override\n      - "0.0.0.0:41000:5173"');
    expect(text).toContain('"api":\n    ports: !override\n      - "0.0.0.0:41001:8000"');
  });

  it('unpublishes every other port and drops fixed container names, so two stacks never collide', () => {
    expect(text).toContain('"db":\n    ports: !reset []\n    container_name: !reset null');
    expect(text).not.toContain('5456');
    expect(text).not.toContain('"worker"');
  });

  it('is valid YAML once the compose tags are known', () => {
    const doc = parse(text, { customTags: [{ tag: '!override', collection: 'seq', resolve: (v: unknown) => v }, { tag: '!reset', resolve: () => null }, { tag: '!reset', collection: 'seq', resolve: () => [] }] });
    expect(Object.keys(doc.services).sort()).toEqual(['api', 'db', 'web']);
  });

  it('two runs given disjoint ports render disjoint publishes', () => {
    const other = renderOverride(model, planned, [41002, 41003], '0.0.0.0');
    expect(other).toContain('41002:5173');
    expect(other).not.toContain('41000');
  });
});

describe('lintComposeModel', () => {
  it('passes an ordinary stack whose bind mounts stay in the worktree', () => {
    expect(lintComposeModel(model, '/srv/wt')).toEqual([]);
  });

  it.each([
    ['privileged', { privileged: true }, /privileged/],
    ['cap_add', { cap_add: ['SYS_ADMIN'] }, /adds capabilities/],
    ['host network', { network_mode: 'host' }, /network_mode: host/],
    ['host pid', { pid: 'host' }, /pid: host/],
    ['devices', { devices: [{ source: '/dev/sda' }] }, /devices/],
    ['the docker socket', { volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] }, /docker socket/],
    ['a mount outside the worktree', { volumes: [{ type: 'bind', source: '/etc', target: '/host-etc' }] }, /outside the task worktree/],
    ['a sibling path that only shares a prefix', { volumes: [{ type: 'bind', source: '/srv/wt-other', target: '/x' }] }, /outside the task worktree/],
  ])('refuses %s', (_name, svc, issue) => {
    const issues = lintComposeModel({ services: { bad: svc } }, '/srv/wt');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(issue);
  });
});

describe('renderServiceEnv (the app learns where it lives)', () => {
  const ports = [
    { label: 'frontend', hostPort: 41003, path: '/' },
    { label: 'backend', hostPort: 41004, path: '/api/v1' },
  ];

  it('fills {host}, {port:x} and {url:x}, and leaves other braces alone', () => {
    const res = renderServiceEnv(
      {
        web: { NEXT_PUBLIC_API_URL: 'http://{host}:{port:backend}', LINK: '{url:backend}', JSON: '{"a":1}' },
        api: { DJANGO_ALLOWED_HOSTS: 'localhost,api,{host}', FRONTEND_URL: '{url:frontend}' },
      },
      model.services ?? {},
      ports,
      '10.0.0.5',
    )
    expect(res).toEqual({
      ok: true,
      env: {
        web: { NEXT_PUBLIC_API_URL: 'http://10.0.0.5:41004', LINK: 'http://10.0.0.5:41004/api/v1', JSON: '{"a":1}' },
        api: { DJANGO_ALLOWED_HOSTS: 'localhost,api,10.0.0.5', FRONTEND_URL: 'http://10.0.0.5:41003' },
      },
    })
  })

  it('refuses a label that is not exposed, or a service that does not exist', () => {
    expect(renderServiceEnv({ web: { X: '{port:admin}' } }, model.services ?? {}, ports, 'h')).toMatchObject({ ok: false, error: expect.stringMatching(/"admin".*frontend, backend/) })
    expect(renderServiceEnv({ nope: { X: '1' } }, model.services ?? {}, ports, 'h')).toMatchObject({ ok: false, error: expect.stringMatching(/"nope"/) })
  })

  it('lands in the override as the service environment', () => {
    const text = renderOverride(model, [{ label: 'frontend', service: 'web', port: 5173, path: '/' }], [41003], '0.0.0.0', { web: { NEXT_PUBLIC_API_URL: 'http://h:41004' }, worker: { A: 'b' } })
    expect(text).toContain('"web":\n    ports: !override\n      - "0.0.0.0:41003:5173"\n    environment:\n      NEXT_PUBLIC_API_URL: "http://h:41004"')
    expect(text).toContain('"worker":\n    environment:\n      A: "b"')
  })
})
