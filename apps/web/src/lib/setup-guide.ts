/**
 * Personalized post-purchase setup guide (pure function, no I/O).
 * The wizard passes already-translated section bodies (literal i18n keys,
 * so the UI-strings lint covers them) and the buyer's choices; this
 * function only assembles them into markdown in the right order.
 * Nothing here invents a price, a DNS record, or an availability verdict:
 * the subdomain fee is owner-set, DNS values come from the buyer's own
 * inputs, and connection results come from the server check endpoint.
 */
export type SetupDomain = 'own' | 'subdomain' | 'free';
export type SetupHosting = 'vps' | 'free';

export interface SetupGuideStrings {
  intro: string;
  titleDomain: string;
  titleHosting: string;
  titleConnection: string;
  titleFinal: string;
  domainOwnNote: string;
  domainSubNote: string;
  domainFreeNote: string;
  hostingVpsNote: string;
  freeStaticBody: string;
  freeRuntimeBody: string;
  capacityNote: string;
  connectionGuide: string;
  finalDemo: string;
  finalClean: string;
  subdomainFeeNote: string;
  ownHostnameLine: string;
  subHostnameLine: string;
  vpsIpLine: string;
}

export interface SetupGuideInput {
  slug: string;
  version: string;
  isStatic: boolean;
  sizeLabel: string | null;
  domain: SetupDomain;
  ownHostname: string;
  subdomainHostname: string;
  hosting: SetupHosting;
  variant: 'demo' | 'clean';
  vpsIp: string;
  connectionLine: string | null;
  s: SetupGuideStrings;
}

export function buildSetupGuide(input: SetupGuideInput): string {
  const { s } = input;
  const lines: string[] = [`# ${input.slug} — ${input.version}`, '', s.intro, ''];
  lines.push(`## ${s.titleDomain}`, '');
  if (input.domain === 'own') {
    lines.push(s.domainOwnNote);
    if (input.ownHostname) lines.push('', s.ownHostnameLine.replace('{host}', input.ownHostname));
  } else if (input.domain === 'subdomain') {
    lines.push(s.domainSubNote, '', s.subHostnameLine.replace('{host}', input.subdomainHostname), '', s.subdomainFeeNote);
  } else {
    lines.push(s.domainFreeNote);
  }
  lines.push('', `## ${s.titleHosting}`, '');
  if (input.hosting === 'vps') {
    lines.push(s.hostingVpsNote);
  } else if (input.isStatic) {
    lines.push(s.freeStaticBody);
  } else {
    lines.push(s.freeRuntimeBody);
    if (input.sizeLabel) lines.push('', s.capacityNote.replace('{size}', input.sizeLabel));
  }
  const hostname = input.domain === 'subdomain' ? input.subdomainHostname : input.ownHostname;
  if (input.hosting === 'vps' && hostname) {
    lines.push('', `## ${s.titleConnection}`, '', s.connectionGuide);
    if (input.vpsIp) lines.push('', s.vpsIpLine.replace('{ip}', input.vpsIp));
    if (input.connectionLine) lines.push('', input.connectionLine);
  }
  lines.push('', `## ${s.titleFinal}`, '', input.variant === 'demo' ? s.finalDemo : s.finalClean);
  return lines.join('\n') + '\n';
}
