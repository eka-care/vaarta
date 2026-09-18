import type { SessionV2Content } from '@/features/session/types';
import type { PartnerContext } from '../types';

// Lives in additional_data because the API round-trips it, surviving reloads and re-fetches.
export function getPartnerContext(content?: SessionV2Content): PartnerContext | null {
  const context = content?.additional_data?.partner_context;
  if (!context || typeof context !== 'object') return null;

  const { handoff_id, origin } = context as PartnerContext;
  if (!handoff_id || !origin) return null;
  return context as PartnerContext;
}
