import { type App, type FrontMatterCache } from 'obsidian';
import React, {
  forwardRef, useCallback, useEffect, useRef, useState, useImperativeHandle, useMemo,
} from 'react';
import { type WatermarkProps, Watermark } from '@pansy/react-watermark';
import Metadata from './Metadata';
import clsx from 'clsx';
import { getRemoteImageUrl } from 'src/utils/capture';
import { calculateSplitLines, getElementMeasures, getSafeBreakPoints, snapBreakPosition } from 'src/utils/split';

const lowerCase = (s: string) => s.replace(/([A-Z])/g, ' $1').toLowerCase().trim();

const alignMap = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
};

function getFrontmatterClasses(frontmatter: FrontMatterCache | undefined): string[] {
  const fields: Record<string, unknown> | undefined = frontmatter;
  const value = fields?.cssclasses ?? fields?.cssclass;
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

export interface TargetRef {
  element: HTMLElement;
  contentElement: HTMLElement;
  setClip: (startY: number, height: number) => void;
  resetClip: () => void;
}

const Target = forwardRef<
  TargetRef,
  {
    frontmatter: FrontMatterCache | undefined;
    setting: ISettings;
    title: string;
    metadataMap: Record<string, { type: MetadataType }>;
    markdownEl: Node;
    app: App;
    scale?: number;
    isProcessing: boolean;
    onSplitChange?: (positions: number[]) => void;
    manualBreaks?: number[];
    pageBreakEditing?: boolean;
    onManualBreaksChange?: (positions: number[]) => void;
    onReady?: () => void;
  }
>(({ frontmatter, setting, title, metadataMap, markdownEl, scale = 1, isProcessing, onSplitChange, manualBreaks = [], pageBreakEditing = false, onManualBreaksChange, onReady }, ref) => {
  const [watermarkProps, setWatermarkProps] = useState<WatermarkProps>({});
  const [contentReady, setContentReady] = useState(false);
  const [watermarkReady, setWatermarkReady] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const [rootHeight, setRootHeight] = useState(0);
  const includesBanner = markdownEl.instanceOf(Element)
    && markdownEl.querySelector('.obsidian-banner-wrapper') !== null;

  useEffect(() => {
    if (!rootRef.current) return;
    const observer = new ResizeObserver(() => {
      if (rootRef.current) {
        setRootHeight(rootRef.current.clientHeight);
      }
    });
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, []);

  const splitLines = useMemo(() => {
    if (!rootHeight || setting.split.mode === 'none') return [];

    let elements;
    if (rootRef.current) {
      const measureMode = setting.format === 'pdf' && setting.split.mode === 'fixed'
        ? 'auto'
        : setting.split.mode;
      elements = getElementMeasures(rootRef.current, measureMode);
    }

    return calculateSplitLines({
      mode: setting.split.mode,
      height: setting.split.height,
      overlap: setting.split.overlap,
      totalHeight: rootHeight,
      preserveBlocks: setting.format === 'pdf',
    }, elements, manualBreaks.length ? manualBreaks : undefined);
  }, [manualBreaks, setting.format, setting.split.height, setting.split.overlap, setting.split.mode, rootHeight]);

  const safeBreakPoints = useMemo(() => {
    if (!rootRef.current || !rootHeight) return [];
    const measureMode: SplitMode = setting.split.mode === 'hr' || setting.split.mode === 'fixed' ? 'auto' : setting.split.mode;
    const elements = getElementMeasures(rootRef.current, measureMode);
    return getSafeBreakPoints(rootHeight, elements);
  }, [rootHeight, setting.split.mode]);

  useEffect(() => {
    onSplitChange?.(splitLines);
  }, [onSplitChange, splitLines]);

  const moveManualBreak = useCallback((index: number, clientY: number) => {
    if (!rootRef.current || !onManualBreaksChange) return;
    const rect = rootRef.current.getBoundingClientRect();
    const contentY = (clientY - rect.top) / Math.max(scale, 0.01);
    const current = manualBreaks[index];
    if (current === undefined) return;
    const previous = index > 0 ? manualBreaks[index - 1]! : 0;
    const next = index < manualBreaks.length - 1 ? manualBreaks[index + 1]! : rootHeight;
    const snapped = snapBreakPosition(contentY, safeBreakPoints, previous, next);
    const nextBreaks = [...manualBreaks];
    nextBreaks[index] = snapped;
    nextBreaks.sort((a, b) => a - b);
    onManualBreaksChange(nextBreaks);
  }, [manualBreaks, onManualBreaksChange, rootHeight, safeBreakPoints, scale]);

  const handleBreakPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, index: number) => {
    if (!pageBreakEditing || !onManualBreaksChange) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => moveManualBreak(index, moveEvent.clientY);
    const up = () => {
      event.currentTarget.releasePointerCapture(event.pointerId);
      event.currentTarget.removeEventListener('pointermove', move as EventListener);
      event.currentTarget.removeEventListener('pointerup', up as EventListener);
    };
    event.currentTarget.addEventListener('pointermove', move as EventListener);
    event.currentTarget.addEventListener('pointerup', up as EventListener);
  }, [moveManualBreak, onManualBreaksChange, pageBreakEditing]);

  const removeManualBreak = useCallback((index: number) => {
    if (!onManualBreaksChange) return;
    onManualBreaksChange(manualBreaks.filter((_, currentIndex) => currentIndex !== index));
  }, [manualBreaks, onManualBreaksChange]);

  useEffect(() => {
    if (!contentRef.current) {
      return;
    }
    setContentReady(false);
    contentRef.current.empty();
    Array.from(markdownEl.childNodes).forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent) {
          contentRef.current?.append(child.textContent);
        }
      } else {
        contentRef.current?.append(child.cloneNode(true));
      }
    });
    setContentReady(true);
  }, [markdownEl]);

  useImperativeHandle(ref, () => ({
    element: clipRef.current!,
    contentElement: rootRef.current!,
    setClip: (startY: number, height: number) => {
      if (!clipRef.current || !rootRef.current) return;
      clipRef.current.setCssStyles({
        height: `${height}px`,
        overflow: 'hidden',
      });
      rootRef.current.setCssStyles({
        transform: `translateY(-${startY}px)`,
      });
    },
    resetClip: () => {
      if (!clipRef.current || !rootRef.current) return;
      clipRef.current.setCssStyles({
        height: '',
        overflow: '',
      });
      rootRef.current.setCssStyles({
        transform: '',
      });
    }
  }), []);

  useEffect(() => {
    let cancelled = false;
    setWatermarkReady(false);

    void (async () => {
      const props: WatermarkProps = {
        monitor: false,
        mode: 'interval',
        visible: setting.watermark.enable,
        rotate: setting.watermark.rotate ?? -30,
        opacity: setting.watermark.opacity ?? 0.2,
        height: setting.watermark.height ?? 64,
        width: setting.watermark.width ?? 120,
        gapX: setting.watermark.x ?? 100,
        gapY: setting.watermark.y ?? 100,
      };

      if (setting.watermark.type === 'text') {
        props.text = setting.watermark.text.content;
        props.fontSize = setting.watermark.text.fontSize || 16;
        props.fontFamily = setting.watermark.text.fontFamily;
        props.fontColor = setting.watermark.text.color || '#cccccc';
        props.image = undefined;
      } else {
        props.image = await getRemoteImageUrl(setting.watermark.image.src);
      }

      if (!cancelled) {
        setWatermarkProps(props);
        setWatermarkReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    setting.watermark.enable,
    setting.watermark.rotate,
    setting.watermark.opacity,
    setting.watermark.height,
    setting.watermark.width,
    setting.watermark.x,
    setting.watermark.y,
    setting.watermark.type,
    setting.watermark.text.content,
    setting.watermark.text.fontSize,
    setting.watermark.text.fontFamily,
    setting.watermark.text.color,
    setting.watermark.image.src,
  ]);

  useEffect(() => {
    if (!contentReady || !watermarkReady) {
      return;
    }
    let secondRafId: number | undefined;
    const rafId = window.requestAnimationFrame(() => {
      secondRafId = window.requestAnimationFrame(() => {
        onReady?.();
      });
    });
    return () => {
      window.cancelAnimationFrame(rafId);
      if (secondRafId !== undefined) {
        window.cancelAnimationFrame(secondRafId);
      }
    };
  }, [contentReady, onReady, watermarkReady]);

  return (
    <div ref={clipRef}>
      <div
        className={clsx('export-image-root markdown-reading-view', getFrontmatterClasses(frontmatter))}
        ref={rootRef}
        style={{
          display: 'flex',
          flexDirection:
            setting.authorInfo.position === 'bottom'
              ? 'column'
              : 'column-reverse',
          backgroundColor:
            setting.format === 'png1' ? 'unset' : 'var(--background-primary)',
          position: 'relative',
        }}
      >
        {!isProcessing && splitLines.map((line, index) => (
          <div
            key={`${index}-${Math.round(line)}`}
            className={clsx('export-image-page-break', pageBreakEditing && 'is-editing')}
            style={{ top: `${line}px` }}
            role='separator'
            aria-label={`Page break ${index + 1}`}
            onPointerDown={event => handleBreakPointerDown(event, index)}
            onDoubleClick={() => pageBreakEditing && removeManualBreak(index)}
            tabIndex={pageBreakEditing ? 0 : -1}
            onKeyDown={event => {
              if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                removeManualBreak(index);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                moveManualBreak(index, (rootRef.current?.getBoundingClientRect().top ?? 0) + line * Math.max(scale, 0.01) - 10 * Math.max(scale, 0.01));
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveManualBreak(index, (rootRef.current?.getBoundingClientRect().top ?? 0) + line * Math.max(scale, 0.01) + 10 * Math.max(scale, 0.01));
              }
            }}
          >
            {pageBreakEditing && <span className='export-image-page-break-handle'>Page {index + 2}</span>}
          </div>
        ))}
        <Watermark {...watermarkProps}>
          <div
            className={clsx(
              'markdown-preview-view markdown-rendered export-image-preview-container',
              includesBanner && 'export-image-preview-has-banner',
            )}
            style={{
              width: `${setting.width}px`,
              transition: 'width 0.25s',
              padding: `${setting.padding.top}px ${setting.padding.right}px ${setting.padding.bottom}px ${setting.padding.left}px`,
            }}
          >
            {setting.showFilename && (
              <div className='inline-title' autoCapitalize='on'>
                {title}
              </div>
            )}
            {setting.showMetadata
              && frontmatter
              && Object.keys(frontmatter).length > 0 && (
                <div className='metadata-container' style={{ display: 'block' }}>
                  <div className='metadata-content'>
                    {Object.keys(frontmatter).map(name => (
                      <Metadata
                        name={name}
                        key={name}
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                        value={frontmatter[name]}
                        type={metadataMap[lowerCase(name)]?.type || 'text'}
                      ></Metadata>
                    ))}
                  </div>
                </div>
              )}
            <div ref={contentRef} className={`export-image-split-${setting.split.mode} export-image-markdown`}></div>
          </div>
        </Watermark>
        {setting.authorInfo.show
          && (setting.authorInfo.avatar || setting.authorInfo.name) && (
            <div
              className='user-info-container'
              style={{
                [setting.authorInfo.position === 'top'
                  ? 'borderBottom'
                  : 'borderTop']: '1px solid var(--background-modifier-border)',

                justifyContent: alignMap[setting.authorInfo.align || 'right'],
                background:
                  setting.format === 'png1'
                    ? 'unset'
                    : 'var(--background-primary)',
              }}
            >
              {setting.authorInfo.avatar && (
                <div
                  className='user-info-avatar'
                  style={{
                    backgroundImage: `url(${setting.authorInfo.avatar})`,
                  }}
                ></div>
              )}
              {setting.authorInfo.name && (
                <div>
                  <div className='user-info-name'>{setting.authorInfo.name}</div>
                  {setting.authorInfo.remark && (
                    <div className='user-info-remark'>
                      {setting.authorInfo.remark}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        }
      </div>
    </div>
  );
});

export default Target;
