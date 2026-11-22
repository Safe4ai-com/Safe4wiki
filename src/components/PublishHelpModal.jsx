import { useState } from 'react';
import Dialog from './Dialog.jsx';
import { CheckIcon, CopyIcon } from './Icons.jsx';

function CopySnippet({ code, label }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="guide-code">
      {label && <div className="guide-code-label">{label}</div>}
      <div className="guide-code-row">
        <pre><code>{code}</code></pre>
        <button type="button" className="icon-btn guide-copy" onClick={copy} title="Copy command" aria-label="Copy command">
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        </button>
      </div>
    </div>
  );
}

function getGuide(method, target) {
  const domain = (target.domain || '').trim() || 'docs.mydomain.com';
  const host = (target.host || '').trim() || 'mydomain.com';
  const user = (target.user || '').trim() || 'deploy';
  const port = (target.port || '').trim() || '22';
  const remotePath = (target.remotePath || '').trim() || `/var/www/${domain}`;
  const project = (target.project || '').trim() || 'my-docs';
  const accountId = (target.accountId || '').trim() || 'YOUR_ACCOUNT_ID';
  const branch = (target.branch || '').trim() || 'gh-pages';

  switch (method) {
    case 'ssh':
      return {
        title: 'My server (SSH / rsync)',
        summary: 'Builds a standalone static website and syncs it to your VPS or server over SSH using rsync --delete. Your Nginx/Caddy config, SSL certificates, and HTTP Basic Auth files outside the folder stay untouched.',
        steps: [
          {
            title: 'Point DNS to your server',
            body: <>Create an <code>A</code> or <code>CNAME</code> DNS record for <code>{domain}</code> pointing to your server IP (<code>{host}</code>).</>,
          },
          {
            title: 'Prepare a dedicated folder & web server',
            body: <>Create an empty folder on the server (e.g. <code>{remotePath}</code>) and point Nginx or Caddy to it with SPA fallback (<code>try_files $uri $uri/ /index.html;</code>) and HTTPS (Certbot or Caddy).</>,
          },
          {
            title: 'Make sure passwordless SSH works',
            body: <>Publishing runs SSH non-interactively (<code>BatchMode=yes</code>), so it cannot ask for a password. If your server uses a non-default key file, load it into <code>ssh-agent</code> once before clicking Publish:</>,
            snippets: [
              { label: 'Load a custom SSH key into ssh-agent', code: 'ssh-add ~/.ssh/your_server_key' },
              { label: 'Quick connection test', code: `ssh -p ${port} -o BatchMode=yes ${user}@${host} "ls -la ${remotePath}"` },
            ],
          },
          {
            title: 'Fill in Server, User, Port & Folder and click Publish',
            body: <>Safe4wiki saves these fields locally so future updates take a single click.</>,
          },
        ],
        note: 'Because rsync uses --delete, always point it at a folder dedicated exclusively to docs. For private/internal docs, put HTTP Basic Auth (.htpasswd) in your Nginx/Caddy config — publishing will preserve it.',
      };

    case 'github':
      return {
        title: 'GitHub Pages',
        summary: 'Force-pushes the exported site — including a CNAME file for your subdomain and .nojekyll — to a GitHub branch (default: gh-pages).',
        steps: [
          {
            title: 'Create a target repository',
            body: <>Create a GitHub repository for the docs (for example <code>me/docs-site</code>). Public repositories get free GitHub Pages; private repositories require a paid GitHub plan.</>,
          },
          {
            title: 'Choose SSH or HTTPS authentication',
            body: <>Use an SSH remote (<code>git@github.com:me/docs-site.git</code>) to authenticate with your local SSH key and leave <strong>Token</strong> empty — or use an HTTPS URL with a GitHub Personal Access Token (<code>repo</code> / Contents write scope).</>,
          },
          {
            title: 'Click Publish once',
            body: <>This creates and force-pushes the <code>{branch}</code> branch with the generated site and <code>CNAME</code> file.</>,
          },
          {
            title: 'Enable GitHub Pages & add DNS CNAME',
            body: <>In GitHub, open <strong>Settings → Pages</strong>, choose <strong>Deploy from a branch</strong> → <code>{branch}</code> / <code>(root)</code>. Then add a DNS <code>CNAME</code> record for <code>{domain}</code> pointing to <code>&lt;your-username&gt;.github.io</code> and enable <strong>Enforce HTTPS</strong>.</>,
          },
        ],
        note: 'Public GitHub Pages sites are publicly accessible on the internet. For internal or confidential repositories, host behind authentication instead.',
      };

    case 'cloudflare':
      return {
        title: 'Cloudflare Pages',
        summary: 'Deploys the static site directly to Cloudflare Pages using the official Wrangler CLI via npx (nothing to install manually).',
        steps: [
          {
            title: 'Copy your Account ID',
            body: <>Open <strong>dash.cloudflare.com</strong> and copy the 32-character <strong>Account ID</strong> from the URL (<code>dash.cloudflare.com/&lt;ACCOUNT_ID&gt;/…</code>) or the right-hand sidebar.</>,
          },
          {
            title: 'Create an API token',
            body: <>Go to <strong>My Profile → API Tokens → Create Token → Create Custom Token</strong>, grant permission <code>Account → Cloudflare Pages → Edit</code>, and paste the generated token (a single string with no colons).</>,
          },
          {
            title: 'Create the Pages project once (first time only)',
            body: <>Because publishing runs non-interactively, the project must exist before the first deploy. Create it in <strong>Workers &amp; Pages → Create → Pages → Direct Upload</strong> or run this one-time command:</>,
            snippets: [
              {
                label: 'One-time project creation',
                code: `CLOUDFLARE_API_TOKEN="YOUR_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="${accountId}" npx --yes wrangler pages project create ${project} --production-branch main`,
              },
            ],
          },
          {
            title: 'Click Publish, then attach your custom domain',
            body: <>After the first publish succeeds, open your project in Cloudflare → <strong>Custom domains → Set up a custom domain</strong> and add <code>{domain}</code>. If the domain uses Cloudflare DNS, the CNAME and SSL certificate are created automatically; otherwise add a <code>CNAME</code> to <code>{project}.pages.dev</code>.</>,
          },
        ],
        note: 'For password-protected or team-only docs on Cloudflare Pages, enable Cloudflare Access (Zero Trust) on the custom domain rather than relying on functions/_middleware.js, since static deploys do not bundle Functions.',
      };

    case 'netlify':
      return {
        title: 'Netlify',
        summary: 'Publishes the built static site directly to production via npx netlify-cli deploy --prod.',
        steps: [
          {
            title: 'Create a Netlify site',
            body: <>In Netlify, create an empty site (<strong>Add new site → Deploy manually</strong> once, or select an existing site).</>,
          },
          {
            title: 'Copy the Site ID',
            body: <>Open <strong>Site configuration → General → Site details</strong> and copy the <strong>Site ID</strong>.</>,
          },
          {
            title: 'Create a Personal access token',
            body: <>Go to <strong>User settings → Applications → Personal access tokens → New access token</strong> and paste it into <strong>Personal access token</strong>.</>,
          },
          {
            title: 'Click Publish & connect your subdomain',
            body: <>Under <strong>Domain management → Add a domain</strong>, add <code>{domain}</code> and create a DNS <code>CNAME</code> record pointing to <code>&lt;your-site&gt;.netlify.app</code>. Netlify provisions HTTPS automatically.</>,
          },
        ],
        note: 'Safe4wiki invokes netlify-cli through npx --yes, so you do not need to install it globally.',
      };

    case 'command':
    default:
      return {
        title: 'My own command',
        summary: 'Runs any custom shell command you provide. Safe4wiki replaces {dir} with the temporary folder containing the exported static site and streams output live.',
        steps: [
          {
            title: 'Use {dir} as the exported site path',
            body: <>Safe4wiki exports the full static site into a temporary directory, substitutes <code>{'{dir}'}</code> (automatically quoted), runs your command, and cleans up afterward.</>,
          },
          {
            title: 'Ready-to-use examples',
            body: <>Pick and adapt one of these templates:</>,
            snippets: [
              {
                label: 'SSH / rsync with custom key & port',
                code: `rsync -az --delete -e "ssh -i ~/.ssh/my_key -p ${port} -o BatchMode=yes -o StrictHostKeyChecking=accept-new" {dir}/ ${user}@${host}:${remotePath}/`,
              },
              {
                label: 'Local dry-run test (preview before going live)',
                code: 'rsync -a --delete {dir}/ /tmp/safe4wiki-preview/',
              },
              {
                label: 'AWS S3 bucket',
                code: 'aws s3 sync {dir} s3://my-docs-bucket --delete',
              },
              {
                label: 'Vercel CLI',
                code: 'npx --yes vercel deploy {dir} --prod',
              },
            ],
          },
        ],
        note: 'Any published static site includes instant client-side search across all pages — no Node server or LLM API keys are needed on your host.',
      };
  }
}

