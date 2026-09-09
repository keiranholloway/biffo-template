/**
 * Starter founder-facing surface (`user_frontend`, ADR-0021 §2). Served
 * UNAUTHENTICATED by the shared plugin host at
 * `/api/v1/plugins/example-plugin/ui/` — unlike web-admin's `App`, there is no
 * session to read here: `required_group` on the manifest's `user_frontend`
 * block does not gate this shell (see docs/guides/plugins.md), so this screen
 * must not assume a signed-in caller.
 *
 * It exists to prove the `user_frontend` bundle actually builds and renders
 * something that names the plugin — not to be a feature. Replace it with this
 * plugin's own founder-facing UI.
 */
export default function App() {
  return (
    <main className="page">
      <h1>example-plugin</h1>
      <p className="muted">
        This is the founder-facing starter screen for the example-plugin plugin. Replace it with
        this plugin&apos;s own UI.
      </p>
    </main>
  )
}
