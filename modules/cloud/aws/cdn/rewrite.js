// CloudFront viewer-request function (runtime cloudfront-js-2.0), loaded into
// aws_cloudfront_function.rewrite via file() in main.tf. Kept as a standalone
// file, not an inline heredoc, so cli/src/lib/cdn-rewrite-function.test.ts can
// execute the handler and assert its behaviour.
//
// It does two things, in order:
//
// 1. Self-heal the Next.js App Router static-export "raw RSC payload" failure.
//    The portal (and every sibling) is `output: 'export'`, so client-side
//    navigation fetches each route's RSC flight payload at `<route>/index.txt`.
//    Next's router compares the build id baked into that payload against the
//    build id the running tab booted with (getAppBuildId()); on a mismatch it
//    assumes the deployment changed underneath it and performs a hard, top-level
//    browser navigation TO THE PAYLOAD URL ITSELF — stranding the user on raw
//    serialised React at `<route>/index.txt`. A build-id skew like that happens
//    whenever a tab is left open across a redeploy (or an edge briefly serves a
//    mixed HTML/`.txt` pair). Content-type alone can't prevent it — see #289 for
//    the content-type arm of the same failure class; this is the build-id arm.
//
//    A genuine RSC fetch sets `Sec-Fetch-Dest: empty`; only a real top-level
//    document navigation sets it to `document`. So we redirect ONLY document
//    navigations of `<route>/index.txt` to the clean route, turning the dead-end
//    into a fresh, consistent-build full page load that heals the skew. The
//    router's own RSC fetches pass straight through untouched.
//
// 2. Directory-style routes (no file extension) map to their static index.html,
//    since S3 has no directory-index behaviour of its own.
//
// CloudFront Functions splits a request's query string off `request.uri`
// (which is path-only) into a separate `request.querystring` object, shaped
// `{ key: { value } }` — or `{ key: { multiValue: [{ value }, ...] } }` for a
// repeated key — never a raw string. Re-serialise it for use in a Location
// header; a plain string concatenation of `request.uri` alone silently drops
// it (issue #961), which strands query-param-dependent routes (e.g. a
// marketplace's `/brand/?slug=<x>`) on the bare path with no param.
function serializeQueryString(querystring) {
  var pairs = []
  for (var key in querystring) {
    if (!Object.prototype.hasOwnProperty.call(querystring, key)) continue
    var entry = querystring[key]
    if (entry && entry.multiValue) {
      for (var i = 0; i < entry.multiValue.length; i++) {
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(entry.multiValue[i].value))
      }
    } else if (entry && typeof entry.value !== 'undefined') {
      pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(entry.value))
    }
  }
  return pairs.length ? '?' + pairs.join('&') : ''
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront invokes handler() by name
function handler(event) {
  var request = event.request
  var uri = request.uri

  if (uri.endsWith('/index.txt')) {
    var dest = request.headers['sec-fetch-dest']
    if (dest && dest.value === 'document') {
      return {
        statusCode: 302,
        statusDescription: 'Found',
        headers: {
          location: {
            value:
              uri.slice(0, uri.length - 'index.txt'.length) +
              serializeQueryString(request.querystring),
          },
          'cache-control': { value: 'no-store' },
        },
      }
    }
  }

  if (!uri.includes('.')) {
    request.uri = uri.replace(/\/?$/, '/index.html')
  }

  return request
}
