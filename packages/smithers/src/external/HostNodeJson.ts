export type HostNodeJson =
	| {
			kind: "element";
			tag: string;
			props: Record<string, string>;
			rawProps: Record<string, any>;
			children: HostNodeJson[];
	  }
	| {
			kind: "text";
			text: string;
	  };
