/**
 * The synthesized knowledge of a session: EventStorming stickies plus one or more
 * Bounded Context Canvases. Produced exclusively by the Synthesizer agent and rendered
 * read-only in the UI. The same types are the contract between server and web.
 */

export type StickyKind =
  | "domainEvent" // orange  – something that happened
  | "command" // blue    – triggers an event
  | "actor" // yellow  – person/role issuing a command
  | "policy" // lilac   – "whenever X then Y"
  | "readModel" // green   – info an actor needs to decide
  | "externalSystem" // pink    – outside the boundary
  | "hotspot" // red     – conflict / question / risk
  | "aggregate"; // pivotal yellow – consistency boundary

export const STICKY_KINDS: StickyKind[] = [
  "domainEvent",
  "command",
  "actor",
  "policy",
  "readModel",
  "externalSystem",
  "hotspot",
  "aggregate",
];

export type Confidence = "low" | "medium" | "high";

export type LinkRelation = "triggers" | "raises" | "invokes" | "reads";

export interface StickyLink {
  toId: string;
  relation: LinkRelation;
}

export interface Sticky {
  id: string;
  kind: StickyKind;
  text: string;
  confidence: Confidence;
  /** Which transcript chunk ids justified this sticky (provenance). */
  sourceChunkIds: string[];
  /** Loose left-to-right ordering on the timeline. */
  order?: number;
  links?: StickyLink[];
  boundedContextId?: string;
  createdAtRev: number;
  updatedAtRev: number;
}

export interface UbiquitousTerm {
  term: string;
  definition: string;
}

export interface ContextMessage {
  name: string;
  /** Counterparty: source for inbound, target for outbound. */
  party: string;
  via?: string;
}

export type DomainKind = "core" | "supporting" | "generic";
export type Evolution = "genesis" | "custom" | "product" | "commodity";

export interface StrategicClassification {
  domain: DomainKind;
  businessModel?: string;
  evolution?: Evolution;
}

/** Bounded Context Canvas (Nick Tune template, trimmed to demo-useful fields). */
export interface BoundedContextCanvas {
  id: string;
  name: string;
  purpose: string;
  strategicClassification: StrategicClassification;
  inboundCommunication: ContextMessage[];
  outboundCommunication: ContextMessage[];
  ubiquitousLanguage: UbiquitousTerm[];
  businessDecisions: string[];
  assumptions: string[];
  openQuestions: string[];
  stickyIds: string[];
  confidence: Confidence;
  createdAtRev: number;
  updatedAtRev: number;
}

export interface Hotspot {
  id: string;
  text: string;
  sourceChunkIds: string[];
}

export interface Canvas {
  stickies: Sticky[];
  boundedContexts: BoundedContextCanvas[];
  /** Top-level unresolved items the Synthesizer wants the room to address. */
  hotspots: Hotspot[];
  lastUpdatedRev: number;
}

export function emptyCanvas(): Canvas {
  return { stickies: [], boundedContexts: [], hotspots: [], lastUpdatedRev: 0 };
}
