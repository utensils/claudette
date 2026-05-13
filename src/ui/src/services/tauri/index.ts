// Domain barrel for Tauri IPC service modules. During the incremental split,
// `../tauri.ts` remains the compatibility entrypoint for existing imports;
// once extraction is complete, that shim re-exports this barrel.
export * from "./apps";
export * from "./auth";
export * from "./chat";
export * from "./chatSessions";
export * from "./checkpoints";
export * from "./debug";
export * from "./files";
export * from "./diff";
export * from "./fileMentions";
export * from "./initialData";
export * from "./metrics";
export * from "./notifications";
export * from "./pinnedPrompts";
export * from "./plan";
export * from "./remoteControl";
export * from "./repository";
export * from "./settings";
export * from "./pty";
export * from "./terminal";
export * from "./shell";
export * from "./slashCommands";
export * from "./updater";
export * from "./usage";
export * from "./workspace";
export * from "./worktrees";
