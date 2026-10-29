// CloudFront Function (cloudfront-js-2.0), viewer request, /api/* behaviour.
// Wired in infra/s3_cloudfront.tf; tested by infra/scripts/cloudfront-functions.test.mjs.
//
// The browser calls same-origin /api/<route>; the Hono app routes on
// /<route> (backend/src/app.ts, as in local dev, where the frontend calls the
// backend on :3001 directly). Strip the prefix before the request reaches the
// Lambda Function URL. The query string is a separate field and is untouched.
function handler(event) {
  var request = event.request;
  request.uri = request.uri.substring(4) || '/';
  return request;
}
