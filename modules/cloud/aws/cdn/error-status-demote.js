// Lambda@Edge ORIGIN-RESPONSE handler (Node.js), loaded into
// aws_lambda_function.error_status_demote (created in infra/global, us-east-1
// — Lambda@Edge functions must live there regardless of the distribution's
// own region) and associated ONLY with the three API cache behaviours
// (api/v1/plugins/*, api/v1/health, c/*). Fixes biffo-template#1529.
//
// THE PROBLEM THIS SOLVES: `custom_error_response` in main.tf is
// distribution-wide — CloudFront gives no way to scope it to a cache
// behaviour (confirmed against the Terraform AWS provider schema:
// `custom_error_response` is a top-level block only, not an argument of
// `ordered_cache_behavior`). It exists to serve the SPA shell for the
// portal/sibling behaviours on a 403/404 (a missing static file), and it
// MUST keep doing that — see rewrite.js and the comment above
// `custom_error_response` in main.tf. But because it is distribution-wide, it
// ALSO intercepts every genuine 403/404 JSON response the API origins
// return, replacing the body with the portal's index.html before it reaches
// the client.
//
// THE FIX: CloudFront evaluates `custom_error_response` against the status
// code as it stands AFTER an origin-response Lambda@Edge trigger runs (this
// is the documented mechanism for "changing the status to bypass an error
// page" — AWS's own example for this trigger is literally "use an origin
// response trigger to update the error status code to 200"). So: on the
// three API behaviours only, when the origin's real status is 403 or 404,
// this function moves it OUT of the range `custom_error_response` is
// listening for (to 200) and stashes the TRUE status in a response header.
// error-status-restore.js (a CloudFront Function on viewer-response, the
// same three behaviours) reads that header and puts the real status back
// before the response reaches the viewer — CloudFront Functions can modify
// `response.statusCode` at viewer-response, but ONLY runs there when the
// status is below 400 (see that file's header), which is exactly why the
// demotion below has to happen first, in a different trigger.
//
// Lambda@Edge origin-response does NOT expose the origin's response body to
// this function at all (AWS docs: "Lambda@Edge does not expose the body...
// to the origin-response trigger"), and this function never sets `body` on
// its own response — so the real JSON the API returned is untouched end to
// end. This function only ever reads/writes `status` and one header.
//
//
// SECOND JOB — an unknown address under /admin/ (portal not-found). The
// portal's `admin` and `admin/*` behaviours carry this same pair. A missing
// portal PAGE would otherwise be a 403/404 from S3, which the distribution-wide
// `custom_error_response` answers with the ROOT sibling's /index.html — for a
// signed-in admin who mistyped an address, the public marketing home page with
// a "Sign in" header, at an /admin/ URL. CloudFront cannot scope that fallback
// per path, so here, on an origin 403/404 for a page document under /admin/
// (the request URI has already been rewritten by rewrite.js to
// `/admin/<route>/index.html`), the response is turned into a 302 to /admin/.
// 302 is outside custom_error_response's range, so it is delivered as-is.
// `/admin/index.html` itself is excluded (a redirect there would loop), and so
// is anything that is not a page document (`_next` assets, `index.txt` RSC
// payloads), which keep the demote/restore behaviour below.
function isAdminPageDocument(uri) {
  if (typeof uri !== 'string') return false
  return uri.startsWith('/admin/') && uri.endsWith('/index.html') && uri !== '/admin/index.html'
}

exports.handler = (event, context, callback) => {
  const cf = event.Records[0].cf
  const response = cf.response
  const status = response.status
  // The request is consulted ONLY by isAdminPageDocument (a fixed /admin/
  // prefix check) — never to branch on a tracked-link token under c/*.
  const uri = cf.request ? cf.request.uri : undefined

  if ((status === '403' || status === '404') && isAdminPageDocument(uri)) {
    response.status = '302'
    response.statusDescription = 'Found'
    response.headers['location'] = [{ key: 'Location', value: '/admin/' }]
    response.headers['cache-control'] = [{ key: 'Cache-Control', value: 'no-store' }]
    callback(null, response)
    return
  }

  if (status === '403' || status === '404') {
    response.headers['x-biffo-true-status'] = [{ key: 'X-Biffo-True-Status', value: status }]
    response.status = '200'
    response.statusDescription = 'OK'
  }

  callback(null, response)
}
