import type { TextareaRenderable } from "@opentui/core";
import React, { useEffect, useRef } from "react";
import { SmithersBroker } from "../../broker/Broker.js";
import {
  parseAttachmentMentions,
  parseWorkflowMentions,
} from "../../shared/format.js";
import { useAppStore } from "../state/store.js";

type ComposerProps = {
  broker: SmithersBroker;
  focused: boolean;
  quietHarbor: boolean;
};

const composerKeyBindings = [
  { name: "return", action: "submit" as const },
  { name: "linefeed", action: "submit" as const },
  { name: "j", ctrl: true, action: "newline" as const },
];

export function Composer({ broker, focused, quietHarbor }: ComposerProps) {
  const textareaRef = useRef<TextareaRenderable>(null);
  const activeWorkspace = useAppStore((state) =>
    state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId),
  );
  const draft = activeWorkspace?.draft ?? "";
  const workflowMentions = parseWorkflowMentions(draft);
  const attachmentMentions = parseAttachmentMentions(draft);
  const lines = Math.max(1, draft.split(/\r?\n/).length);
  const height = Math.min(6, Math.max(3, lines + 2));

  useEffect(() => {
    if (!textareaRef.current) return;
    if (textareaRef.current.plainText !== draft) {
      textareaRef.current.setText(draft);
    }
  }, [draft]);

  return (
    <box
      style={{
        width: "100%",
        height,
        flexDirection: "column",
        borderTop: !quietHarbor,
        borderColor: focused ? "#63b3ed" : "#4a5568",
        paddingTop: 1,
      }}
    >
      <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
        {workflowMentions.length === 0 && attachmentMentions.length === 0 ? (
          <text style={{ color: "#718096" }}>Type a task, or use # to pick a workflow.</text>
        ) : (
          <>
            {workflowMentions.map((workflowId) => (
              <text key={workflowId} style={{ color: "#63b3ed", marginRight: 1 }}>
                [#{workflowId}]
              </text>
            ))}
            {attachmentMentions.map((attachment) => (
              <text key={attachment} style={{ color: "#48bb78", marginRight: 1 }}>
                [@{attachment}]
              </text>
            ))}
          </>
        )}
      </box>
      <textarea
        ref={textareaRef}
        focused={focused}
        width="100%"
        height={Math.max(1, height - 2)}
        placeholder="Ask Smithers to orchestrate work, or type # to run a workflow."
        backgroundColor="transparent"
        focusedBackgroundColor="transparent"
        textColor="#e2e8f0"
        focusedTextColor="#f8fafc"
        keyBindings={composerKeyBindings}
        onInput={(value) => broker.updateDraft(value)}
        onSubmit={() => {
          void broker.sendComposer();
        }}
      />
      <box style={{ width: "100%", height: 1, flexDirection: "row" }}>
        <text style={{ color: "#ecc94b" }}>budget 18k ctx</text>
        <text style={{ color: "#718096" }}>
          {"  "}
          Enter send  Ctrl+J newline  # workflow  Ctrl+O actions
        </text>
      </box>
    </box>
  );
}
