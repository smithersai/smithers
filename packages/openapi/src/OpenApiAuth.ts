export type OpenApiAuth =
	| {
			type: "bearer";
			token: string;
	  }
	| {
			type: "basic";
			username: string;
			password: string;
	  }
	| {
			type: "apiKey";
			name: string;
			value: string;
			in: "header" | "query";
	  };
