import { MicroservicesList } from '@/components/MicroservicesList'

// The portal's landing page is the Microservices tab (ADR-0007) — same content
// as /admin/microservices, so the first nav item and the default landing agree.
export default function AdminPage() {
  return <MicroservicesList />
}
