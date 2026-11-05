/**
 * Mural projection state: everything the MuralProjector needs to resume after a
 * restart without duplicating widgets. Persisted inside SessionState so it rides
 * the existing session snapshot. Positions are board-absolute Mural coordinates —
 * the canvas model itself stays geometry-free.
 */

/** A canvas item already projected onto the mural. Keyed by canvas id in `widgets`. */
export interface MuralWidgetEntry {
  widgetId: string;
  /** Container the widget was placed in: "bc:<id>", "unplaced", or "hotspots". */
  container: string;
  x: number;
  y: number;
  /** Content at last projection, so no-op canvas upserts don't become PATCHes. */
  text: string;
  kind?: string;
  confidence?: string;
}

/** One area/strip on the board and its slot cursors. */
export interface MuralContainerState {
  /** "bc:<boundedContextId>" or "unplaced". The hotspot strip is not a container. */
  id: string;
  /** Mural area widget id (absent until the area is created on the board). */
  areaWidgetId?: string;
  /** Cached area title, to skip no-op renames. */
  title?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Stickies placed per kind-lane (see layout LANES). */
  laneCounts: number[];
  /** Stickies placed in the overflow rows below the lanes. */
  overflowCount: number;
}

export interface MuralLayoutState {
  containers: Record<string, MuralContainerState>;
  /** X where the next area will be allocated. */
  nextAreaX: number;
  /** Stickies placed in the hotspot strip. */
  hotspotCount: number;
}

export interface MuralProjectionState {
  muralId: string;
  /** The mural's embedLink (a distinct UUID URL minted by Mural, not derivable from
   * muralId). Absent when embedding isn't enabled for the mural. */
  embedUrl?: string;
  /** Canvas items with updatedAtRev <= this are already on the board. */
  lastProjectedRev: number;
  /** Canvas id → projected widget. Areas are keyed "area:<containerId>". */
  widgets: Record<string, MuralWidgetEntry>;
  layout: MuralLayoutState;
}
