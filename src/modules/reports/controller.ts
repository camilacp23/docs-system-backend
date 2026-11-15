/**
 * HTTP layer of the reports module: reads the request, calls the service and writes status, headers and body. No
 * rules here. Authorization (x-roles) already ran in the middleware generated from the contract; `READER_PUBLISHED_ONLY`
 * is the service's.
 *
 * ETag: a single report sends `W/"<updatedAt ms>"` (D-62, D-118) in the 202, the detail, the download and the
 * publication; the list keeps the weak hash of the body that Express adds (D-72). A matching `If-None-Match` is a 304.
 *
 * @module modules/reports/controller
 */
import type { Request, Response } from 'express';
import { assertIfMatch, etagOf, setEtag, setLocation } from '../../http/etag.js';
import { paged, parsePagination } from '../../http/pagination.js';
import type { ReportFormat, ReportView } from './repository.js';
import type { ReportRequestBody, ReportService } from './service.js';

const ELEMENT = 'report';

const idOf = (req: Request): number => Number(req.params.id);

/** `?published=true|false` as a boolean (the validator already checked it). */
const publishedOf = (value: unknown): boolean | undefined =>
  value === undefined ? undefined : value === true || value === 'true';

/**
 * Creates the handlers of the six /reports operations.
 *
 * @param service - Reports service.
 */
export function createReportsController(service: ReportService) {
  const generate = (format: ReportFormat) => async (req: Request, res: Response) => {
    const report = await service.generate(req.user!, format, req.body as ReportRequestBody);
    setLocation(res, '/reports', report.id);
    setEtag(res, etagOf(report));
    res.status(202).json({ data: report });
  };

  return {
    /** POST /reports/pdf */
    generatePdf: generate('PDF'),
    /** POST /reports/excel */
    generateExcel: generate('XLSX'),

    /** GET /reports */
    list: async (req: Request, res: Response): Promise<void> => {
      const page = parsePagination(req.query);
      const { data, total } = await service.list(req.user!, {
        applicationId: Number(req.query.applicationId),
        published: publishedOf(req.query.published),
        skip: page.skip,
        take: page.take,
      });
      res.json(paged(data, page, total));
    },

    /** GET /reports/:id */
    get: async (req: Request, res: Response): Promise<void> => {
      const report = await service.get(req.user!, idOf(req));
      setEtag(res, etagOf(report));
      res.json({ data: report });
    },

    /** GET /reports/:id/file: 404 and 409 first, then 304 or the file. */
    download: async (req: Request, res: Response): Promise<void> => {
      const report: ReportView = await service.forDownload(req.user!, idOf(req));
      setEtag(res, etagOf(report));
      if (req.fresh) {
        res.status(304).end();
        return;
      }
      const file = await service.readFile(report.id);
      res.setHeader('Content-Type', file.mimeType);
      // `fileName` only has a-z, 0-9, "-" and "." (D-120): one ASCII parameter, nothing to quote or escape.
      res.setHeader('Content-Disposition', `attachment; filename="${report.fileName ?? 'report'}"`);
      res.status(200).send(file.content);
    },

    /** PUT /reports/:id/publication */
    setPublication: async (req: Request, res: Response): Promise<void> => {
      const { isPublished } = req.body as { isPublished: boolean };
      const report = await service.setPublication(req.user!, idOf(req), isPublished, (currentETag) =>
        assertIfMatch(req, ELEMENT, currentETag),
      );
      setEtag(res, etagOf(report));
      res.json({ data: report });
    },
  };
}
