import React from 'react';
import { toast } from 'sonner';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import {
  acquireRuntimeUrlAuthToken,
  refreshRuntimeUrlAuthToken,
  subscribeRuntimeUrlAuthToken,
} from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { ToolPopupContent } from './message/types';
import {
  extractMarkdownImageCandidates,
  isRemoteMarkdownImageSource,
  MAX_MARKDOWN_IMAGE_COUNT,
  type MarkdownImageCandidate,
} from './markdown/markdownCore';
import {
  getPreparedMarkdownImageUrl,
  isLocalMarkdownImageSource,
  prepareLocalMarkdownImages,
  resolveMarkdownImageSource,
  resolveWorkspaceMarkdownImageSource,
  type PreparedMarkdownImage,
} from './markdown/markdownImageAssets';

const useAssetAuth = (enabled: boolean): { ready: boolean; nonce: number } => {
  const [ready, setReady] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const apiBaseUrl = getRuntimeApiBaseUrl();

  React.useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const release = acquireRuntimeUrlAuthToken(apiBaseUrl);
    const unsubscribe = subscribeRuntimeUrlAuthToken(() => {
      if (!cancelled) setNonce((current) => current + 1);
    });
    const refresh = () => {
      void refreshRuntimeUrlAuthToken(apiBaseUrl)
        .then(() => {
          if (!cancelled) setReady(true);
        })
        .catch(() => {
          if (!cancelled) retryTimer = setTimeout(refresh, 1000);
        });
    };
    refresh();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      release();
      unsubscribe();
    };
  }, [apiBaseUrl, enabled]);

  return { ready: !enabled || ready, nonce };
};

const MarkdownImageThumbnail: React.FC<{
  candidate: MarkdownImageCandidate;
  preparation?: PreparedMarkdownImage;
  directory: string;
  assetAuthReady: boolean;
  assetAuthNonce: number;
  useWorkspaceFsBridge: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
}> = ({
  candidate,
  preparation,
  directory,
  assetAuthReady,
  assetAuthNonce,
  useWorkspaceFsBridge,
  onShowPopup,
}) => {
  const { t } = useI18n();
  const entryRef = React.useRef<HTMLButtonElement>(null);
  const [shouldLoad, setShouldLoad] = React.useState(false);
  const [image, setImage] = React.useState<{ url: string; status: 'loading' | 'ready' | 'error' }>({
    url: '',
    status: 'loading',
  });
  const local = isLocalMarkdownImageSource(candidate.source);

  React.useEffect(() => {
    const entry = entryRef.current;
    if (!entry || shouldLoad) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry_) => entry_.isIntersecting)) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { rootMargin: '200px' });
    observer.observe(entry);
    return () => observer.disconnect();
  }, [shouldLoad]);

  // The entry draws no thumbnail, so it cannot learn readiness from an `img`
  // load event. A resolved, granted URL is what "ready" now means; the preview
  // overlay reports its own failure if the bytes do not decode. That also means
  // a broken image costs one click instead of a silent placeholder forever.
  React.useEffect(() => {
    if (!shouldLoad || (local && !useWorkspaceFsBridge && !preparation)) return;
    if (local && useWorkspaceFsBridge) {
      const controller = new AbortController();
      setImage({ url: '', status: 'loading' });
      void resolveWorkspaceMarkdownImageSource(candidate.source, directory, controller.signal).then((url) => {
        if (controller.signal.aborted) return;
        setImage({ url, status: 'ready' });
      }).catch(() => {
        if (controller.signal.aborted) return;
        setImage({ url: '', status: 'error' });
      });
      return () => controller.abort();
    }
    if (local) {
      if (preparation?.status !== 'ready') {
        setImage({ url: '', status: 'error' });
        return;
      }
      if (!assetAuthReady) return;
      setImage({ url: getPreparedMarkdownImageUrl(preparation, directory), status: 'ready' });
      return;
    }
    const controller = new AbortController();
    setImage({ url: '', status: 'loading' });
    void resolveMarkdownImageSource(candidate.source, controller.signal).then((url) => {
      if (controller.signal.aborted) return;
      setImage({ url, status: 'ready' });
    }).catch(() => {
      if (controller.signal.aborted) return;
      setImage({ url: '', status: 'error' });
    });
    return () => controller.abort();
  }, [assetAuthNonce, assetAuthReady, candidate.source, directory, local, preparation, shouldLoad, useWorkspaceFsBridge]);

  const openPreview = React.useCallback(() => {
    if (image.status === 'error') {
      toast.error(t('filesView.error.previewUnavailable'));
      return;
    }
    if (image.status !== 'ready' || !onShowPopup) return;
    onShowPopup({
      open: true,
      title: candidate.filename,
      content: '',
      metadata: { tool: 'markdown-image-preview', filename: candidate.filename },
      image: { url: image.url, filename: candidate.filename },
    });
  }, [candidate.filename, image, onShowPopup, t]);

  return (
    <button
      ref={entryRef}
      type="button"
      className="max-w-[220px] truncate rounded-md px-1.5 py-0.5 text-left text-muted-foreground underline decoration-dotted underline-offset-2 outline-none transition-colors hover:bg-interactive-hover/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
      aria-label={candidate.filename}
      title={candidate.filename}
      disabled={image.status === 'loading'}
      onClick={openPreview}
      data-openchamber-markdown-image-action="true"
      data-openchamber-markdown-image-source={candidate.source}
      data-openchamber-markdown-image-filename={candidate.filename}
    >
      <span className="typography-meta">{candidate.filename}</span>
    </button>
  );
};

