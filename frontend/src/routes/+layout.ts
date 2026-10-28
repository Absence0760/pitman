// adapter-static needs every route to be prerenderable. Prerendering the
// whole tree turns the frontend into static files served by S3/CloudFront
// (see infra/s3_cloudfront.tf); the backend API is reached at runtime from
// the browser. If you later add client-only routes that can't be
// prerendered, switch to SPA mode instead: drop this and pass
// `fallback: 'index.html'` to adapter-static in svelte.config.js.
export const prerender = true;
