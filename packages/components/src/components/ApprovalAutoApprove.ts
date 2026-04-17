export type ApprovalAutoApprove = {
	after?: number;
	condition?: ((ctx: any) => boolean) | (() => boolean);
	audit?: boolean;
	revertOn?: ((ctx: any) => boolean) | (() => boolean);
};
