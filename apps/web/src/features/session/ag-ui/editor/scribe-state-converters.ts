/**
 * ScribeState → TipTap JSON / Markdown converters.
 *
 * Inbound (state → editor): markdown inside payloads is converted to
 * HTML via Showdown, then to ProseMirror JSON via generateJSON against
 * the shared scribe schema. The result is one sectionBlock node per
 * Section, ordered by Section.order.
 *
 * State → Markdown: flattens sections into a markdown string for
 * saving to the document backend.
 */

import { generateJSON, type JSONContent } from '@tiptap/core';
import Showdown from 'showdown';

import { buildScribeEditorExtensions } from './editor-extensions';
import type {
  ColumnType,
  KeyValuePayload,
  ListPayload,
  NarrativePayload,
  ScribeState,
  Section,
  SectionStatusState,
  TableColumn,
  TablePayload,
} from '../types';
import { isTableKind } from '../types';
const showdownConverter = new Showdown.Converter({ tables: true });

const EMPTY_DOC: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

export function scribeStateToTiptap(state: ScribeState): JSONContent {
  const sections = state.sections;
  if (!sections.length) return EMPTY_DOC;
  const ordered = [...sections].sort((a, b) => a.order - b.order);
  const extensions = buildScribeEditorExtensions();
  return {
    type: 'doc',
    content: ordered.map((section) => sectionToBlock(section, extensions)),
  };
}

function sectionToBlock(
  section: Section,
  extensions: ReturnType<typeof buildScribeEditorExtensions>
): JSONContent {
  const attrs = {
    sectionKey: section.key,
    kind: section.kind,
    displayName: section.display_name,
    order: section.order,
    statusState: section.status?.state ?? ('pending' as SectionStatusState),
    statusError: section.status?.error ?? null,
    editedByUser: !!section.edited_by_user,
  };

  let body: JSONContent[];
  switch (section.kind) {
    case 'LIST':
      body = [listPayloadToBody(section.payload as Partial<ListPayload>, extensions)];
      break;
    case 'KEY_VALUE':
      body = [kvPayloadToBody(section.payload as Partial<KeyValuePayload>, extensions)];
      break;
    case 'NARRATIVE':
      body = narrativePayloadToBody(section.payload as Partial<NarrativePayload>, extensions);
      break;
    default:
      // TABLE and every clinical kind (medication, vitals, labs, ...) share
      // the {headers, rows} payload shape.
      body = isTableKind(section.kind)
        ? [tablePayloadToBody(section.payload as Partial<TablePayload>, extensions)]
        : [emptyParagraph()];
  }

  return {
    type: 'sectionBlock',
    attrs,
    content: body,
  };
}

function listPayloadToBody(
  payload: Partial<ListPayload>,
  extensions: ReturnType<typeof buildScribeEditorExtensions>
): JSONContent {
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    type: 'bulletList',
    content: items.length
      ? items.map((md) => {
          // Strip leading `- ` or `* ` if the backend included the bullet marker
          const text = md.trim().replace(/^[-*]\s+/, '');
          return {
            type: 'listItem',
            content: [listItemToParagraph(text, extensions)],
          };
        })
      : [
          {
            type: 'listItem',
            content: [emptyParagraph()],
          },
        ],
  };
}

