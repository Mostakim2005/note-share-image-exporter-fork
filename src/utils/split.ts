export interface SplitPosition {
  startY: number;
  height: number;
}

export interface SplitOptions {
  mode: SplitMode;
  height: number;
  overlap: number;
  totalHeight: number;
  preserveBlocks?: boolean;
}

export interface ElementMeasure {
  top: number;
  height: number;
}

function relativeRect(container: HTMLElement, element: Element): { top: number; height: number } {
  const rect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return {
    top: Math.max(0, rect.top - containerRect.top),
    height: Math.max(0, rect.height),
  };
}

export function getElementMeasures(container: HTMLElement, mode: SplitMode): ElementMeasure[] {
  if (mode === 'hr') {
    return Array.from(container.querySelectorAll('hr')).map(hr => relativeRect(container, hr));
  }

  if (mode === 'auto') {
    const markdownContainer = container.querySelector<HTMLElement>('.export-image-markdown');
    if (!markdownContainer) return [];
    const contentRoot = (
      markdownContainer.children.length === 1
      && markdownContainer.firstElementChild instanceof HTMLElement
      && markdownContainer.firstElementChild.tagName === 'DIV'
    ) ? markdownContainer.firstElementChild : markdownContainer;

    return Array.from(contentRoot.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element.offsetHeight > 0)
      .map(element => relativeRect(container, element))
      .filter(({ top, height }) => top < container.clientHeight && height > 0)
      .sort((a, b) => a.top - b.top)
      .filter((item, index, all) => index === 0 || Math.abs(item.top - all[index - 1].top) > 0.5);
  }

  return [];
}

function calculateFixedPositions(height: number, overlap: number, totalHeight: number): SplitPosition[] {
  if (totalHeight <= 0) return [];
  const safeOverlap = Math.max(0, overlap);
  const effectiveHeight = Math.max(height, safeOverlap + 50, 1);
  const step = Math.max(1, effectiveHeight - safeOverlap);
  const positions: SplitPosition[] = [];

  for (let startY = 0; startY < totalHeight; startY += step) {
    const pageHeight = Math.min(effectiveHeight, totalHeight - startY);
    if (pageHeight <= 0) break;
    positions.push({ startY, height: pageHeight });
    if (startY + pageHeight >= totalHeight) break;
  }
  return positions;
}

function calculateSafeBlockPositions(height: number, totalHeight: number, elements: ElementMeasure[]): SplitPosition[] {
  if (totalHeight <= 0) return [];
  if (!elements.length) return calculateFixedPositions(height, 0, totalHeight);

  const targetHeight = Math.max(height, 1);
  const positions: SplitPosition[] = [];
  let startY = 0;
  let guard = 0;

  while (startY < totalHeight - 0.5 && guard++ < elements.length + 8) {
    const desiredEnd = Math.min(totalHeight, startY + targetHeight);
    const candidates = elements.map(el => el.top).filter(top => top > startY + 0.5 && top <= desiredEnd + 0.5);
    let end = candidates.length ? Math.max(...candidates) : desiredEnd;

    const firstBlock = elements.find(el => el.top >= startY - 0.5);
    if (firstBlock && firstBlock.top <= startY + 0.5 && firstBlock.height > targetHeight) {
      end = Math.min(totalHeight, startY + firstBlock.height);
    }

    end = Math.max(end, startY + 1);
    if (end >= totalHeight - 0.5) {
      positions.push({ startY, height: totalHeight - startY });
      break;
    }
    positions.push({ startY, height: end - startY });
    startY = end;
  }

  return positions;
}

export function getSafeBreakPoints(totalHeight: number, elements: ElementMeasure[] = []): number[] {
  const points = elements
    .map(element => element.top)
    .filter(top => top > 0 && top < totalHeight && Number.isFinite(top));
  return Array.from(new Set([0, ...points, totalHeight])).sort((a, b) => a - b);
}

export function snapBreakPosition(
  position: number,
  safePoints: number[],
  previousBreak: number,
  nextBreak: number,
  minPageHeight = 120,
): number {
  const lower = previousBreak + minPageHeight;
  const upper = nextBreak - minPageHeight;
  if (upper <= lower) return Math.max(previousBreak + 1, Math.min(nextBreak - 1, position));

  const clamped = Math.max(lower, Math.min(upper, position));
  let best = clamped;
  let distance = Number.POSITIVE_INFINITY;
  for (const point of safePoints) {
    if (point < lower || point > upper) continue;
    const currentDistance = Math.abs(point - clamped);
    if (currentDistance < distance) {
      distance = currentDistance;
      best = point;
    }
  }
  return best;
}

export function positionsFromBreaks(breaks: number[], totalHeight: number): SplitPosition[] {
  if (totalHeight <= 0) return [];
  const points = Array.from(new Set([0, ...breaks, totalHeight]))
    .filter(point => Number.isFinite(point) && (point === 0 || point === totalHeight || (point > 0 && point < totalHeight)))
    .sort((a, b) => a - b);
  const positions: SplitPosition[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const startY = points[i]!;
    const endY = points[i + 1]!;
    if (endY > startY) positions.push({ startY, height: endY - startY });
  }
  return positions;
}

export function calculateSplitPositions(
  options: SplitOptions,
  elements?: ElementMeasure[],
  manualBreaks?: number[],
): SplitPosition[] {
  const { mode, height, overlap, totalHeight, preserveBlocks = false } = options;

  if (manualBreaks?.length) {
    return positionsFromBreaks(
      manualBreaks.filter(point => point > 0 && point < totalHeight),
      totalHeight,
    );
  }

  if (mode === 'none') return totalHeight > 0 ? [{ startY: 0, height: totalHeight }] : [];

  if (mode === 'hr' && elements) {
    const splitPoints = elements.map(el => el.top).filter(y => y > 0 && y < totalHeight).sort((a, b) => a - b);
    const positions: SplitPosition[] = [];
    let lastY = 0;
    for (const currentY of splitPoints) {
      if (currentY > lastY) positions.push({ startY: lastY, height: currentY - lastY });
      lastY = currentY;
    }
    if (lastY < totalHeight) positions.push({ startY: lastY, height: totalHeight - lastY });
    return positions;
  }

  if (mode === 'auto' && elements?.length) return calculateSafeBlockPositions(height, totalHeight, elements);
  if (preserveBlocks && elements?.length) return calculateSafeBlockPositions(height, totalHeight, elements);

  return calculateFixedPositions(height, overlap, totalHeight);
}

export function calculateSplitLines(options: SplitOptions, elements?: ElementMeasure[], manualBreaks?: number[]): number[] {
  return calculateSplitPositions(options, elements, manualBreaks).slice(0, -1).map(p => p.startY + p.height);
}
