import { startApp } from "@smithers/ui/solid";
import { createWebRpcClient } from "./rpc/web.js";

startApp(createWebRpcClient);