function listItemToParagraph(
  text: string,
  extensions: ReturnType<typeof buildScribeEditorExtensions>
): JSONContent {
  if (!text) return emptyParagraph();
  // Check if text has any markdown formatting
  if (!/[*_`~\[]/.test(text)) {
    return { type: 'paragraph', content: [{ type: 'text', text }] };
  }
  // Parse inline markdown (bold, italic, etc.) but extract only inline nodes
  const html = showdownConverter.makeHtml(text);
  const parsed = safeGenerateJSON(html, extensions);
  const blocks = parsed?.content ?? [];
  // Only take inline content from the first paragraph — avoid nested list structures
  const firstBlock = blocks.find((b) => b.type === 'paragraph');
  if (firstBlock?.content?.length) {
    return { type: 'paragraph', content: firstBlock.content };
  }
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function tablePayloadToBody(
  payload: Partial<TablePayload>,
  extensions: ReturnType<typeof buildScribeEditorExtensions>
): JSONContent {
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  const rows = Array.isArray(payload.rows) ? payload.rows : [];

  const headerRow: JSONContent = {
    type: 'tableRow',
    content: headers.map((col) => ({
      type: 'tableHeader',
      attrs: {
        colKey: col.key,
        cellType: col.type ?? 'markdown',
      },
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: col.label }],
        },
      ],
    })),
  };

  const dataRows: JSONContent[] = rows.map((row) => ({
    type: 'tableRow',
    content: headers.map((col) =>
      tableCellNode(col, row[col.key] as string | undefined, extensions)
    ),
  }));

  return {
    type: 'table',
    content: headers.length ? [headerRow, ...dataRows] : [],
  };
}

function tableCellNode(
  col: TableColumn,
  raw: string | undefined,
  extensions: ReturnType<typeof buildScribeEditorExtensions>
): JSONContent {
  const colType: ColumnType = col.type ?? 'markdown';
  const value = raw ?? '';
  if (colType === 'markdown') {
    return {
      type: 'tableCell',
      attrs: { colKey: col.key, cellType: 'markdown' },
      content: [markdownToParagraph(value, extensions)],
    };
  }
  // text, number, date — render plain text in the cell. cellType is
  // preserved as a data attribute so save-time validation knows the
  // column's intended type.
  return {
    type: 'tableCell',
    attrs: { colKey: col.key, cellType: colType },
    content: [
      {
        type: 'paragraph',
        content: value ? [{ type: 'text', text: value }] : [],
      },
    ],
  };
}

function kvPayloadToBody(
  payload: Partial<KeyValuePayload>,
  extensions: ReturnType<typeof buildScribeEditorExtensions>
): JSONContent {
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    type: 'kvList',
    content: items.length
      ? items.map((item) => ({
          type: 'kvItem',
          attrs: { keyName: item.key ?? '' },
          content: markdownToInlineContent(item.value ?? '', extensions),
        }))
      : [
          {
            type: 'kvItem',
            attrs: { keyName: '' },
            content: [],
          },
        ],
  };
}

function narrativePayloadToBody(
  payload: Partial<NarrativePayload>,
  extensions: ReturnType<typeof buildScribeEditorExtensions>
): JSONContent[] {
  const md = payload.markdown ?? '';
  if (!md.trim()) return [emptyParagraph()];
  const html = showdownConverter.makeHtml(md);
  const parsed = safeGenerateJSON(html, extensions);
  const content = parsed?.content;
  return Array.isArray(content) && content.length ? content : [emptyParagraph()];
}

function markdownToParagraph(
  md: string,
  extensions: ReturnType<typeof buildScribeEditorExtensions>
): JSONContent {
  return {
    type: 'paragraph',
    content: markdownToInlineContent(md, extensions),
  };
}

function markdownToInlineContent(
  md: string,
  extensions: ReturnType<typeof buildScribeEditorExtensions>
): JSONContent[] {
  const trimmed = (md ?? '').trim();
  if (!trimmed) return [];
  const html = showdownConverter.makeHtml(trimmed);
  const parsed = safeGenerateJSON(html, extensions);
  const blocks = parsed?.content ?? [];
  // Collapse blocks → inline. We expect either one paragraph (most
  // markdown items) or multiple inline-bearing blocks; either way,
  // concat their inline content.
  const inline: JSONContent[] = [];
  for (const block of blocks) {
    if (Array.isArray(block.content)) inline.push(...block.content);
  }
  return inline.length ? inline : [{ type: 'text', text: trimmed }];
}

function emptyParagraph(): JSONContent {
  return { type: 'paragraph' };
}

function safeGenerateJSON(
  html: string,
  extensions: ReturnType<typeof buildScribeEditorExtensions>
): JSONContent | null {
  try {
    return generateJSON(html, extensions) as JSONContent;
  } catch (e) {
    console.warn('[scribe-converters] generateJSON failed', e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ScribeState → Markdown (for saving to document backend)
// ─────────────────────────────────────────────────────────────────────────

export function scribeStateToMarkdown(state: ScribeState): string {
  const ordered = [...state.sections].sort((a, b) => a.order - b.order);
  const parts: string[] = [];

  for (const section of ordered) {
    parts.push(`### ${section.display_name}`);

    switch (section.kind) {
      case 'NARRATIVE': {
        const payload = section.payload as Partial<NarrativePayload>;
        if (payload.markdown) parts.push(payload.markdown);
        break;
      }
      case 'LIST': {
        const payload = section.payload as Partial<ListPayload>;
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (items.length) parts.push(items.map((item) => `- ${item}`).join('\n'));
        break;
      }
      case 'KEY_VALUE': {
        const payload = section.payload as Partial<KeyValuePayload>;
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (items.length)
          parts.push(items.map((item) => `**${item.key}**: ${item.value}`).join('\n'));
        break;
      }
      default: {
        if (!isTableKind(section.kind)) break;
        const payload = section.payload as Partial<TablePayload>;
        const headers = Array.isArray(payload.headers) ? payload.headers : [];
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        if (headers.length) {
          parts.push('| ' + headers.map((h) => h.label).join(' | ') + ' |');
          parts.push('| ' + headers.map(() => '---').join(' | ') + ' |');
          for (const row of rows) {
            parts.push('| ' + headers.map((h) => row[h.key] || '').join(' | ') + ' |');
          }
        }
        break;
      }
    }

    parts.push('');
  }

  return parts.join('\n').trim();
}
