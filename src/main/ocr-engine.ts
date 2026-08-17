import { createWorker, Worker } from 'tesseract.js';
import { OcrEngine, OcrWord } from '../tools/ocr';

/** Filesystem locations of the bundled, OFFLINE OCR assets. The OCR path makes NO network request. */
export interface OcrPaths {
  /** Directory holding `eng.traineddata.gz`. */
  langPath: string;
  /** Directory holding the tesseract.js-core wasm/js (the worker picks the right SIMD variant). */
  corePath: string;
  /** The node worker entry script (`tesseract.js/src/worker-script/node/index.js`). */
  workerPath: string;
}

/**
 * tesseract.js OCR engine, fully offline. One worker is created lazily on first use and reused for
 * the process lifetime. Every asset is loaded from local disk (langPath/corePath/workerPath) with
 * `cacheMethod:'none'`, so recognition never touches the network. `recognize()` returns word-level
 * bounding boxes in RASTER pixels; mapping to CSS-viewport px is the caller's job (mapWordsToViewport).
 */
export class TesseractEngine implements OcrEngine {
  private workerP?: Promise<Worker>;

  constructor(private readonly paths: OcrPaths) {}

  private worker(): Promise<Worker> {
    if (!this.workerP) {
      this.workerP = createWorker('eng', 1, {
        langPath: this.paths.langPath,
        gzip: true,
        cacheMethod: 'none',
        corePath: this.paths.corePath,
        workerPath: this.paths.workerPath,
        logger: () => {},
      }).catch((e) => {
        // Don't latch a rejected promise — let the next call retry a fresh worker.
        this.workerP = undefined;
        throw e;
      });
    }
    return this.workerP;
  }

  async recognize(png: Buffer): Promise<OcrWord[]> {
    const worker = await this.worker();
    const { data } = await worker.recognize(png, {}, { blocks: true });
    const out: OcrWord[] = [];
    for (const b of data.blocks ?? []) {
      for (const p of b.paragraphs ?? []) {
        for (const l of p.lines ?? []) {
          for (const w of l.words ?? []) {
            out.push({
              text: w.text ?? '',
              x0: w.bbox.x0,
              y0: w.bbox.y0,
              x1: w.bbox.x1,
              y1: w.bbox.y1,
              confidence: w.confidence,
            });
          }
        }
      }
    }
    return out;
  }
}
