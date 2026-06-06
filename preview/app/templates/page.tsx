import {loadTemplates} from '@/lib/templates';
import {TemplateGallery} from '@/components/TemplateGallery';

// Read manifests + preview files fresh on each request (a dropped-in template
// shows up without a rebuild).
export const dynamic = 'force-dynamic';

export default function TemplatesPage() {
  const templates = loadTemplates();
  return <TemplateGallery templates={templates} />;
}
