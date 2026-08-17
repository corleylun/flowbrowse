import { Mode } from '../core/modes';
import { RiskLevel, Tool, Parser } from '../core/tool';

/** One recognized word, in the RASTER pixel space of the source screenshot. */
export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 0–100 recognition confidence. */
  confidence: number;
}

/**
 * OCR engine seam — takes a PNG buffer, returns raster-space words. Deliberately Electron-free and
 * swappable (tesseract.js today; a native Vision fast-path could slot in behind this later).
 */
export interface OcrEngine {
  recognize(png: Buffer): Promise<OcrWord[]>;
}

/** A recognized word placed in CSS-viewport pixels — the space click_at / move_to / type_text use. */
export interface ScreenWord {
  text: string;
  /** Centre point in CSS viewport px — feed straight to click_at / move_to. */
  x: number;
  y: number;
  rect: { x: number; y: number; width: number; height: number };
  /** 0–100 recognition confidence. */
  confidence: number;
}

export interface ScreenText {
  /** Total words recognized (before the cap). */
  count: number;
  /** Up to MAX_WORDS words, ordered top-to-bottom then left-to-right. */
  words: ScreenWord[];
  /** Set when no text could be produced (engine unavailable, or an empty/hidden-tab capture). */
  note?: string;
}

/** Read-only screen-text lookup. Electron-free interface (implemented by the PageController). */
export interface OcrController {
  readScreenText(tabId: string): Promise<ScreenText>;
}

export const MAX_WORDS = 500;

/**
 * Read a PNG's pixel dimensions straight from its IHDR chunk (width @ byte 16, height @ byte 20,
 * both big-endian uint32). This is the raster size tesseract actually decodes — use it, NOT
 * Electron's `NativeImage.getSize()`, which returns LOGICAL (DIP) size while `toPNG()` encodes the
 * PHYSICAL resolution. On a retina display those differ by devicePixelRatio, and mixing them makes
 * every mapped coordinate off by that factor (the classic `capturePage` retina gotcha).
 */
export function pngDimensions(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Map raster-space OCR words into CSS-viewport pixels — the SAME space locate/click_at consume.
 * Ratio-only: `css = raster × (viewport / raster)`. Because the capture raster already bakes in
 * BOTH devicePixelRatio and page zoom, this single ratio folds both out; there is deliberately no
 * separate dpr/zoom/scroll term (a screenshot is inherently viewport-relative). Whitespace-only
 * words are dropped; results are sorted top-to-bottom then left-to-right, and capped.
 */
export function mapWordsToViewport(
  words: OcrWord[],
  raster: { width: number; height: number },
  viewport: { w: number; h: number },
  cap = MAX_WORDS,
): ScreenWord[] {
  const rx = viewport.w / Math.max(1, raster.width);
  const ry = viewport.h / Math.max(1, raster.height);
  return words
    .filter((w) => w.text.trim() !== '')
    .map((w) => {
      const x0 = w.x0 * rx;
      const y0 = w.y0 * ry;
      const x1 = w.x1 * rx;
      const y1 = w.y1 * ry;
      return {
        text: w.text.trim(),
        x: Math.round((x0 + x1) / 2),
        y: Math.round((y0 + y1) / 2),
        rect: {
          x: Math.round(x0),
          y: Math.round(y0),
          width: Math.round(x1 - x0),
          height: Math.round(y1 - y0),
        },
        confidence: Math.round(w.confidence),
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .slice(0, cap);
}

const noArgs: Parser<Record<string, never>> = {
  parse(raw) {
    if (raw !== undefined && raw !== null && typeof raw !== 'object') {
      throw new Error('this tool takes no arguments');
    }
    return {};
  },
};

/**
 * `read_screen_text` — OCR the visible page into words WITH their on-screen coordinates (CSS
 * viewport px), so an agent can drive click_at / type_text on canvas / no-DOM pages where `locate`
 * (DOM-only) finds nothing. Read-tier, no approval — pure introspection, same class as `screenshot`.
 *
 * NOT "AI vision" (the model already sees the screenshot via the `screenshot` tool): this is fast,
 * precise text→coordinate extraction the model can't eyeball. It runs on the already
 * privacy-redacted rendered page, and recognized text is NEVER written to the audit (no auditInput,
 * no auditResult — only the fact of the call is logged).
 */
export function createOcrTool(ctrl: OcrController): Tool<Record<string, never>, ScreenText> {
  return {
    name: 'read_screen_text',
    description:
      'OCR the visible page into words with their centre coordinates (CSS px) for click_at / ' +
      'move_to / type_text. Use on canvas or no-DOM pages where locate finds nothing. Read-only.',
    minMode: Mode.Read,
    risk: RiskLevel.Low,
    requiresApproval: false,
    inputSchema: noArgs,
    handler: (_input, ctx) => ctrl.readScreenText(ctx.tabId),
  };
}
