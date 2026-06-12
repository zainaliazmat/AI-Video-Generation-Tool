import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Marked} from 'marked';

/**
 * Server-only: read docs/TEMPLATE-AUTHORING.md (the normative authoring
 * standard) and render it to HTML for /templates/guide, plus a heading
 * tree for the sticky table of contents. Read fresh per request so doc
 * edits show without a rebuild (same convention as loadTemplates).
 */

export type GuideTocChild = {id: string; label: string};
export type GuideTocSection = {id: string; label: string; children: GuideTocChild[]};
export type AuthoringGuide = {html: string; toc: GuideTocSection[]};

/** Anchor slug from a heading's raw markdown text. */
function slugify(rawText: string): string {
  return rawText
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Human label: raw heading text minus inline-markdown markers. */
function tocLabel(rawText: string): string {
  return rawText.replace(/[`*_]/g, '');
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Ids must match between the TOC pass and the render pass. Both walk h2/h3
 * headings in document order, so one dedupe sequence per pass stays aligned.
 */
function makeIdAllocator(): (raw: string) => string {
  const seen = new Map<string, number>();
  return (raw: string) => {
    const base = slugify(raw);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

export function loadAuthoringGuide(): AuthoringGuide {
  const docPath = resolve(process.cwd(), '..', 'docs', 'TEMPLATE-AUTHORING.md');
  const source = readFileSync(docPath, 'utf-8');

  const marked = new Marked();

  // TOC pass: h2 sections with their h3 children.
  const tocIds = makeIdAllocator();
  const toc: GuideTocSection[] = [];
  for (const token of marked.lexer(source)) {
    if (token.type !== 'heading') continue;
    if (token.depth === 2) {
      toc.push({id: tocIds(token.text), label: tocLabel(token.text), children: []});
    } else if (token.depth === 3 && toc.length > 0) {
      toc[toc.length - 1].children.push({id: tocIds(token.text), label: tocLabel(token.text)});
    }
  }

  // Render pass: anchored headings, language-chipped code blocks.
  const renderIds = makeIdAllocator();
  marked.use({
    renderer: {
      heading({tokens, depth, text}) {
        const inline = this.parser.parseInline(tokens);
        // The route supplies its own hero header; drop the doc's h1.
        if (depth === 1) return '';
        if (depth > 3) return `<h${depth}>${inline}</h${depth}>\n`;
        const id = renderIds(text);
        return `<h${depth} id="${id}">${inline}<a class="guide-anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      code({text, lang}) {
        const language = (lang ?? '').trim().split(/\s+/)[0];
        const chip = language ? `<figcaption>${escapeHtml(language)}</figcaption>` : '';
        return `<figure class="guide-code">${chip}<pre><code>${escapeHtml(text)}</code></pre></figure>\n`;
      },
    },
  });

  let html = marked.parse(source, {async: false});
  // Tables need a scroll container on narrow viewports.
  html = html
    .replaceAll('<table>', '<div class="guide-table-wrap"><table>')
    .replaceAll('</table>', '</table></div>');
  // React 19 hydration compares __html against the DOM's innerHTML, which
  // serializes quotes in TEXT nodes unescaped; marked emits &quot;/&#39;.
  // Normalize text segments (between tags) to the browser's serialization —
  // attribute values (inside tags) are untouched.
  html = html.replace(
    />([^<]*)</g,
    (_m, text: string) => '>' + text.replaceAll('&quot;', '"').replaceAll('&#39;', "'") + '<',
  );

  return {html, toc};
}
