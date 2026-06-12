import {loadTemplates} from '@/lib/templates';
import {buildGalleryPayload} from '@/lib/marketplace-server';
import {TemplateGallery} from '@/components/TemplateGallery';

// Read manifests + preview files fresh on each request (a dropped-in template
// shows up without a rebuild).
export const dynamic = 'force-dynamic';

export default function TemplatesPage() {
  const templates = loadTemplates();
  // Task 2: assemble the unified-item bag for Task 3's gallery rewrite.
  // We pass BOTH the legacy `templates` (keeps the current gallery rendering)
  // AND the new `galleryBag` (consumed by Task 3). This is the simplest bridge
  // that keeps typecheck green and the page rendering through the transition.
  const galleryBag = buildGalleryPayload(templates);
  return <TemplateGallery templates={templates} galleryBag={galleryBag} />;
}
