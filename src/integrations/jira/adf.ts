/**
 * Atlassian Document Format for the description of an issue (SRS 3.9.3): the text entered by the user and a
 * reference to the documented screen it comes from.
 *
 * @module integrations/jira/adf
 */
import type { JiraScreenReference } from './types.js';

export type AdfParagraph = { type: 'paragraph'; content: { type: 'text'; text: string }[] };
export type AdfDocument = { type: 'doc'; version: 1; content: AdfParagraph[] };

const paragraph = (text: string): AdfParagraph => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/**
 * Builds the ADF description.
 *
 * @param description - Optional plain text; each non-empty line is one paragraph (ADF rejects empty text nodes).
 * @param screen - The documented screen, referenced in a final paragraph.
 * @returns A version-1 ADF document.
 */
export function buildDescription(description: string | undefined, screen: JiraScreenReference): AdfDocument {
  const lines = (description ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const reference = `Source screen: ${screen.screenName} (${screen.applicationName}) · screen id ${screen.screenId}`;
  return { type: 'doc', version: 1, content: [...lines.map(paragraph), paragraph(reference)] };
}
