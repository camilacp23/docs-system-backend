/**
 * What a report contains (D-115, D-116), as one neutral structure that the Excel and the PDF generators both print, so
 * the two formats have the same parts, the same columns and the same order of rows.
 *
 * Everything is read on the client of ONE transaction (the worker's `REPEATABLE READ` snapshot), one statement after the
 * other. The Summary comes from the dashboard service (the same figures as `GET /dashboard/indicators`, D-106) and the
 * Dependencies from the dependencies service (the graph of D-104), both through their services and on that same client;
 * the other parts are this module's own reads (`contentRepository`). The structure is built here and printed elsewhere:
 * nothing in this file knows Excel or PDF.
 *
 * @module modules/reports/content
 */
import { nodeKey, type Graph, type GraphEdge } from '../dependencies/graph.js';
import type { DashboardService } from '../dashboard/service.js';
import type { DependenciesService } from '../dependencies/service.js';
import * as repo from './contentRepository.js';
import { ReportScreenGoneError, ReportTooLargeError } from './failures.js';
import type { ReportParameters } from './repository.js';

/** A value of a cell: text, a number, a date (UTC) or nothing. */
export type CellValue = string | number | Date | null;

/** A column of a part. `mono` marks code (the Power Fx of `onSelect`), which the PDF prints in the monospaced font. */
export type ContentColumn = { header: string; width: number; mono?: boolean };

/** How the PDF lays a part out: one block per row (long texts) or one line per row (short values). */
export type ContentLayout = 'records' | 'lines';

/** One part of the report: a sheet in Excel and a section in PDF. */
export type ContentSection = {
  /** Fixed name (D-116); at most 31 characters, so it is also the name of the sheet. */
  name: string;
  layout: ContentLayout;
  columns: ContentColumn[];
  rows: CellValue[][];
};

/** The whole report. */
export type ReportContent = {
  title: string;
  application: string;
  generatedBy: string;
  generatedAt: Date;
  sections: ContentSection[];
};

/** The report being generated, as the worker claimed it. */
export type ReportJob = {
  id: number;
  applicationId: number;
  title: string;
  generatedById: number;
  generatedByName: string;
  parameters: ReportParameters;
};

/** What the builder needs besides the transaction client. */
export type ContentDeps = {
  client: repo.ContentClient & Parameters<DependenciesService['graphOn']>[0];
  dashboard: Pick<DashboardService, 'indicatorsOn'>;
  dependencies: Pick<DependenciesService, 'graphOn'>;
  /** The most rows of all the parts together (`REPORT_MAX_ROWS`). */
  maxRows: number;
  /**
   * The most characters of text the parts may hold together. It protects the MAIN thread, which reads the whole content
   * before the generator thread gets it (about 13 bytes of process memory per character, measured).
   */
  maxChars: number;
  /** The instant of the report ("when it was generated"). */
  now: Date;
  /** Throws when the time limit is over or the worker is stopping; called between parts. */
  checkpoint: () => void | Promise<void>;
  /** Test hook: runs after each part was read (production passes none). */
  afterSection?: (name: string) => Promise<void>;
};

const STATUSES = ['UNDOCUMENTED', 'DRAFT', 'IN_PROGRESS', 'IN_REVIEW', 'APPROVED'] as const;

const col = (header: string, width: number, mono = false): ContentColumn => ({
  header,
  width,
  ...(mono ? { mono } : {}),
});

/** The edge's data for the Dependencies part. */
const edgeCells = (edge: GraphEdge): { accessMode: string | null; usedIn: string | null; fn: string | null } => ({
  accessMode: 'accessMode' in edge ? edge.accessMode : null,
  usedIn: 'usedIn' in edge ? edge.usedIn : null,
  fn: 'assignmentFunction' in edge ? edge.assignmentFunction : null,
});

/**
 * Builds the content of a report.
 *
 * @param job - The report.
 * @param deps - The transaction client, the two services it reads through, the limits and the clock.
 * @throws {ReportScreenGoneError} A screen of `scope.screenIds` was deleted after the request.
 * @throws {ReportTooLargeError} The parts together have more than `maxRows` rows.
 */
