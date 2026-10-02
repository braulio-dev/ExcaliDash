import type { SceneElement } from "./elements";
import type { Area } from "./sceneExtras";

// Input shapes for scene operations (see sceneOps.ts).

export type ElementProps = {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  anchor?: "topLeft" | "center";
  text?: string;
  label?: string;
  labelColor?: string;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  rounded?: boolean;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: "left" | "center" | "right";
  groupIds?: string[];
  points?: [number, number][];
  startId?: string | null;
  endId?: string | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  angle?: number;
  link?: string | null;
  locked?: boolean;
  name?: string | null;
  frameId?: string | null;
  // Set by the tool layer once an image has been stored as a drawing file.
  fileId?: string;
};

export type SceneOperation =
  | { op: "add"; element: ElementProps & { type: string } }
  // `ids` applies the same update / deletion to many elements at once.
  | { op: "update"; id?: string; ids?: string[]; set: ElementProps }
  | { op: "delete"; id?: string; ids?: string[] }
  // Put elements in a frame: listed ids, everything inside `area`, or by
  // default everything inside the frame's own bounds.
  | { op: "assign_frame"; frameId: string; ids?: string[]; area?: Area }
  | ({ op: "erase" } & Area)
  | { op: "reorder"; ids: string[]; to: "front" | "back" };

export type TouchedState = Record<string, SceneElement | null>;
