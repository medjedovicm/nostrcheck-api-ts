import cors from "cors";
import express from "express";
import helmet from "helmet";
import config from "config";

import { LoadAPI } from "./routes/routes.js";

const app = express();

app.set("host", process.env.HOSTNAME ?? config.get('server.host'));
app.set("port", process.env.PORT ?? config.get('server.port'));
app.set("env", process.env.ENVIRONMENT ?? config.get('environment'))
app.set("version", process.env.npm_package_version ?? "0.0");
app.set(
	"pubkey",
	process.env.PUBKEY ?? config.get('server.pubkey')
);
app.set('trust proxy',true); 
app.use(express.json({ limit: '25MB' }));
app.use(express.urlencoded({ limit: '25MB', extended: true }));
app.use(helmet());
app.use(cors());

//Load Routes V1
LoadAPI(app, "v1");

//Load Routes V2
LoadAPI(app, "v2");

export default app;
