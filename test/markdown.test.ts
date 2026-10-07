import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/lib/markdown";

const base = "https://github.com/marktplatz-dev/marktplatz-dev/blob/abc/approved/demo/v1/skills/demo";

describe("renderMarkdown", () => {
  test("renders ordinary Markdown", () => {
    expect(renderMarkdown("# Title\n\nSome *words*.", base)).toBe("<h3>Title</h3>\n<p>Some <em>words</em>.</p>\n");
  });

  test("shows raw HTML as text instead of running it", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">', base);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  test("drops dangerous links but keeps their text", () => {
    const html = renderMarkdown("[click](javascript:alert(1)) [data](data:text/html,x) [ok](https://example.com)", base);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:");
    expect(html).toContain('<a href="https://example.com" rel="nofollow noopener">ok</a>');
    expect(html).toContain("click");
  });

  test("resolves relative links against the pinned copy", () => {
    expect(renderMarkdown("[ref](references/guide.md)", base)).toContain(`href="${base}/references/guide.md"`);
  });

  test("turns images into links, so pages load nothing from a skill", () => {
    const html = renderMarkdown("![diagram](https://tracker.example/pixel.png)", base);
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://tracker.example/pixel.png" rel="nofollow noopener">[image: diagram]</a>');
  });
});
