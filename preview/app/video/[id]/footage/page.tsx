import {redirect} from 'next/navigation';

// Studio v3 M6 (T5): /footage is superseded by the scene-major /scenes accordion.
// The legacy gate name 'scenes' already covers this surface (GateHeader CHAIN,
// the hub link). Permanent redirect so any bookmark / deep-link lands on the
// real gate. (The old FootageGate component is retained but no longer routed.)
export default async function FootageRedirect({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  redirect(`/video/${id}/scenes`);
}
