import {
  getPreparedMarkdownImageUrl,
  isLocalMarkdownImageSource,
  MAX_MARKDOWN_IMAGE_COUNT,
  prepareLocalMarkdownImages,
  type PreparedMarkdownImage,
} from './markdownImageAssets';
import { acquireRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, subscribeRuntimeUrlAuthToken } from '@/lib/runtime-auth';

const SOURCE_ATTR = 'data-oc-md-image-source';
const FILENAME_ATTR = 'data-oc-md-image-filename';
const STATE_ATTR = 'data-oc-md-image-state';

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The label an ungranted local image falls back to, matching what `label` mode
// renders: the shared icon plus the filename, never the path.
const renderFilenameLabel = (filename: string): HTMLElement => {
  const label = document.createElement('span');
  label.className = 'inline-flex items-center gap-1 align-text-bottom text-muted-foreground';
  label.setAttribute('data-openchamber-markdown-image-label', 'true');
  label.textContent = filename;
  return label;
};

type ImageState = { url: string; status: 'loading' | 'ready' | 'error' };

/**
 * Fills `src` on the local images the assistant renderer emitted, using the
 * same grant path as the gallery: the server reads the exact source out of the
 * owning message and mints an authenticated asset URL, so a path outside the
 * workspace and outside OpenCode's temporary directory never becomes a
 * readable request. An image that cannot be granted goes back to the filename
 * label the body showed before, which is why a failed load looks like the
 * existing behavior rather than a broken image.
 */
export class MarkdownInlineImageHydrator {
  private readonly root: HTMLElement;
  private readonly directory: string;
  private readonly sessionId: string;
  private readonly messageId: string;
  private readonly states = new Map<string, ImageState>();
  private readonly abort = new AbortController();
  private releaseToken: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(root: HTMLElement, {
    directory,
    sessionId,
    messageId,
  }: {
    directory: string;
    sessionId: string;
    messageId: string;
  }) {
    this.root = root;
    this.directory = directory;
    this.sessionId = sessionId;
    this.messageId = messageId;
  }

  /** Every placeholder image still waiting for a `src`, bounded like the gallery. */
  private pending(): HTMLImageElement[] {
    return Array.from(this.root.querySelectorAll<HTMLImageElement>(`img[${SOURCE_ATTR}]`))
      .filter((image) => !image.getAttribute('src') && this.states.get(this.sourceOf(image))?.status !== 'error')
      .slice(0, MAX_MARKDOWN_IMAGE_COUNT);
  }

  private sourceOf(image: HTMLImageElement): string {
    return image.getAttribute(SOURCE_ATTR) ?? '';
  }

  private apply(image: HTMLImageElement, state: ImageState): void {
    if (this.disposed) return;
    const source = this.sourceOf(image);
    const current = this.states.get(source);
    if (current?.status === state.status && current?.url === state.url) return;
    this.states.set(source, state);

    if (state.status === 'error') {
      image.replaceWith(renderFilenameLabel(image.getAttribute(FILENAME_ATTR) ?? 'image'));
      return;
    }
    image.setAttribute(STATE_ATTR, state.status);
    if (image.getAttribute('src') !== state.url) image.setAttribute('src', state.url);
  }

  private fallbackAll(): void {
    for (const image of this.pending()) {
      this.apply(image, { url: '', status: 'error' });
    }
  }

  private async load(): Promise<void> {
    const images = this.pending();
    if (images.length === 0) return;

    const sources = [...new Set(images.map((image) => this.sourceOf(image)))]
      .filter((source) => isLocalMarkdownImageSource(source));
    if (sources.length === 0) {
      this.fallbackAll();
      return;
    }

    let prepared: Map<string, PreparedMarkdownImage>;
    try {
      prepared = await prepareLocalMarkdownImages({
        sources,
        directory: this.directory,
        sessionId: this.sessionId,
        messageId: this.messageId,
        signal: this.abort.signal,
      });
    } catch {
      this.fallbackAll();
      return;
    }
    if (this.disposed || this.abort.signal.aborted) return;

    const ready = [...prepared.values()].some((value) => value.status === 'ready');
    if (!ready) {
      this.fallbackAll();
      return;
    }

    // The asset route needs the URL auth token; wait for it before writing any
    // `src`, or the first load would 401 and fall back for no reason.
    try {
      this.releaseToken = acquireRuntimeUrlAuthToken('');
      this.unsubscribe = subscribeRuntimeUrlAuthToken(() => {
        void this.write(prepared);
      });
      await refreshRuntimeUrlAuthToken('');
    } catch {
      this.fallbackAll();
      return;
    }
    if (this.disposed) return;
    await this.write(prepared);
  }

  private write(prepared: Map<string, PreparedMarkdownImage>): void {
    for (const image of this.pending()) {
      const result = prepared.get(this.sourceOf(image));
      if (!result || result.status !== 'ready') {
        this.apply(image, { url: '', status: 'error' });
        continue;
      }
      try {
        this.apply(image, {
          url: getPreparedMarkdownImageUrl(result, this.directory),
          status: 'loading',
        });
      } catch {
        this.apply(image, { url: '', status: 'error' });
      }
    }
  }

  start(): void {
    void this.load();
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.unsubscribe?.();
    this.releaseToken?.();
  }
}

export const MARKDOWN_INLINE_IMAGE_ATTRS = { SOURCE_ATTR, FILENAME_ATTR, STATE_ATTR };

/** Test seam: the attribute names the hydrator reads and writes. */
export const __markdownInlineImageAttrsForTests = {
  source: SOURCE_ATTR,
  filename: FILENAME_ATTR,
  state: STATE_ATTR,
  escapeAttr,
};