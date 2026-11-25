import { afterEach, describe, expect, it } from 'vitest';
import { notePreviewPublicHost, noteServerBindHost, previewBindHost, previewPublicHost } from './bind.ts';

afterEach(() => {
  noteServerBindHost(undefined);
  notePreviewPublicHost('');
});

describe('preview bind + public host', () => {
  it('binds where the cockpit binds, unless CEZ_PREVIEW_BIND says otherwise', () => {
    expect(previewBindHost({})).toBe('127.0.0.1');
    noteServerBindHost('0.0.0.0');
    expect(previewBindHost({})).toBe('0.0.0.0');
    expect(previewBindHost({ CEZ_PREVIEW_BIND: '10.0.0.5' })).toBe('10.0.0.5');
  });

  it('a loopback preview is localhost, whatever the browser used', () => {
    notePreviewPublicHost('my-server');
    expect(previewPublicHost({})).toBe('localhost');
  });

  it('a network preview names the host the browser reached the cockpit on', () => {
    noteServerBindHost('0.0.0.0');
    notePreviewPublicHost('10.0.0.5');
    expect(previewPublicHost({})).toBe('10.0.0.5');
    expect(previewPublicHost({ CEZ_PREVIEW_HOST: 'preview.lan' })).toBe('preview.lan');
  });

  it('without a browser yet, a specific bind address, else the machine name', () => {
    expect(previewPublicHost({ CEZ_PREVIEW_BIND: '10.0.0.9' })).toBe('10.0.0.9');
    expect(previewPublicHost({ CEZ_PREVIEW_BIND: '0.0.0.0' })).toBeTruthy();
  });
});
