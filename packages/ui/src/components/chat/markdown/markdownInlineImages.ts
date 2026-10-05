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

const PLACEHOLDER_SELECTOR = `img[${SOURCE_ATTR}]`;

// The label an ungranted local image falls back to, matching what `label` mode
// renders: the shared icon plus the filename, never the path.
const renderFilenameLabel = (filename: string): HTMLElement => {
  const label = document.createElement('span');
  label.className = 'inline-flex items-center gap-1 align-text-bottom text-muted-foreground';
  label.setAttribute('data-openchamber-markdown-image-label', 'true');
  label.textContent = filename;
  return label;
};

type Grant = { url: string; expiresAt: number };

export type InlineImagePreview = { url: string; filename: string };

/**
 * Fills `src` on the local images the assistant renderer emitted, using the same
 * grant path as the gallery: the server reads the exact source out of the
 * owning message and mints an authenticated asset URL, so a path outside the
 * workspace and outside OpenCode's temporary directory never becomes a
 * readable request. An image that cannot be granted goes back to the filename
 * label the body showed before, which is why a failed load looks like the
 * existing behavior rather than a broken image.
 *
 * Hydration has to survive the renderer re-writing the same HTML underneath
 * it. A settled block is painted synchronously first and then morphed once the
 * async parse resolves, and morphdom drops any attribute the incoming HTML does
 * not carry - so a `src` written a moment earlier is removed again, and a
 * theme or locale change replaces the block outright. Both leave a placeholder
 * with no `src`, and nothing else would ever put it back. So this watches the
 * container and re-asserts from the grant it already holds, rather than
 * assuming its own write was the last one.
 */
export class MarkdownInlineImageHydrator {
  private readonly root: HTMLElement;
  private readonly directory: string;
  private readonly sessionId: string;
  private readonly messageId: string;
  private readonly grants = new Map<string, Grant>();
  private readonly settled = new WeakSet<Element>();
  private readonly abort = new AbortController();
  private observer: MutationObserver | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseToken: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private preparing: Promise<void> | null = null;

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

  private sourceOf(image: Element): string {
    return image.getAttribute(SOURCE_ATTR) ?? '';
  }

  /**
   * Placeholders that still need a `src`. Every one of them ends up either
   * drawn or replaced by a label, so an image the cap excludes cannot leak as
   * an empty box.
   */
  private pending(): HTMLImageElement[] {
    return Array.from(this.root.querySelectorAll<HTMLImageElement>(PLACEHOLDER_SELECTOR))
      .filter((image) => !this.settled.has(image) && !image.getAttribute('src'));
  }

  private applyFallback(image: HTMLImageElement): void {
    if (this.disposed || this.settled.has(image)) return;
    this.settled.add(image);
    image.replaceWith(renderFilenameLabel(image.getAttribute(FILENAME_ATTR) ?? 'image'));
  }

  /** Write what we already know. Safe to call on every mutation. */
  private write(): void {
    if (this.disposed) return;
    for (const image of this.pending()) {
      const grant = this.grants.get(this.sourceOf(image));
      if (!grant) continue;
      // An expired grant would 401 and drop the image; re-prepare instead.
      if (grant.expiresAt <= Date.now()) {
        this.grants.delete(this.sourceOf(image));
        this.settled.delete(image);
        void this.prepare();
        return;
      }
      this.settled.add(image);
      image.setAttribute(STATE_ATTR, 'loading');
      if (image.getAttribute('src') !== grant.url) image.setAttribute('src', grant.url);
    }
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    const expiries = [...this.grants.values()].map((grant) => grant.expiresAt);
    if (expiries.length === 0) return;
    const soonest = Math.min(...expiries);
    if (!Number.isFinite(soonest)) return;
    this.expiryTimer = setTimeout(() => {
      this.grants.clear();
      void this.prepare();
    }, Math.max(0, soonest - Date.now()));
  }

