// CloudFront Function (cloudfront-js-2.0), viewer request, default behaviour.
// Wired in infra/s3_cloudfront.tf; tested by infra/scripts/cloudfront-functions.test.mjs.
//
// The site is one prerendered page (index.html) plus hashed files under
// _app/. A path without a file extension is a client route: serve
// index.html for it. Without this, S3 (reached through OAC, which can't list
// the bucket) answers a missing key with a 403 XML error. A path with an
// extension goes to S3 as asked, so a missing chunk stays an error instead
// of quietly becoming HTML.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
