/**
 * Routes of the reports module (Module 9): binds each operationId of the contract to its handler. Roles are not
 * declared here; the contract (x-roles, x-rule) is the only source of authorization (D-39).
 *
 * @module modules/reports/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createReportsController } from './controller.js';
import { createReportService } from './service.js';

/**
 * Handlers of the /reports operations.
 *
 * @param db - Database connected as docs_app.
 * @param hooks - `onQueued` is called after a report was saved, to wake the worker of the same process.
 */
export function reportsHandlers(
  db: Pick<Database, 'base' | 'auditedTransaction'>,
  hooks?: { onQueued?: () => void },
): OperationHandlers {
  const controller = createReportsController(createReportService(db, hooks));
  return {
    generatePdfReport: controller.generatePdf,
    generateExcelReport: controller.generateExcel,
    listReports: controller.list,
    getReport: controller.get,
    downloadReport: controller.download,
    setReportPublication: controller.setPublication,
  };
}
