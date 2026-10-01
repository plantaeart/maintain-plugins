/** Commands this extension registers. */
export enum ExtensionCommand {
	UPDATES_CHECK = "maint-updates-check",
	UPDATE_ALL = "maint-update-all",
	UNINSTALL_PLUGIN = "maint-uninstall-plugin",
}

export interface ExtensionCommandMetadata {
	command: ExtensionCommand;
	description: string;
	usage: string;
}

export const EXTENSION_COMMAND_CATALOG: Record<
	ExtensionCommand,
	ExtensionCommandMetadata
> = {
	[ExtensionCommand.UPDATES_CHECK]: {
		command: ExtensionCommand.UPDATES_CHECK,
		description: "Check installed plugin versions against npm (read-only)",
		usage: "/maint-updates-check",
	},
	[ExtensionCommand.UPDATE_ALL]: {
		command: ExtensionCommand.UPDATE_ALL,
		description: "Update every stale plugin to its latest version",
		usage: "/maint-update-all",
	},
	[ExtensionCommand.UNINSTALL_PLUGIN]: {
		command: ExtensionCommand.UNINSTALL_PLUGIN,
		description: "Remove an installed plugin, after confirming",
		usage: "/maint-uninstall-plugin",
	},
};

/** Lifecycle event names shared with the host. */
export enum ExtensionEventType {
	SessionStart = "session_start",
	/** Fired at the end of each turn; the first one means the user has typed. */
	TurnEnd = "turn_end",
}
