-- MCP: admin kill-switch plus the per-drawing log of AI edits used for undo/redo.
ALTER TABLE "SystemConfig" ADD COLUMN "mcpEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "AgentChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "drawingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "agentColor" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "before" TEXT NOT NULL,
    "after" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "undoneAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentChange_drawingId_fkey" FOREIGN KEY ("drawingId") REFERENCES "Drawing" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AgentChange_drawingId_createdAt_idx" ON "AgentChange"("drawingId", "createdAt");
CREATE INDEX "AgentChange_createdAt_idx" ON "AgentChange"("createdAt");
