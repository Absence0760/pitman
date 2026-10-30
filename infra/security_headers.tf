# ----------------------------------------------------------------------------
# Response security headers (CloudFront response-headers policies)
#
# Two policies, because the two behaviours serve different things:
#   site: the static SvelteKit site from S3 (default behaviour);
#   api:  JSON from the Lambda (/api/*), where nothing should ever render.
#
# Both set HSTS (2 years, subdomains, no preload: preload is for registrable
# domains, and jaredhoward.com's is not this stack's to set), nosniff,
# X-Frame-Options DENY + frame-ancestors 'none', a strict Referrer-Policy,
# X-XSS-Protection: 0 (the legacy auditor is itself an XSS vector), COOP and
# a Permissions-Policy. `override = true` everywhere, so an origin can never
# weaken them. The CSP text itself is in csp.json, shared with the
# deploy-time guard (scripts/check-csp.mjs).
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

  permissions_policy = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"

  hsts_max_age_seconds = 63072000 # 2 years
}

resource "aws_cloudfront_response_headers_policy" "site" {
  name    = "${local.project}-site-security-headers"
  comment = "Site: CSP (script hash in SvelteKit's meta tag), HSTS, nosniff, DENY framing"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.csp_site
      override                = true
    }
    strict_transport_security {
      access_control_max_age_sec = local.hsts_max_age_seconds
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    xss_protection {
      protection = false
      override   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = local.permissions_policy
      override = true
    }
    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "api" {
  name    = "${local.project}-api-security-headers"
  comment = "API JSON: default-src 'none', HSTS, nosniff, DENY framing"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.csp_api
      override                = true
    }
    strict_transport_security {
      access_control_max_age_sec = local.hsts_max_age_seconds
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    xss_protection {
      protection = false
      override   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = local.permissions_policy
      override = true
    }
    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }
  }
}
