import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  it('escapes everything, renders the constructs agents use, and lets no raw HTML through', () => {
    const md = [
      '# Title',
      'Fix in `src/app.ts` — **bold** and *em*, see [docs](https://example.com/x).',
      '',
      '- one <script>alert(1)</script>',
      '- two',
      '',
      '1. first',
      '2. second',
      '',
      '```ts',
      'const x = "<b>";',
      '```',
      '<img src=x onerror=alert(1)>',
    ].join('\n');
    const html = renderMarkdown(md);
    expect(html).toContain('<h3>Title</h3>');
    expect(html).toContain('<code>src/app.ts</code>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<a href="https://example.com/x">docs</a>');
    expect(html).toContain('<ul><li>one &lt;script&gt;alert(1)&lt;/script&gt;</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<pre><code class="lang-ts">const x = &quot;&lt;b&gt;&quot;;</code></pre>');
    expect(html).toContain('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    // Only our own tags exist in the output; anything else was escaped.
    const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
    expect([...tags].sort()).toEqual(['a', 'code', 'em', 'h3', 'li', 'ol', 'p', 'pre', 'strong', 'ul']);
    // javascript: links are not links
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('<a ');
  });
});
