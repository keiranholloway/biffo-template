// CloudFront viewer-response function (runtime cloudfront-js-2.0), loaded
// into aws_cloudfront_function.error_status_restore via file() in main.tf and
// associated ONLY with the three API cache behaviours (api/v1/plugins/*,
// api/v1/health, c/*) — the second half of the fix for biffo-template#1529.
// See error-status-demote.js's header for the full mechanism this completes.
//
// error-status-demote.js (Lambda@Edge, origin-response) demotes a real
// 403/404 from an API origin to 200 and stashes the true status in the
// `x-biffo-true-status` response header, so that CloudFront's
// distribution-wide `custom_error_response` — built for the portal/sibling
// SPA fallback, and left completely untouched by this fix — never sees a
// 403/404 from these three behaviours and so never substitutes their real
// JSON bodies with the portal's index.html.
//
// This function runs after that, at viewer-response, and undoes the
// demotion: if the stash header is present, it restores the TRUE status code
// (CloudFront Functions can read and write `response.statusCode` at
// viewer-response) and removes the header so it never reaches the client.
// This has to be a separate, later stage: a CloudFront Function at
// viewer-response does not run at all when the response status is 400 or
// above (AWS docs: "If the origin returns an HTTP error of 400 and above,
// the CloudFront Function will not run") — which is exactly why the true
// 403/404 could not simply be left in place for this function to fix up
// directly; it has to arrive here already demoted below 400.
//
// It never touches `response.body` — CloudFront Functions do not have
// access to the response body at all at viewer-response (per AWS docs), so
// the real JSON the origin returned, passed through untouched by
// error-status-demote.js, is untouched here too.
//
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront invokes handler() by name
function handler(event) {
  var response = event.response
  var trueStatus = response.headers['x-biffo-true-status']

  if (trueStatus && trueStatus.value) {
    response.statusCode = parseInt(trueStatus.value, 10)
    response.statusDescription = trueStatus.value === '403' ? 'Forbidden' : 'Not Found'
    delete response.headers['x-biffo-true-status']
  }

  return response
}
