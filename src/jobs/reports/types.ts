/**
 * What the two generators and the worker share.
 *
 * @module jobs/reports/types
 */
import type { ReportContent } from '../../modules/reports/content.js';

/** A generated file. */
export type GeneratedFile = {
  buffer: Buffer;
  mimeType: string;
  /** Characters of the text that the font cannot draw and were replaced by `?` (PDF; always 0 for Excel). */
  replacedCharacters: number;
  /** Largest heap (MB) the generator thread used, sampled while it worked (absent for in-process test generators). */
  heapPeakMb?: number;
};

/** What a generator may use besides the content. */
export type GeneratorContext = {
  /** Throws when the time limit is over or the worker is stopping; called between groups of rows. */
  checkpoint: () => void | Promise<void>;
  /** The largest file allowed (`REPORT_MAX_BYTES`); a generator that can tell early throws `ReportTooLargeError`. */
  maxBytes: number;
  /** The instant (epoch ms) by which the report must be finished (`REPORT_MAX_SECONDS`). */
  deadlineMs: number;
  /** Aborted when the server is stopping and the report is given up. */
  signal: AbortSignal;
};

/** Turns the content into the bytes of a file. */
export type Generator = (content: ReportContent, context: GeneratorContext) => Promise<GeneratedFile>;