export const MarkdownImageGallery: React.FC<{
  sessionId?: string;
  messageId: string;
  contents: readonly string[];
  onShowPopup?: (content: ToolPopupContent) => void;
}> = ({ sessionId, messageId, contents, onShowPopup }) => {
  const directory = useEffectiveDirectory() ?? '';
  const galleryRef = React.useRef<HTMLDivElement>(null);
  const [shouldPrepare, setShouldPrepare] = React.useState(false);
  const [prepared, setPrepared] = React.useState<Map<string, PreparedMarkdownImage> | null>(null);
  const [prepareEpoch, setPrepareEpoch] = React.useState(0);
  const useWorkspaceFsBridge = isVSCodeRuntime();
  // Only images on this machine or inside the message. A remote image would
  // load by itself as the thumbnail scrolls into view and tell its server what
  // the user is reading; in the text it is a link to open on purpose.
  const candidates = React.useMemo(
    () => extractMarkdownImageCandidates(contents, MAX_MARKDOWN_IMAGE_COUNT)
      .filter((candidate) => !isRemoteMarkdownImageSource(candidate.source)),
    [contents],
  );
  const serverPreparationSources = React.useMemo(
    () => useWorkspaceFsBridge
      ? []
      : candidates
        .filter((candidate) => isLocalMarkdownImageSource(candidate.source))
        .map((candidate) => candidate.source),
    [candidates, useWorkspaceFsBridge],
  );
  React.useEffect(() => {
    if (serverPreparationSources.length === 0 || shouldPrepare) return;
    const gallery = galleryRef.current;
    if (!gallery || typeof IntersectionObserver === 'undefined') {
      setShouldPrepare(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldPrepare(true);
      observer.disconnect();
    }, { rootMargin: '200px' });
    observer.observe(gallery);
    return () => observer.disconnect();
  }, [serverPreparationSources.length, shouldPrepare]);

  React.useEffect(() => {
    if (!shouldPrepare || !sessionId || serverPreparationSources.length === 0) return;
    const controller = new AbortController();
    void prepareLocalMarkdownImages({
      sources: serverPreparationSources,
      directory,
      sessionId,
      messageId,
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setPrepared(result);
    }).catch(() => {
      if (!controller.signal.aborted) {
        setPrepared(new Map(serverPreparationSources.map((source) => [source, { status: 'error' }])));
      }
    });
    return () => controller.abort();
  }, [directory, messageId, prepareEpoch, serverPreparationSources, sessionId, shouldPrepare]);

  React.useEffect(() => {
    const nextExpiry = Math.min(...[...(prepared?.values() ?? [])]
      .filter((value): value is Extract<PreparedMarkdownImage, { status: 'ready' }> => value.status === 'ready')
      .map((value) => value.expiresAt ?? Number.POSITIVE_INFINITY));
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => setPrepareEpoch((current) => current + 1), Math.max(0, nextExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [prepared]);

  const visibleCandidates = candidates.filter((candidate) => prepared?.get(candidate.source)?.status !== 'missing');
  const hasPreparedAssets = [...(prepared?.values() ?? [])].some((value) => value.status === 'ready');
  const assetAuth = useAssetAuth(hasPreparedAssets);
  if (visibleCandidates.length === 0) return null;

  return (
    // Text entries, not thumbnails: an assistant message that draws its images in
// place would otherwise show every one of them twice, 100px wide, under the
// answer. The row stays the single place that lists what the message
// references, and a click still opens the existing preview overlay.
<div
      ref={galleryRef}
      className="mt-3 flex max-w-full flex-wrap items-center gap-x-3 gap-y-1"
      data-openchamber-markdown-image-gallery="true"
    >
      {visibleCandidates.map((candidate) => (
        <MarkdownImageThumbnail
          key={candidate.source}
          candidate={candidate}
          preparation={prepared?.get(candidate.source)}
          directory={directory}
          assetAuthReady={assetAuth.ready}
          assetAuthNonce={assetAuth.nonce}
          useWorkspaceFsBridge={useWorkspaceFsBridge}
          onShowPopup={onShowPopup}
        />
      ))}
    </div>
  );
};
