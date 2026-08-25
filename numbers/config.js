// Point this at your deployed Cloudflare Worker.
// After `npx wrangler deploy` it will look like:
//   https://numbers-gallery-api.<your-subdomain>.workers.dev
// For local development with `npx wrangler dev` use:
//   http://localhost:8787
// SHARE_BASE is the address share links point at. It has to be the worker,
// since only the worker can serve a per-photo link preview — see /p/<id>
// there. Usually the same as API_BASE; it exists separately so it can move to
// a custom domain (numbers.pterodactyl.supplies) without touching anything
// else. Falls back to API_BASE when unset.
window.CONFIG = {
  API_BASE: "https://numbers-gallery-api.greendegrass.workers.dev",
  SHARE_BASE: "https://numbers-gallery-api.greendegrass.workers.dev",
};
