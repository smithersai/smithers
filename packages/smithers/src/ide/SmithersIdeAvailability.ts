export type SmithersIdeAvailability =
	| {
			readonly available: true;
			readonly binaryAvailable: true;
			readonly binaryPath: string;
			readonly environmentActive: true;
			readonly reason: "available";
			readonly signals: readonly string[];
	  }
	| {
			readonly available: false;
			readonly binaryAvailable: boolean;
			readonly binaryPath: string | null;
			readonly environmentActive: boolean;
			readonly reason: "binary-missing" | "environment-inactive";
			readonly signals: readonly string[];
	  };
