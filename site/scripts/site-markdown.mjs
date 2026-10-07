import MarkdownIt from "markdown-it";

export function createSiteMarkdown(rewriteHref) {
  const markdown = new MarkdownIt({ html: false });
  const renderLink = markdown.renderer.rules.link_open;
  markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    token.attrSet("href", rewriteHref(token.attrGet("href"), env.sourceDir));
    return renderLink
      ? renderLink(tokens, index, options, env, renderer)
      : renderer.renderToken(tokens, index, options);
  };
  markdown.renderer.rules.heading_open = (tokens, index, options, env, renderer) => {
    const text = tokens[index + 1].children
      .filter((token) => ["text", "code_inline", "image"].includes(token.type))
      .map((token) => token.content)
      .join("");
    const slug = text.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, "")
      .replace(/\s/g, "-");
    const count = env.headingSlugs.get(slug) ?? 0;
    env.headingSlugs.set(slug, count + 1);
    tokens[index].attrSet("id", count ? `${slug}-${count}` : slug);
    return renderer.renderToken(tokens, index, options);
  };
  markdown.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
  markdown.renderer.rules.table_close = () => "</table></div>\n";

  const environment = (sourceDir) => ({ sourceDir, headingSlugs: new Map() });
  return {
    render: (text, sourceDir) => markdown.render(text, environment(sourceDir)),
    renderInline: (text, sourceDir) => markdown.renderInline(text, environment(sourceDir)),
  };
}
