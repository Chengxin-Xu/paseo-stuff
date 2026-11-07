import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ReasoningActivity, ToolActivity } from "./client/activity";
import { transformReasoning, transformToolCall } from "./client/transform";
import { TOOL_CALL_RENDERER_KIND, TOOL_CALL_RENDERER_VERSION, toolCallItemDataSchema,
  REASONING_RENDERER_KIND, REASONING_RENDERER_VERSION, reasoningItemDataSchema } from "./shared/timeline";

export default function contribute(client: PluginClientContext) {
  // Paseo (checked through 0.15.3) exposes no public display-mode/group context, so cards bypass
  // tool-call grouping and turn folding. Never change the host preference or guess it from private
  // app state; the user switches this client to native rows instead. Since 0.14 grouping also
  // absorbs reasoning, so native rows restore native Thinking too. The choice is client-local and
  // resets on reload.
  let removeAdapters: (() => void) | undefined;
  function useCards() {
    if (removeAdapters) return;
    const removeTools = client.addTimelineTransformer({ id: "tool-calls", query: { itemType: "tool_call" }, transform: transformToolCall });
    const removeThinking = client.addTimelineTransformer({ id: "reasoning", query: { itemType: "reasoning" }, transform: transformReasoning });
    removeAdapters = () => { removeThinking(); removeTools(); };
  }
  function useNativeRows() {
    removeAdapters?.();
    removeAdapters = undefined;
  }
  const remove = [
    client.addTimelineRenderer({ kind: TOOL_CALL_RENDERER_KIND, version: TOOL_CALL_RENDERER_VERSION, schema: toolCallItemDataSchema, Component: ToolActivity }),
    client.addTimelineRenderer({ kind: REASONING_RENDERER_KIND, version: REASONING_RENDERER_VERSION, schema: reasoningItemDataSchema, Component: ReasoningActivity }),
    client.addCommandCenterItem({
      id: "native-tool-rows", title: "Activity: use native rows (Collapse or Summary)", icon: "List", context: "global",
      keywords: ["activity", "summary", "collapse", "turns", "tool", "thinking", "native"], onSelect: useNativeRows,
    }),
    client.addCommandCenterItem({
      id: "tool-cards", title: "Activity: use tool cards (Full display)", icon: "LayoutList", context: "global",
      keywords: ["activity", "full", "full detail", "tool", "cards"], onSelect: useCards,
    }),
  ];
  useCards();
  return () => { useNativeRows(); for (const cleanup of remove.reverse()) cleanup(); };
}
