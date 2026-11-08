# ----------------------------------------------------------------------------
# Response security headers (CloudFront Functions, viewer response)
#
# One function per behaviour, because the two serve different things:
#   site: the static SvelteKit site from S3 (default behaviour);
#   api:  JSON from the Lambda (/api/*), where nothing should ever render.
# Both are rendered from one template, functions/security_headers.js.tftpl,
# with that behaviour's CSP from csp.json (shared with the deploy-time guard,
# scripts/check-csp.mjs).
#
# Both set HSTS (2 years, subdomains, no preload: preload is for registrable
# domains, and jaredhoward.com's is not this stack's to set), nosniff,
# X-Frame-Options DENY + frame-ancestors 'none', a strict Referrer-Policy,
# X-XSS-Protection: 0 (the legacy auditor is itself an XSS vector), COOP and
# a Permissions-Policy, each overwriting the origin's, so an origin can never
# weaken them.
#
# ---- Why a function and not a response headers policy (R4-I14) ----
#
# These were two aws_cloudfront_response_headers_policy resources until
# 2026-11-07. CloudFront's flat-rate Free and Pro plans allow only the
# AWS-managed ("default") response headers policies; a custom one, which a
# custom CSP needs, takes the $200 Business plan (CloudFront Developer Guide,
# "CloudFront flat-rate pricing plans", features by tier). A function sets
# the same headers on every plan, so the optional Pro plan (infra/README.md § Cost)
# doesn't depend on them. The cost: $0.10 per million viewer responses on
# pay-as-you-go (nothing on a plan), and one difference, below.
#
# CloudFront doesn't invoke a viewer-response function when the origin
# answers 400 or more (Developer Guide, "Restrictions on all edge
# functions", HTTP status codes). So:
#   - API errors (401, 403, 404, 413, 422, 429, 503 JSON from the Lambda)
#     keep the headers because the app sets the same "api" set on every
#     response itself (backend/src/http/securityHeaders.ts, whose test
#     compares it with csp.json and the template). On a 2xx/3xx the function
#     overwrites them with identical values.
#   - Site errors are S3's own: a 403 AccessDenied XML for a path with an
#     extension that isn't in the bucket (spa_rewrite sends every other path
#     to a real page). Those now go without the headers. They are S3's fixed
#     text, never HTML that renders, and HSTS is already pinned by any
#     earlier response, so nothing a browser acts on is lost.
#   - CloudFront's own answers (a WAF block's 403, the http -> https
#     redirect, a 502/504) run no function either. Whether the response
#     headers policies reached those wasn't checked before the move.
# The function also has a 10 KB size limit; the rendered code is about 2 KB
# and a terraform test pins it under 10 KB.
#
# ---- Why the site CSP is split between this header and a <meta> tag ----
#
# Measured on the Round 4 build (2026-10-29, adapter-static, SvelteKit 3,
# Vite 8): index.html carries exactly ONE inline <script>, SvelteKit's
# bootstrap (it sets __sveltekit_<id> and imports the entry chunks). Its text
# embeds the content-hashed chunk names and the build version, so its sha256
# changes on every build. A hash pinned in this header would break the site
# on the next deploy, and rewriting the policy from the deploy job would mean
# Terraform drift and a much broader deploy role. SvelteKit has no option to
# move the bootstrap into a file.
#
# So the policy is two layers the browser enforces TOGETHER (a resource loads
# only if every delivered policy allows it):
#
#   1. This header: everything that must not depend on the build, including
#      connect-src 'self' (same-origin /api only), frame-ancestors (ignored
#      in <meta>), object-src 'none', and `script-src 'self' 'unsafe-inline'`.
#   2. SvelteKit's own <meta http-equiv="content-security-policy"> with
#      `script-src 'self' 'sha256-<bootstrap>'`, computed per build when
#      `csp: { mode: 'hash', directives: { 'script-src': ['self'] } }` is set
#      in frontend/vite.config.ts's sveltekit({...}) (verified: that build
#      emits the meta tag with the bootstrap's hash).
#
# The effective script policy is the intersection: same-origin files plus the
# one hashed bootstrap. An injected inline script passes the header but fails
# the meta policy, so 'unsafe-inline' here is NOT the effective policy, as
# long as the meta tag exists. deploy-frontend.yml runs scripts/check-csp.mjs
# on the build and refuses to deploy any HTML whose inline scripts are not all
# hashed in a meta CSP, so that can't silently regress. Same as IC-WBT
# (project-water-management infra/security_headers.tf).
#
# No 'unsafe-eval' anywhere: the bundle has no eval or new Function (grep of
# the build), and uPlot needs neither.
#
# style-src is strict too, unlike IC-WBT's ('unsafe-inline'):
#   - Svelte 5 sets dynamic styles through the CSSOM (`dom.style.cssText`,
#     svelte/internal/client/dom/elements/style.js) and uPlot 1.6.32 only
#     through `el.style.<prop> = ...`; CSP does not govern either.
#   - The component CSS is emitted as files (_app/immutable/assets/*.css).
#   - The one inline style in the built HTML is app.html's
#     `<div style="display: contents">`, allowed by its hash under
#     'unsafe-hashes' (which permits hashed style ATTRIBUTES; without it a hash
#     only covers <style> elements).
#   - SvelteKit's route announcer (kit/src/runtime/components/root.svelte) adds
#     one more when the app mounts, so its hash is in csp.json too. It is not in
#     the built HTML, so check-csp.mjs can't see it; frontend/e2e/map.spec.ts
#     runs under this policy and fails if a Kit upgrade changes that style.
#   check-csp.mjs fails the deploy if the build gains a style attribute or a
#   <style> element whose hash isn't in csp.json, naming the hash to add.
#
# No data:, blob: or third-party origin: the build loads nothing but its own
# files, the run worker is a same-origin module (_app/immutable/workers/),
# and downloads use an <a download> on a blob: URL, which CSP doesn't block.
# Round 5's map holds to this: MapLibre's worker is a page-build chunk
# (frontend/vite.config.ts), tiles are same-origin under /tiles/*, and its data:
# zoom icons are replaced by text (lib/map/maplibre-theme.css, R5-M6).
# ----------------------------------------------------------------------------


locals {
  csp = jsondecode(file("${path.module}/csp.json"))

  csp_site = join("; ", [for d in local.csp.site : join(" ", d)])
  csp_api  = join("; ", [for d in local.csp.api : join(" ", d)])

  # Each behaviour's function code: the template with its name and CSP as
  # JSON string literals. Read by the two functions below and by the tests.
  security_headers_code = {
    for behaviour, csp in { site = local.csp_site, api = local.csp_api } :
    behaviour => templatefile("${path.module}/functions/security_headers.js.tftpl", {
      behaviour = jsonencode(behaviour)
      csp       = jsonencode(csp)
    })
  }
}

# Two functions, not one shared: the flat-rate plans forbid sharing a
# function between distributions (there is one), and each behaviour's code
# then carries only its own CSP.
resource "aws_cloudfront_function" "site_headers" {
  name    = "${local.project}-site-headers"
  runtime = "cloudfront-js-2.0"
  comment = "Site security headers: CSP (script hash in SvelteKit's meta tag), HSTS, nosniff, DENY framing"
  publish = true
  code    = local.security_headers_code["site"]
}

resource "aws_cloudfront_function" "api_headers" {
  name    = "${local.project}-api-headers"
  runtime = "cloudfront-js-2.0"
  comment = "API security headers: default-src 'none', HSTS, nosniff, DENY framing"
  publish = true
  code    = local.security_headers_code["api"]
}
