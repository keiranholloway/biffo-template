import Link from 'next/link'

// A minimal PUBLIC page — the go-live default.
//
// There is no auth code here, and that is the whole point: anything you drop
// under src/app/ is served unauthenticated the moment it deploys. Delete this
// route once you've seen how it works, or copy it as the starting point for
// your own public content. To make a page private instead, wrap it in
// <AuthGate> — see ./members/page.tsx.
export default function ExamplePublicPage() {
  return (
    <main className="center-screen">
      <div>
        <h1>This page is public</h1>
        <p>
          Anyone can see it — no login, no redirect. This is how most of your app ships at go-live.
        </p>
        <p>
          <Link href="/example/members/">See the same pattern, but auth-gated →</Link>
        </p>
      </div>
    </main>
  )
}
