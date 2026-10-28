'use strict';
/**
 * Article body renderer.
 *
 * Keeps Nogiti's existing contract (every non-empty line is its own paragraph, `[[image:ID]]` on its own
 * line embeds an uploaded article image, raw HTML is never interpreted) and adds the lightweight structured
 * syntax from Paradigmshift `apps/web/lib/rich-text.tsx` + `apps/api/src/content/rich-text.ts`:
 *   "## " / "### " headings, "- " / "* " bullets, "1. " numbered lists, "> " quotes,
 *   **bold** and [label](https://… | /path | mailto:…).
 * Everything is escaped first; only the generated tags are emitted, so stored XSS is not possible.
 */
const { escapeHtml } = require('./text');

function isSafeHref(href) {
  if (typeof href !== 'string' || !href || href.length > 2048) return false;
  if ([...href].some(c => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127 || /\s/u.test(c))) return false;
  if (href.startsWith('/')) return !href.startsWith('//') && !href.startsWith('/\\');
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function renderInline(text) {
  const pattern = /\*\*([^*\n]+)\*\*|\[([^\]\n]{1,300})\]\(([^)\s]{1,2048})\)/g;
  let out = '';
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    out += escapeHtml(text.slice(last, match.index));
    if (match[1] !== undefined) out += `<strong>${escapeHtml(match[1])}</strong>`;
    else if (isSafeHref(match[3])) {
      const external = !match[3].startsWith('/');
      out += `<a href="${escapeHtml(match[3])}"${external ? ' target="_blank" rel="noopener noreferrer nofollow"' : ''}>${escapeHtml(match[2])}</a>`;
    } else out += escapeHtml(match[2]);
    last = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function renderArticleBody(source, articleImages = []) {
  const imageMap = new Map(articleImages.map(image => [String(image.id), image]));
  const html = [];
  let list = null;
  const flushList = () => {
    if (list) { html.push(`<${list.tag}>${list.items.map(item => `<li>${renderInline(item)}</li>`).join('')}</${list.tag}>`); list = null; }
  };
  for (const raw of String(source || '').split(/\r?\n/)) {
    const text = raw.trim();
    if (!text) { flushList(); continue; }
    let m;
    if ((m = text.match(/^\[\[image:(\d+)\]\]$/i))) {
      flushList();
      const image = imageMap.get(m[1]);
      if (image) html.push(`<figure class="inline-article-image"><img src="${escapeHtml(image.image_path)}" alt="${escapeHtml(image.alt_text || '')}" loading="lazy" decoding="async"><figcaption>${escapeHtml(image.alt_text || '')}</figcaption></figure>`);
      continue;
    }
    if ((m = text.match(/^###\s+(.+)$/))) { flushList(); html.push(`<h3>${renderInline(m[1])}</h3>`); continue; }
    if ((m = text.match(/^##\s+(.+)$/))) { flushList(); html.push(`<h2>${renderInline(m[1])}</h2>`); continue; }
    if ((m = text.match(/^>\s?(.+)$/))) { flushList(); html.push(`<blockquote>${renderInline(m[1])}</blockquote>`); continue; }
    if ((m = text.match(/^[-*•]\s+(.+)$/))) {
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(m[1]); continue;
    }
    if ((m = text.match(/^[0-9۰-۹]+[.)]\s+(.+)$/))) {
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(m[1]); continue;
    }
    flushList();
    html.push(`<p>${renderInline(text)}</p>`);
  }
  flushList();
  return html.join('');
}

module.exports = { renderArticleBody, isSafeHref };
