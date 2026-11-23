// Starts the scrape at 07:00 and 15:00 UTC. GitHub's own schedule for this repository fires
// hours late, or not at all (it is best effort), so this Cloudflare Worker asks GitHub to run
// the workflow instead, as the "Run workflow" button would.
//
// GITHUB_TOKEN is a fine-grained token for this repository only, with Actions read and
// write: `npx wrangler secret put GITHUB_TOKEN` in this folder. Deploy with
// `npx wrangler deploy`.

const REPO = 'MrSunshyne/mauritius-dataset-reservoirs';
const WORKFLOW = 'scrape.yml';

export default {
  async scheduled(controller, env) {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mauritius-dataset-reservoirs-trigger',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    // 204 is GitHub's yes. Anything else is thrown, so it shows as a failed run in the
    // Worker's logs (an expired token, say).
    if (r.status !== 204) throw new Error(`GitHub answered ${r.status}: ${await r.text()}`);
  },
};
