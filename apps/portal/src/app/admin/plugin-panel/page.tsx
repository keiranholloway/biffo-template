import { Suspense } from 'react'
import { PluginPanelClient } from './plugin-panel-client'

/**
 * Embeds a plugin's admin surface in an iframe inside the portal's admin
 * layout (biffo-template#2495). Static export: one static route, with the
 * plugin name carried as `?name=` and read client-side.
 */
export default function PluginPanelPage() {
  return (
    <Suspense fallback={null}>
      <PluginPanelClient />
    </Suspense>
  )
}
