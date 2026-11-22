// Builds a sample wiki from a navigation tree plus hand-written main pages.
// Pages without their own text get a short placeholder that explains how to
// generate the real content locally.
import { slugify } from '../../lib/wiki.js';

export function buildDemo({ owner, repo, description, stars, commit, lastIndexed, repositoryReadme, tree, pages }) {
  const out = [];
  const walk = (nodes, parent) => {
    for (const node of nodes) {
      const [title, kids] = Array.isArray(node) ? node : [node, []];
      const path = `${parent ? parent.replace(/\.md$/, '') + '/' : ''}${slugify(title)}.md`;
      const markdown = pages[title] || stub(title, owner, repo, kids || []);
      out.push({ path, title, parent: parent || null, markdown, ...(pages[title] ? {} : { placeholder: true }) });
      walk(kids || [], path);
    }
  };
  walk(tree, null);
  return {
    id: `${owner}/${repo}`,
    owner,
    repo,
    description,
    stars,
    repositoryReadme,
    sample: true,
    lastIndexed,
    commit,
    source: { type: 'github', url: `https://github.com/${owner}/${repo}`, commit },
    pages: out,
  };
}

function stub(title, owner, repo, kids) {
  const children = kids.length
    ? `\n\n## Child Pages\n\n${kids.map(k => `- ${Array.isArray(k) ? k[0] : k}`).join('\n')}`
    : '';
  return `# ${title}

This is a sample page of the **${owner}/${repo}** wiki. Only the overview page of each sample is written out.

To get the full page, choose **Generate locally** or **Add repository**. Safe4wiki reads the repository and writes each page with the model you choose.

## What this page will cover

- The main ideas behind **${title}** and where they live in the code
- The files, classes and functions involved, with links to exact line ranges
- Diagrams of how the parts talk to each other
- Pointers to related pages in this wiki${children}
`;
}
