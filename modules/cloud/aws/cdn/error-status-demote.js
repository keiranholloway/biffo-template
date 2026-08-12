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
exports.handler = (event, context, callback) => {
  const response = event.Records[0].cf.response
  const status = response.status

  if (status === '403' || status === '404') {
    response.headers['x-biffo-true-status'] = [{ key: 'X-Biffo-True-Status', value: status }]
    response.status = '200'
    response.statusDescription = 'OK'
  }

  callback(null, response)
}
