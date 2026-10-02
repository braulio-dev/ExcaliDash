import { ChangeError } from "./changes";
import { ImageSourceError } from "./images";
import { SceneOpError } from "./sceneOps";

// Shared MCP tool result helpers. Expected failures (bad operations, undo
// conflicts, unusable images) go back to the model as readable tool errors.

export const ok = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 1) }] });
export const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

export const guard = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SceneOpError || error instanceof ChangeError || error instanceof ImageSourceError) {
      return fail(error.message) as any;
    }
    console.error("[mcp] tool failed:", error);
    return fail("The tool failed on the server. Re-read the drawing and try again.") as any;
  }
};
