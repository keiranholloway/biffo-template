// CloudFront viewer-request function (runtime cloudfront-js-2.0), loaded into
// aws_cloudfront_function.click_rewrite via file() in main.tf and associated
// ONLY with the opt-in `c/*` tracked-link behaviour. See that resource's
// comment for the full rationale; fixes biffo-plugin-marketing#52.
//
// CloudFront forwards the `c/*` behaviour's viewer path to the Core API
// origin UNCHANGED, so a request for `/c/<token>` reaches API Gateway asking
// for exactly `/c/<token>`. The only route the API declares is
// `GET /api/v1/public/c/{token}` (authorization_type = NONE) — `/c/<token>`
// itself matches nothing and falls through to API Gateway's $default stage,
// which requires a Cognito JWT. The result is a 401 for every tracked link,
// before the request ever reaches the handler that would otherwise answer it
// correctly (a 302 on a good token, the constant public 404 on a bad one).
//
// This function's entire job is that one path rewrite, and it is
// deliberately its OWN function rather than a branch added to
// aws_cloudfront_function.rewrite above: that function's job is Next.js
// static-export routing (directory->index.html, the RSC-payload self-heal)
// and must never touch an API request — the `c/*` behaviour has always said
// so ("No rewrite function") for exactly that reason. This one does the
// opposite kind of rewrite and nothing else.
//
// Security properties this function must not weaken (biffo-plugin-marketing#52):
//   - The token passes through OPAQUE. No validation, no branching on its
//     value or shape, no logging — a function that treated a "plausible"
//     token differently from an "implausible" one would itself become the
//     enumeration oracle the API's constant-404 response exists to prevent.
//     (CloudFront Functions has no console/network access in its production
//     runtime regardless, so there is no channel for a leak even by
//     accident — but the source carries no such call either way.)
//   - No decision about validity is made here at all. Every request that
//     reaches this function (by construction of the `c/*` behaviour it is
//     scoped to) gets the identical, unconditional rewrite; whether the
//     token resolves is left entirely to the Core API handler.
//   - The query string is untouched: this function only ever writes
//     `request.uri`, and CloudFront forwards `request.querystring` to the
//     origin independently of it, so nothing here can drop or leak it.
//
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront invokes handler() by name
function handler(event) {
  var request = event.request
  request.uri = '/api/v1/public' + request.uri
  return request
}