export async function buildReportContent(job: ReportJob, deps: ContentDeps): Promise<ReportContent> {
  const { scope } = job.parameters;
  const { client } = deps;
  const wants = (type: string): boolean => (scope.elementTypes as string[]).includes(type);
  const filter: repo.ScreenFilter = { screenIds: scope.screenIds, statuses: scope.documentationStatus };
  let remaining = deps.maxRows;
  const take = (rows: number): void => {
    if (rows > remaining) throw new ReportTooLargeError('rows');
    remaining -= rows;
  };
  const sections: ContentSection[] = [];
  const done = async (section: ContentSection): Promise<void> => {
    sections.push(section);
    await deps.checkpoint();
    await deps.afterSection?.(section.name);
  };

  const application = await repo.readApplicationName(client, job.applicationId);
  if (application === null) throw new Error('the application of the report does not exist'); // not possible: RESTRICT
  if (scope.screenIds !== undefined) {
    // A screen that was selected when the report was requested and no longer exists (D-119, reason 3).
    if ((await repo.countScreens(client, job.applicationId, scope.screenIds)) < scope.screenIds.length) {
      throw new ReportScreenGoneError();
    }
  }

  // The size is known BEFORE any text is read, by one statement that brings no text; a report that is too big fails here.
  const size = await repo.readReportSize(client, job.applicationId, filter, {
    screens: wants('SCREEN'),
    components: wants('COMPONENT'),
    variables: wants('VARIABLE'),
    collections: wants('COLLECTION'),
  });
  if (size.rows > deps.maxRows) throw new ReportTooLargeError('rows');
  if (size.chars > deps.maxChars) throw new ReportTooLargeError('chars');

  const nodes = new Set<string>(); // the elements that are in the report, for the Dependencies part

  if (scope.includeStatusSummary === true) {
    const { documentation, variables, collections } = await deps.dashboard.indicatorsOn(client, job.applicationId);
    const rows: CellValue[][] = [
      ['Application', application],
      ['Title', job.title],
      ['Generated by', job.generatedByName],
      ['Generated at (UTC)', deps.now],
      ['Screens', documentation.totalScreens],
      ...STATUSES.map((status): CellValue[] => [`Screens ${status}`, documentation.byStatus[status]]),
      ['Approved screens (%)', documentation.approvedPercent],
      ['Variables', variables.total],
      ['Variables without origin screen', variables.untraced],
      ['Collections', collections.total],
      ['Collections not documented', collections.undocumented],
    ];
    take(rows.length);
    await done({ name: 'Summary', layout: 'lines', columns: [col('Item', 36), col('Value', 60)], rows });
  }

  if (wants('SCREEN')) {
    const screens = await repo.readScreens(client, job.applicationId, filter, remaining + 1);
    take(screens.length);
    for (const screen of screens) nodes.add(nodeKey('SCREEN', screen.id));
    await done({
      name: 'Screens',
      layout: 'records',
      columns: [
        col('Name', 30),
        col('Status', 16),
        col('Author', 24),
        col('Last updated (UTC)', 22),
        col('Miro link', 40),
        col('On start', 60),
        col('Working process', 60),
        col('Architecture', 60),
        col('Data model', 60),
        col('Requirements', 60),
        col('Known issues', 60),
        col('Risks', 60),
      ],
      rows: screens.map((s) => [
        s.name,
        s.status,
        s.author,
        s.updatedAt,
        s.miroLink,
        s.onStart,
        s.workingProcess,
        s.architecture,
        s.dataModel,
        s.requirements,
        s.knownIssues,
        s.risks,
      ]),
    });
  }

  if (wants('COMPONENT')) {
    const components = await repo.readComponents(client, job.applicationId, filter, remaining + 1);
    take(components.length);
    for (const component of components) nodes.add(nodeKey('COMPONENT', component.id));
    await done({
      name: 'Components',
      layout: 'records',
      columns: [
        col('Screen', 30),
        col('Name', 30),
        col('Control type', 20),
        col('Description', 60),
        col('On select', 60, true),
      ],
      rows: components.map((c) => [c.screen, c.name, c.type, c.description, c.onSelect]),
    });
  }

  if (wants('VARIABLE')) {
    const variables = await repo.readVariables(client, job.applicationId, remaining + 1);
    take(variables.length);
    for (const variable of variables) nodes.add(nodeKey('VARIABLE', variable.id));
    await done({
      name: 'Variables',
      layout: 'records',
      columns: [
        col('Name', 30),
        col('Data type', 16),
        col('Scope', 12),
        col('Origin screen', 30),
        col('Description', 60),
        col('Environments', 14),
      ],
      rows: variables.map((v) => [v.name, v.dataType, v.scope, v.originScreen, v.description, v.environments]),
    });
  }

  if (wants('COLLECTION')) {
    const collections = await repo.readCollections(client, job.applicationId, remaining + 1);
    take(collections.length);
    for (const collection of collections) nodes.add(nodeKey('COLLECTION', collection.id));
    await done({
      name: 'Collections',
      layout: 'records',
      columns: [
        col('Name', 30),
        col('Creation condition', 60),
        col('Description', 60),
        col('Environments', 14),
        col('Linked to a screen', 18),
      ],
      rows: collections.map((c) => [
        c.name,
        c.creationCondition,
        c.description,
        c.environments,
        c.linked ? 'Yes' : 'No',
      ]),
    });

    const fields = await repo.readCollectionFields(client, job.applicationId, remaining + 1);
    take(fields.length);
    await done({
      name: 'Collection fields',
      layout: 'lines',
      columns: [
        col('Collection', 30),
        col('Position', 10),
        col('Name', 30),
        col('Data type', 16),
        col('Description', 60),
      ],
      rows: fields.map((f) => [f.collection, f.position, f.name, f.dataType, f.description]),
    });
  }

  if (scope.includeDependencies === true) {
    const graph: Graph = await deps.dependencies.graphOn(client, job.applicationId);
    const names = new Map(graph.nodes.map((node) => [node.key, node]));
    // An edge is listed when BOTH its ends are in the report; the graph already orders them (D-104).
    const edges = graph.edges.filter((edge) => nodes.has(edge.source) && nodes.has(edge.target));
    take(edges.length);
    await done({
      name: 'Dependencies',
      layout: 'lines',
      columns: [
        col('Relation', 16),
        col('Source type', 14),
        col('Source', 30),
        col('Target type', 14),
        col('Target', 30),
        col('Access mode', 14),
        col('Used in', 40),
        col('Assignment function', 22),
      ],
      rows: edges.map((edge) => {
        const source = names.get(edge.source);
        const target = names.get(edge.target);
        const data = edgeCells(edge);
        return [
          edge.kind,
          source?.type ?? null,
          source?.name ?? null,
          target?.type ?? null,
          target?.name ?? null,
          data.accessMode,
          data.usedIn,
          data.fn,
        ];
      }),
    });
  }

  return {
    title: job.title,
    application,
    generatedBy: job.generatedByName,
    generatedAt: deps.now,
    sections,
  };
}
