import JsPdf from 'jspdf';
import * as htmlToImage from 'html-to-image';
import { embedInvisibleAssetMark } from './invisibleAssetMark';

const PDF_PDF_DPI_REFERENCE = 96;
const PDF_MAX_RASTER_WIDTH = 2400;
const PDF_JPEG_QUALITY = 0.70;
const PDF_PAGE_IMAGE_LIMIT = 300 * 1024;
const PDF_MIN_JPEG_QUALITY = 0.35;
const PDF_MIN_RASTER_WIDTH = 480;
const SIMPLE_TEXT_MAX_LENGTH = 3000;

export interface PdfPagePosition {
  startY: number;
  height: number;
}

interface PdfRenderPage {
  startY: number;
  contentHeight: number;
  pageHeight: number;
}

interface PdfOutlineApi {
  add: (parent: unknown, title: string, options: { pageNumber: number }) => unknown;
  root?: { children: unknown[] };
}

interface PdfWithExtras extends JsPdf {
  outline?: PdfOutlineApi;
  viewerPreferences?: (options: Record<string, unknown>, doReset?: boolean) => JsPdf;
}

function pdfWidthIn(cssWidth: number): number {
  return cssWidth / PDF_PDF_DPI_REFERENCE;
}

function pdfHeightIn(cssHeight: number): number {
  return cssHeight / PDF_PDF_DPI_REFERENCE;
}

function getDomScale(container: HTMLElement): { x: number; y: number } {
  const rect = container.getBoundingClientRect();
  return {
    x: rect.width > 0 && container.clientWidth > 0 ? rect.width / container.clientWidth : 1,
    y: rect.height > 0 && container.clientHeight > 0 ? rect.height / container.clientHeight : 1,
  };
}

function getPdfScale(cssWidth: number, resolutionMode: ResolutionMode): number {
  const requested = resolutionMode === '2x'
    ? 2
    : resolutionMode === '3x'
      ? 3
      : resolutionMode === '4x'
        ? 4
        : 1;
  const deviceRatio = window.devicePixelRatio || 1;
  const desired = Math.min(requested * deviceRatio, 4);
  return Math.min(desired, PDF_MAX_RASTER_WIDTH / Math.max(cssWidth, 1));
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error('Failed to encode PDF page image'));
        return;
      }
      resolve(blob);
    }, 'image/jpeg', quality);
  });
}

function createScaledCanvas(source: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = activeDocument.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to create PDF page canvas');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

/**
 * Encodes each PDF page as JPEG with the requested 70% quality first.
 * If the encoded image exceeds 300 KB, quality is reduced and finally the
 * raster dimensions are reduced until the target is reached or a safe floor
 * is reached. This is intentionally a page-level budget rather than a PDF-
 * container-level guess so multi-page files remain predictable.
 */
export async function encodePdfPageImage(
  canvas: HTMLCanvasElement,
): Promise<{ blob: Blob; width: number; height: number }> {
  let working = canvas;
  let quality = PDF_JPEG_QUALITY;
  let blob = await canvasToJpegBlob(working, quality);

  if (blob.size <= PDF_PAGE_IMAGE_LIMIT) {
    return { blob, width: working.width, height: working.height };
  }

  let low = PDF_MIN_JPEG_QUALITY;
  let high = PDF_JPEG_QUALITY;
  for (let i = 0; i < 6; i++) {
    const mid = (low + high) / 2;
    const candidate = await canvasToJpegBlob(working, mid);
    if (candidate.size <= PDF_PAGE_IMAGE_LIMIT) {
      blob = candidate;
      low = mid;
    } else {
      high = mid;
    }
  }

  if (blob.size <= PDF_PAGE_IMAGE_LIMIT) {
    return { blob, width: working.width, height: working.height };
  }

  let currentScale = 1;
  const minimumScale = Math.min(1, PDF_MIN_RASTER_WIDTH / Math.max(canvas.width, 1));
  for (let i = 0; i < 12 && currentScale > minimumScale + 0.001; i++) {
    const sizeRatio = Math.sqrt(PDF_PAGE_IMAGE_LIMIT / Math.max(blob.size, 1));
    currentScale = Math.max(minimumScale, currentScale * Math.min(0.88, sizeRatio));
    working = createScaledCanvas(canvas, currentScale);
    blob = await canvasToJpegBlob(working, Math.max(PDF_MIN_JPEG_QUALITY, 0.5));
    if (blob.size <= PDF_PAGE_IMAGE_LIMIT) {
      return { blob, width: working.width, height: working.height };
    }
  }

  return { blob, width: working.width, height: working.height };
}

function isSimpleAsciiText(text: string): boolean {
  if (!text.trim() || text.length > SIMPLE_TEXT_MAX_LENGTH) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code > 126) return false;
  }
  return true;
}

function isExcludedTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  if (!isSimpleAsciiText(node.nodeValue || '')) return true;
  const excluded = parent.closest('pre, code, table, svg, math, mjx-container, img, video, iframe, canvas, script, style');
  if (excluded) return true;
  if (parent.closest('a[href], a[data-href]')) return true;
  const style = getComputedStyle(parent);
  if (style.visibility === 'hidden' || style.display === 'none' || style.transform !== 'none') return true;
  if (style.whiteSpace === 'pre' || style.whiteSpace === 'pre-wrap' || style.whiteSpace === 'pre-line') return true;
  return false;
}

function addSelectableTextOverlay(
  pdf: PdfWithExtras,
  container: HTMLElement,
  pageStartY: number,
  pageHeight: number,
) {
  const containerRect = container.getBoundingClientRect();
  const domScale = getDomScale(container);
  const walker = activeDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  pdf.setFont('helvetica', 'normal');

  while (node) {
    const textNode = node as Text;
    if (isExcludedTextNode(textNode)) {
      node = walker.nextNode();
      continue;
    }

    const range = activeDocument.createRange();
    range.selectNodeContents(textNode);
    const rects = Array.from(range.getClientRects());
    if (rects.length !== 1) {
      node = walker.nextNode();
      continue;
    }

    const rect = rects[0]!;
    const top = (rect.top - containerRect.top) / domScale.y - pageStartY;
    const bottom = (rect.bottom - containerRect.top) / domScale.y - pageStartY;
    const visibleTop = Math.max(0, top);
    const visibleBottom = Math.min(pageHeight, bottom);
    if (visibleBottom <= visibleTop || rect.width <= 0) {
      node = walker.nextNode();
      continue;
    }

    const style = getComputedStyle(textNode.parentElement!);
    const fontSizePx = Math.max(6, Number.parseFloat(style.fontSize) || 16);
    const fontSizePt = fontSizePx * 72 / 96;
    const x = ((rect.left - containerRect.left) / domScale.x) / 96;
    const y = (visibleTop + Math.min(fontSizePx * 0.9, visibleBottom - visibleTop)) / 96;
    const text = textNode.nodeValue || '';

    try {
      pdf.setFont(style.fontWeight === '400' || style.fontWeight === 'normal' ? 'helvetica' : 'helvetica', 'normal');
      pdf.setFontSize(fontSizePt);
      const expectedWidth = Math.max(pdf.getTextWidth(text), 0.1);
      const measuredWidth = ((rect.width / domScale.x) / 96);
      const horizontalScale = Math.max(0.55, Math.min(2.2, measuredWidth / expectedWidth));
      pdf.text(text, x, y, {
        renderingMode: 'invisible',
        baseline: 'alphabetic',
        horizontalScale,
      } as Parameters<JsPdf['text']>[3]);
    } catch {
      // A single unsupported text node must never break the entire export.
    }

    node = walker.nextNode();
  }
}

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeHeadingKey(value: string): string {
  return decodeFragment(value)
    .replace(/^#/, '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

interface HeadingDestination {
  key: string;
  pageNumber: number;
  top: number;
  title: string;
  level: number;
}

function getHeadings(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    .filter(heading => heading.textContent?.trim());
}

function getPageForY(y: number, pages: PdfRenderPage[]): number {
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    if (y >= page.startY && y < page.startY + page.contentHeight) return i + 1;
  }
  return pages.length;
}

function getHeadingDestinations(container: HTMLElement, pages: PdfRenderPage[]): HeadingDestination[] {
  const containerRect = container.getBoundingClientRect();
  const domScale = getDomScale(container);
  return getHeadings(container).map(heading => {
    const rect = heading.getBoundingClientRect();
    const y = Math.max(0, (rect.top - containerRect.top) / domScale.y);
    return {
      key: normalizeHeadingKey(heading.textContent || ''),
      pageNumber: getPageForY(y, pages),
      top: y,
      title: (heading.textContent || '').trim(),
      level: Number(heading.tagName.slice(1)),
    };
  });
}

function normalizePath(value: string): string {
  return decodeFragment(value)
    .replace(/^\//, '')
    .replace(/\.md$/i, '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLocaleLowerCase();
}

function resolveInternalLink(
  anchor: HTMLAnchorElement,
  currentFilePath: string | undefined,
  currentVault: string | undefined,
  destinations: HeadingDestination[],
): { type: 'pdf'; pageNumber: number; top: number } | { type: 'obsidian'; url: string } | { type: 'url'; url: string } | undefined {
  const dataHref = anchor.getAttribute('data-href')?.trim();
  const href = anchor.getAttribute('href')?.trim() || '';
  const candidate = dataHref || href;
  if (!candidate) return undefined;
  if (/^(?:javascript|data|blob):/i.test(candidate)) return undefined;
  if (/^(?:https?|mailto|tel):/i.test(candidate)) {
    return { type: 'url', url: candidate };
  }

  const [rawPath, rawFragment] = candidate.split('#', 2);
  const fragment = rawFragment ? normalizeHeadingKey(rawFragment) : '';
  const path = normalizePath(rawPath || '');
  const current = normalizePath(currentFilePath || '');

  if (fragment && (!path || path === current || path.endsWith(`/${current}`) || current.endsWith(`/${path}`))) {
    const destination = destinations.find(item => item.key === fragment);
    if (destination) {
      return { type: 'pdf', pageNumber: destination.pageNumber, top: destination.top };
    }
  }

  if (candidate.startsWith('#')) {
    const destination = destinations.find(item => item.key === fragment);
    if (destination) return { type: 'pdf', pageNumber: destination.pageNumber, top: destination.top };
  }

  if (currentVault && path) {
    const url = `obsidian://open?vault=${encodeURIComponent(currentVault)}&file=${encodeURIComponent(decodeFragment(path))}${fragment ? `%23${encodeURIComponent(decodeFragment(rawFragment || ''))}` : ''}`;
    return { type: 'obsidian', url };
  }

  return undefined;
}

function addPdfLinks(
  pdf: PdfWithExtras,
  container: HTMLElement,
  page: PdfRenderPage,
  pages: PdfRenderPage[],
  destinations: HeadingDestination[],
) {
  const containerRect = container.getBoundingClientRect();
  const domScale = getDomScale(container);
  const currentFilePath = container.dataset.exportSourcePath;
  const currentVault = container.dataset.exportVaultName;

  for (const anchor of Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href], a[data-href]'))) {
    const resolution = resolveInternalLink(anchor, currentFilePath, currentVault, destinations);
    if (!resolution) continue;

    for (const rect of Array.from(anchor.getClientRects())) {
      const left = Math.max(0, (rect.left - containerRect.left) / domScale.x);
      const right = Math.min(container.clientWidth, (rect.right - containerRect.left) / domScale.x);
      const top = (rect.top - containerRect.top) / domScale.y - page.startY;
      const bottom = (rect.bottom - containerRect.top) / domScale.y - page.startY;
      const clippedTop = Math.max(0, top);
      const clippedBottom = Math.min(page.height, bottom);
      if (right <= left || clippedBottom <= clippedTop) continue;

      const x = left / 96;
      const y = clippedTop / 96;
      const width = (right - left) / 96;
      const height = (clippedBottom - clippedTop) / 96;
      if (resolution.type === 'pdf') {
        const destinationPage = pages[resolution.pageNumber - 1];
        const topWithinDestination = Math.max(0, resolution.top - (destinationPage?.startY || 0)) / 96;
        pdf.link(x, y, width, height, {
          pageNumber: resolution.pageNumber,
          top: topWithinDestination,
        });
      } else {
        pdf.link(x, y, width, height, { url: resolution.url });
      }
    }
  }
}

function addPdfOutline(pdf: PdfWithExtras, headings: HeadingDestination[]) {
  if (!pdf.outline || headings.length === 0) return;
  const stack: Array<{ level: number; node: unknown }> = [];
  for (const heading of headings) {
    while (stack.length && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1]!.node : null;
    const node = pdf.outline.add(parent, heading.title, { pageNumber: heading.pageNumber });
    stack.push({ level: heading.level, node });
  }
}

export async function capturePdfPage(
  element: HTMLElement,
  page: PdfPagePosition,
  resolutionMode: ResolutionMode,
  assetMark: ISettings['assetMark'],
): Promise<HTMLCanvasElement> {
  const scale = getPdfScale(element.clientWidth, resolutionMode);
  const pageHeight = Math.max(1, page.height);
  const originalHeight = element.style.height;
  const originalOverflow = element.style.overflow;
  const originalTransform = element.style.transform;

  try {
    element.style.height = `${pageHeight}px`;
    element.style.overflow = 'hidden';
    element.style.transform = page.startY > 0 ? `translateY(-${page.startY}px)` : '';
    const canvas = await htmlToImage.toCanvas(element, {
      width: element.clientWidth,
      height: pageHeight,
      pixelRatio: scale,
      cacheBust: true,
      backgroundColor: '#ffffff',
    });
    if (assetMark.enable) embedInvisibleAssetMark(canvas, assetMark.ownerId);
    return canvas;
  } finally {
    element.style.height = originalHeight;
    element.style.overflow = originalOverflow;
    element.style.transform = originalTransform;
  }
}

export async function buildPdfFromElement(
  element: HTMLElement,
  pagePositions: PdfPagePosition[],
  resolutionMode: ResolutionMode,
  assetMark: ISettings['assetMark'],
  title?: string,
  nominalPageHeight?: number,
): Promise<JsPdf> {
  const sourcePages = pagePositions.length
    ? pagePositions
    : [{ startY: 0, height: element.clientHeight }];
  const pages: PdfRenderPage[] = sourcePages.map((page, index) => ({
    startY: page.startY,
    contentHeight: page.height,
    pageHeight: index === sourcePages.length - 1
      ? page.height
      : Math.max(page.height, nominalPageHeight || page.height),
  }));

  const firstPage = pages[0]!;
  const pdf = new JsPdf({
    unit: 'in',
    format: [pdfWidthIn(element.clientWidth), pdfHeightIn(firstPage.pageHeight)],
    orientation: element.clientWidth > firstPage.pageHeight ? 'l' : 'p',
    compress: true,
  }) as PdfWithExtras;

  if (title) {
    pdf.setProperties({ title });
  }
  pdf.viewerPreferences?.({ NonFullScreenPageMode: 'UseOutlines', DisplayDocTitle: true });

  const headings = getHeadingDestinations(element, pages);

  for (let i = 0; i < pages.length; i++) {
    if (i > 0) {
      pdf.addPage(
        [pdfWidthIn(element.clientWidth), pdfHeightIn(pages[i]!.pageHeight)],
        element.clientWidth > pages[i]!.pageHeight ? 'l' : 'p',
      );
    }

    const page = pages[i]!;
    const canvas = await capturePdfPage(
      element,
      { startY: page.startY, height: page.pageHeight },
      resolutionMode,
      assetMark,
    );
    const encoded = await encodePdfPageImage(canvas);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error('Failed to read PDF image'));
      reader.readAsDataURL(encoded.blob);
    });

    pdf.addImage(
      dataUrl,
      'JPEG',
      0,
      0,
      pdfWidthIn(element.clientWidth),
      pdfHeightIn(page.pageHeight),
      undefined,
      'FAST',
    );
    addPdfLinks(pdf, element, page, pages, headings);
    addSelectableTextOverlay(pdf, element, page.startY, page.pageHeight);
  }

  addPdfOutline(pdf, headings);
  return pdf;
}
