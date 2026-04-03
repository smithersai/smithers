import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import React from "react";
import { SmithersBroker } from "./broker/Broker.js";
import { TuiAppV2 } from "./client/app/TuiAppV2.js";

async function main() {
  const broker = new SmithersBroker({ rootDir: process.cwd() });
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  await new Promise((resolve) => {
    root.render(
      React.createElement(TuiAppV2, {
        broker,
        onExit: () => {
          broker.stop();
          resolve(true);
        },
      })
    );
  });

  renderer.destroy();
  process.exit(0);
}

main().catch(console.error);
