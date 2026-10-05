import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

const preparedCalls: Array<{ sources: readonly string[]; directory: string; sessionId: string; messageId: string }> = [];
let preparedResult: Map<string, { status: string; path?: string; outsideFileGrant?: string }> = new Map();
let urlResolverCalls = 0;
let grantFails = false;

mock.module('./markdownImageAssets', () => ({
  MAX_MARKDOWN_IMAGE_COUNT: 12,
  isLocalMarkdownImageSource: (source: string) => !/^(?:https?:)?\/\//i.test(source) && !/^data:/i.test(source),
  getPreparedMarkdownImageUrl: (image: { path: string; outsideFileGrant?: string }, directory: string) => {
    urlResolverCalls += 1;
    return `/api/fs/raw?path=${encodeURIComponent(image.path)}&directory=${encodeURIComponent(directory)}&grant=${image.outsideFileGrant ?? 'none'}`;
  },
  prepareLocalMarkdownImages: async (request: {
    sources: readonly string[];
    directory: string;
    sessionId: string;
    messageId: string;
  }) => {
    if (grantFails) throw new Error('server down');
    preparedCalls.push(request);
    return preparedResult as never;
  },
}));

mock.module('@/lib/runtime-auth', () => ({
  acquireRuntimeUrlAuthToken: () => () => {},
  refreshRuntimeUrlAuthToken: async () => {},
  subscribeRuntimeUrlAuthToken: () => () => {},
}));

// The hydrator builds its fallback label with the ambient `document`, so the
// happy-dom window has to be installed as the global before any test runs —
// assigning and restoring it inside the file body would restore it before bun
// executes the tests.
const win = new Window();
(globalThis as { document?: unknown }).document = win.document;

const { MarkdownInlineImageHydrator } = await import('./markdownInlineImages');

const buildRoot = (html: string): HTMLElement => {
  const root = win.document.createElement('div');
  root.innerHTML = html;
  return root as unknown as HTMLElement;
};

const IMAGE = '<img data-oc-md-image-source="screens/a.png" data-oc-md-image-filename="a.png" alt="a.png" class="markdown-inline-image">';

describe('MarkdownInlineImageHydrator', () => {
  beforeEach(() => {
    preparedCalls.length = 0;
    urlResolverCalls = 0;
    grantFails = false;
    preparedResult = new Map([['screens/a.png', { status: 'ready', path: '/repo/screens/a.png' }]]);
  });

  test('writes the granted asset URL onto the placeholder', async () => {
    const root = buildRoot(`<p>before</p>${IMAGE}`);
    const hydrator = new MarkdownInlineImageHydrator(root, {
      directory: '/repo',
      sessionId: 'ses_1',
      messageId: 'msg_1',
    });
    hydrator.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const image = root.querySelector('img');
    expect(preparedCalls).toHaveLength(1);
    expect(preparedCalls[0]).toMatchObject({ sources: ['screens/a.png'], directory: '/repo', sessionId: 'ses_1', messageId: 'msg_1' });
    expect(image?.getAttribute('src')).toBe('/api/fs/raw?path=%2Frepo%2Fscreens%2Fa.png&directory=%2Frepo&grant=none');
    expect(image?.getAttribute('data-oc-md-image-state')).toBe('loading');
    hydrator.dispose();
  });

  test('carries the outside-workspace grant rather than dropping it', async () => {
    preparedResult = new Map([['/tmp/opencode/shot.png', { status: 'ready', path: '/tmp/opencode/shot.png', outsideFileGrant: 'grant-token' }]]);
    const root = buildRoot('<img data-oc-md-image-source="/tmp/opencode/shot.png" data-oc-md-image-filename="shot.png">');
    const hydrator = new MarkdownInlineImageHydrator(root, { directory: '/repo', sessionId: 'ses_1', messageId: 'msg_1' });
    hydrator.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('img')?.getAttribute('src')).toContain('grant=grant-token');
    hydrator.dispose();
  });

  test('falls back to the filename label when the server refuses the file', async () => {
    preparedResult = new Map([['C:/secret.png', { status: 'missing' }]]);
    const root = buildRoot('<img data-oc-md-image-source="C:/secret.png" data-oc-md-image-filename="secret.png">');
    const hydrator = new MarkdownInlineImageHydrator(root, { directory: '/repo', sessionId: 'ses_1', messageId: 'msg_1' });
    hydrator.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // No img survives, and the label carries the filename the body showed before.
    expect(root.querySelector('img')).toBeNull();
    const label = root.querySelector('[data-openchamber-markdown-image-label="true"]');
    expect(label?.textContent).toContain('secret.png');
    expect(urlResolverCalls).toBe(0);
    hydrator.dispose();
  });

  test('falls back when the grant request itself fails', async () => {
    grantFails = true;
    const root = buildRoot(IMAGE);
    const hydrator = new MarkdownInlineImageHydrator(root, { directory: '/repo', sessionId: 'ses_1', messageId: 'msg_1' });
    hydrator.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    grantFails = false;

    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('[data-openchamber-markdown-image-label="true"]')?.textContent).toContain('a.png');
    hydrator.dispose();
  });

  test('does nothing when the message has no image', async () => {
    const root = buildRoot('<p>plain prose</p>');
    const hydrator = new MarkdownInlineImageHydrator(root, { directory: '/repo', sessionId: 'ses_1', messageId: 'msg_1' });
    hydrator.start();
    await Promise.resolve();
    expect(preparedCalls).toHaveLength(0);
    hydrator.dispose();
  });

  test('never asks for a remote source', async () => {
    const root = buildRoot('<img data-oc-md-image-source="https://evil.example/p.png" data-oc-md-image-filename="p.png">');
    const hydrator = new MarkdownInlineImageHydrator(root, { directory: '/repo', sessionId: 'ses_1', messageId: 'msg_1' });
    hydrator.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(preparedCalls).toHaveLength(0);
    expect(urlResolverCalls).toBe(0);
    hydrator.dispose();
  });

  test('dispose stops a pending write from touching the DOM', async () => {
    const root = buildRoot(IMAGE);
    const hydrator = new MarkdownInlineImageHydrator(root, { directory: '/repo', sessionId: 'ses_1', messageId: 'msg_1' });
    hydrator.start();
    hydrator.dispose();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('img')?.getAttribute('src')).toBeNull();
  });
});