  private async prepare(): Promise<void> {
    if (this.disposed || this.preparing) return this.preparing ?? undefined;
    const sources = [...new Set(Array.from(this.root.querySelectorAll(PLACEHOLDER_SELECTOR))
      .map((image) => this.sourceOf(image))
      .filter((source) => isLocalMarkdownImageSource(source)))]
      .slice(0, MAX_MARKDOWN_IMAGE_COUNT);
    if (sources.length === 0) {
      this.failAllPending();
      return undefined;
    }

    this.preparing = (async () => {
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
        this.failAllPending();
        return;
      }
      if (this.disposed || this.abort.signal.aborted) return;

      const ready = [...prepared.values()].filter(
        (value): value is Extract<PreparedMarkdownImage, { status: 'ready' }> => value.status === 'ready',
      );
      if (ready.length === 0) {
        this.failAllPending();
        return;
      }

      try {
        this.releaseToken = acquireRuntimeUrlAuthToken('');
        this.unsubscribe = subscribeRuntimeUrlAuthToken(() => this.write());
        await refreshRuntimeUrlAuthToken('');
      } catch {
        this.failAllPending();
        return;
      }
      if (this.disposed) return;

      // The grant route answers per *source* in request order, while the asset
      // URL is built from a path. Pair them by position, which is the order we
      // asked in.
      this.grants.clear();
      ready.forEach((image, index) => {
        const source = sources[index];
        if (!source) return;
        try {
          this.grants.set(source, {
            url: getPreparedMarkdownImageUrl(image, this.directory),
            expiresAt: image.expiresAt ?? Number.POSITIVE_INFINITY,
          });
        } catch {
          // Fall through to the label.
        }
      });

      this.write();
      // Anything still pending now has no grant: it was refused, its format or
      // size was out of bounds, or it fell past the per-message cap. Leaving it
      // src-less is the one outcome this feature must never produce, so it
      // becomes its label like any other ungranted image. A placeholder that
      // arrives later re-enters through the observer and is prepared then.
      this.failAllPending();
      this.scheduleExpiry();
    })();

    try {
      await this.preparing;
    } finally {
      this.preparing = null;
    }
    return undefined;
  }

  /**
   * Nothing can be drawn, so every placeholder becomes its label. This is the
   * promise the fallback exists to keep: no empty box survives, whether the
   * grant was refused, the request failed, or the cap excluded the image.
   */
  private failAllPending(): void {
    for (const image of this.pending()) this.applyFallback(image);
  }

  private observe(): void {
    if (this.observer || typeof MutationObserver === 'undefined') return;
    this.observer = new MutationObserver(() => {
      // A re-morph or a theme swap brings fresh, src-less placeholders. The
      // grants are still held, so re-assert rather than ask the server again.
      const pending = this.pending();
      if (pending.length === 0) return;
      const unknown = pending.some((image) => !this.grants.has(this.sourceOf(image)));
      if (unknown) void this.prepare();
      else this.write();
    });
    this.observer.observe(this.root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  }

  start(): void {
    this.observe();
    void this.prepare();
    this.write();
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.observer?.disconnect();
    this.observer = null;
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.unsubscribe?.();
    this.releaseToken?.();
  }
}

export const MARKDOWN_INLINE_IMAGE_ATTRS = { SOURCE_ATTR, FILENAME_ATTR, STATE_ATTR };

/**
 * The images of one message that actually drew, in document order, so a click
 * can open the shared preview overlay with the whole set. The overlay already
 * draws arrows and binds the arrow keys for a gallery, so this hands it the
 * list and the clicked index rather than reimplementing navigation.
 *
 * Only images with a `src` are included: an ungranted one was replaced by its
 * filename label and has nothing to open.
 */
export const collectInlineImagePreviews = (root: HTMLElement): InlineImagePreview[] => {
  const previews: InlineImagePreview[] = [];
  for (const image of root.querySelectorAll<HTMLImageElement>(PLACEHOLDER_SELECTOR)) {
    const url = image.getAttribute('src');
    if (!url) continue;
    previews.push({ url, filename: image.getAttribute(FILENAME_ATTR) ?? 'image' });
  }
  return previews;
};

/** Test seam: the attribute names the hydrator reads and writes. */
export const __markdownInlineImageAttrsForTests = {
  source: SOURCE_ATTR,
  filename: FILENAME_ATTR,
  state: STATE_ATTR,
};