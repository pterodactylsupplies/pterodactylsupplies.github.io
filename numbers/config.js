// Point this at your deployed Cloudflare Worker.
// After `npx wrangler deploy` it will look like:
//   https://numbers-gallery-api.<your-subdomain>.workers.dev
// For local development with `npx wrangler dev` use:
//   http://localhost:8787
window.CONFIG = {
  API_BASE: "https://numbers-gallery-api.greendegrass.workers.dev",
};