export default function PublishHelpModal({ method, methods, target, onSelectMethod, onClose }) {
  const [active, setActive] = useState(method || 'ssh');
  const guide = getGuide(active, target || {});

  const pick = m => {
    setActive(m);
    if (onSelectMethod) onSelectMethod(m);
  };

  return (
    <Dialog
      nested
      wide
      title={`How to publish — ${guide.title}`}
      onClose={onClose}
      footer={<button type="button" className="btn btn-blue" onClick={onClose}>Got it</button>}
    >
      <div className="seg guide-seg">
        {methods.map(([k, l]) => (
          <button key={k} type="button" className={active === k ? 'on' : ''} onClick={() => pick(k)}>{l}</button>
        ))}
      </div>

      <p className="guide-summary">{guide.summary}</p>

      <ol className="guide-steps">
        {guide.steps.map((s, i) => (
          <li key={i}>
            <div className="guide-step-title">{s.title}</div>
            <div className="guide-step-body">{s.body}</div>
            {s.snippets && s.snippets.map((sn, j) => (
              <CopySnippet key={j} label={sn.label} code={sn.code} />
            ))}
          </li>
        ))}
      </ol>

      {guide.note && (
        <div className="guide-note">
          <strong>Good to know:</strong> {guide.note}
        </div>
      )}
    </Dialog>
  );
}
