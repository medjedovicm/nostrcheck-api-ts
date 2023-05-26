import crypto from "crypto";
import { Request, Response } from "express";

import app from "../app";
import { connect } from "../lib/database";
import { logger } from "../lib/logger";
import { ParseAuthEvent } from "../lib/nostr/NIP98";
import { requestQueue } from "../lib/transform";
import {
	allowedMimeTypes,
	asyncTask,
	ConvertFilesOpions,
	MediaResultMessage,
	mime_transform,
	ResultMessage,
	UploadStatus,
	UploadTypes
} from "../types";
import fs from "fs";

const Uploadmedia = async (req: Request, res: Response): Promise<Response> => {
	logger.info("POST /api/v1/media", "|", req.socket.remoteAddress);

	//Check if event authorization header is valid (NIP98)
	const EventHeader = await ParseAuthEvent(req);
	if (!EventHeader.result) {
		logger.warn(
			`RES -> 401 unauthorized - ${EventHeader.description}`,
			"|",
			req.socket.remoteAddress
		);
		const result: ResultMessage = {
			result: false,
			description: EventHeader.description,
		};

		return res.status(401).send(result);
	}

	//Check if username exist
	if (!req.body.username) {
		logger.warn("username not specified, switching to public upload | ", req.socket.remoteAddress);
		req.body.username = "public";
	}

	//Check if username lenght is valid
	if (req.body.username.length > 50 ) {
		logger.warn(`RES -> 400 Bad request - username too long`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "username too long",
		};

		return res.status(400).send(result);
	}
	logger.info("username ->", req.body.username, "|", req.socket.remoteAddress);

	//Check if pubkey and username are registered
	let pubkey = EventHeader.pubkey;
	const db = await connect();
	const [dbResult] = await db.query("SELECT hex, username FROM registered WHERE hex = ? and username = ? and domain = ?", [pubkey, req.body.username, req.hostname]);
	const rowstemp = JSON.parse(JSON.stringify(dbResult));

	if (rowstemp[0] == undefined) {
		//If not registered the upload will be public and a warning will be logged
		logger.warn("pubkey not registered, switching to public upload | ", req.socket.remoteAddress);
		req.body.username = "public";
		pubkey = app.get("pubkey");
	}
	logger.info("pubkey ->", pubkey, "|", req.socket.remoteAddress);
	logger.info("username ->", req.body.username, "|", req.socket.remoteAddress);

	//Check if upload type exists
	let uploadtype = req.body.uploadtype;
	if (!uploadtype) {
		//If upload type is not specified will be "media" and a warning will be logged
		logger.warn(`RES -> 400 Bad request - missing uploadtype`, "|", req.socket.remoteAddress);
		logger.warn("assuming uploadtype = media");
		req.body.uploadtype = "media";
		uploadtype = "media";
	}

	//Check if upload type is valid
	if (!UploadTypes.includes(uploadtype)) {
		logger.warn(`RES -> 400 Bad request - incorrect uploadtype`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "incorrect upload type",
		};

		return res.status(400).send(result);
	}
	logger.info("type ->", uploadtype, "|", req.socket.remoteAddress);

	//Check if file exist on POST message
	const file = req.file;
	if (!file) {
		logger.warn(`RES -> 400 Bad request - Empty file`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "Empty file",
		};

		return res.status(400).send(result);
	}

	//Check if filetype is allowed
	if (!allowedMimeTypes.includes(file.mimetype)) {
		logger.warn(
			`RES -> 400 Bad request - `,
			file.mimetype,
			` filetype not allowed`,
			"|",
			req.socket.remoteAddress
		);
		const result: ResultMessage = {
			result: false,
			description: "filetype not allowed",
		};

		return res.status(400).send(result);
	}
	logger.info("mime ->", file.mimetype, "|", req.socket.remoteAddress);

	//Standard conversion options
	const fileoptions: ConvertFilesOpions = {
		id: "",
		username: req.body.username,
		width: 1280,
		height: 960,
		uploadtype,
		originalmime: file.mimetype,
		outputmime: mime_transform[file.mimetype],
		outputname: req.hostname + "_" + crypto.randomBytes(24).toString("hex"),
	};

	//Avatar conversion options
	if (fileoptions.uploadtype.toString() === "avatar"){
		fileoptions.width = 400;
		fileoptions.height = 400;
		fileoptions.outputname = "avatar";
	}

	//Banner conversion options
	if (fileoptions.uploadtype.toString() === "banner"){
		fileoptions.width = 900;
		fileoptions.height = 300;
		fileoptions.outputname = "banner";
	}

	//Add file to userfiles table
	try{
		const createdate = new Date(Math.floor(Date.now())).toISOString().slice(0, 19).replace("T", " ");
		await db.query(
			"INSERT INTO userfiles (pubkey, filename, status, date, ip_address, comments) VALUES (?, ?, ?, ?, ?, ?)",
			[
				pubkey,
				`${fileoptions.outputname}.${fileoptions.outputmime}`,
				"pending",
				createdate,
				req.socket.remoteAddress,
				"comments",
			]
		);}
		catch (error) {
			logger.error("Error inserting file to database", error);
			const result: MediaResultMessage = {
				result: false,
				description: "Error inserting file to database",
				url: "",
				status:  ["failed"],
				id: "",
				pubkey: "",
			};
			return res.status(500).send(result);
		}
	
		//Get file ID
		const [IDdbResult] = await db.query("SELECT id FROM userfiles WHERE filename = ? and pubkey = ?", [fileoptions.outputname + "." + fileoptions.outputmime, pubkey]);
		const IDrowstemp = JSON.parse(JSON.stringify(IDdbResult));
		if (IDrowstemp[0] == undefined) {
			logger.error("File not found in database:", fileoptions.outputname + "." + fileoptions.outputmime);
			const result: MediaResultMessage = {
				result: false,
				description: "The requested file was not found in database",
				url: "",
				status: ["failed"],
				id: "",
				pubkey: "",
			};
	
			return res.status(404).send(result);
		}

	fileoptions.id = IDrowstemp[0].id;

	const t: asyncTask = {
		req,
		fileoptions,
	};

	//If not exist create username folder
	const userfolder = `./media/${req.body.username}`;
	if (!fs.existsSync(userfolder)){
		fs.mkdirSync(userfolder);
	}

	//Send request to transform queue
	requestQueue.push(t).catch((err) => {
		logger.error("Error pushing file to queue", err);
		const result: MediaResultMessage = {
			result: false,
			description: "Error queueing file",
			url: "",
			status:  ["failed"],
			id: "",
			pubkey: "",
		};

		return result;
	});

	logger.info(`${requestQueue.length()} items in queue`);


	//Return file queued for conversion
	const returnmessage: MediaResultMessage = {
		result: true,
		description: "File queued for conversion",
		url: "",
	    status: JSON.parse(JSON.stringify(UploadStatus[0])),
		id: IDrowstemp[0].id,
		pubkey: pubkey,
	};

	return res.status(200).send(returnmessage);
};

const GetMediaStatusbyID = async (req: Request, res: Response) => {

	logger.info("GET /api/v1/media", "|", req.socket.remoteAddress);

	const servername = "https://" + req.hostname; //TODO, get entire url from request

	//Check if event authorization header is valid (NIP98)
	const EventHeader = await ParseAuthEvent(req);
	if (!EventHeader.result) {
		logger.warn(
			`RES -> 401 unauthorized - ${EventHeader.description}`,
			"|",
			req.socket.remoteAddress
		);
		const result: MediaResultMessage = {
			result: false,
			description: EventHeader.description,
			url: "",
			status:  ["failed"],
			id: "",
			pubkey: "",
		};

		return res.status(401).send(result);
	}

	if (!req.query.id) {
		logger.warn(`RES -> 400 Bad request - missing id`, "|", req.socket.remoteAddress);
		const result: MediaResultMessage = {
			result: false,
			description: "missing id",
			url: "",
			status:  ["failed"],
			id: "",
			pubkey: "",
		};

		return res.status(400).send(result);
	}

	const id = req.query.id;

	logger.info(`GET /api/v1/media?id=${id}`, "|", req.socket.remoteAddress);

	const db = await connect();
	const [dbResult] = await db.query("SELECT userfiles.id, userfiles.filename, registered.username, userfiles.pubkey, userfiles.status FROM userfiles INNER JOIN registered on userfiles.pubkey = registered.hex WHERE (userfiles.id = ? and userfiles.pubkey = ?) OR (userfiles.id = ? and userfiles.pubkey = ?)", [id , EventHeader.pubkey,id , app.get("pubkey")]);
	const rowstemp = JSON.parse(JSON.stringify(dbResult));
	if (rowstemp[0] == undefined) {
		logger.error(`File not found in database: ${req.query.id}`);
		const result: MediaResultMessage = {
			result: false,
			description: "The requested file was not found",
			url: "",
			status:  ["failed"],
			id: "",
			pubkey: "",
		};

		return res.status(404).send(result);
	}

	//File get return logic
	let url = "";
	let description = "";
	let resultstatus = false;
	if (rowstemp[0].status == "completed") {
		url = servername + "/" + rowstemp[0].username + "/" + rowstemp[0].filename;
		description = "The requested file was found";
		resultstatus = true;
		logger.info(`RES -> 200 OK - ${description}`, "|", req.socket.remoteAddress);
	}else if (rowstemp[0].status == "failed") {
		url = "";
		description = "It was a problem processing this file";
		resultstatus = false;
	}else if (rowstemp[0].status == "pending") {
		url = "";
		description = "The requested file is still pending";
		resultstatus = false;
	}else if (rowstemp[0].status == "processing") {
		url = "";
		description = "The requested file is processing";
		resultstatus = false;
	}
	
	const result: MediaResultMessage = {
		result: resultstatus,
		description: description,
		url: url,
		status: rowstemp[0].status,
		id: rowstemp[0].id,
		pubkey: rowstemp[0].pubkey,
	};

	return res.status(200).send(result);
};

export { GetMediaStatusbyID, Uploadmedia };


// const GetMediabyID = async (req: Request, res: Response) => {


// const path = require('path');
// const directoryName = './media/public';

// // const types = {
// //   html: 'text/html',
// //   css: 'text/css',
// //   js: 'application/javascript',
// //   png: 'image/png',
// //   jpg: 'image/jpeg',
// //   jpeg: 'image/jpeg',
// //   gif: 'image/gif',
// //   json: 'application/json',
// //   xml: 'application/xml',
// // };

// const root = path.normalize(path.resolve(directoryName));


//   console.log(`${req.method} ${req.url}`);

//   const extension = path.extname(req.url).slice(1);
// //   const type = extension ? types[extension] : types.html;
// //   const supportedExtension = Boolean(type);

// //   if (!supportedExtension) {
// //     res.writeHead(404, { 'Content-Type': 'text/html' });
// //     res.end('404: File not found');
// //     return;
// //   }

//   let fileName = req.url;
//   if (req.url === '/') fileName = 'index.html';
//   else if (!extension) {
//     try {
//       fs.accessSync(path.join(root, req.url + '.html'), fs.constants.F_OK);
//       fileName = req.url + '.html';
//     } catch (e) {
//       fileName = path.join(req.url, 'index.html');
//     }
//   }

//   const filePath = path.join(root, fileName);
//   const isPathUnderRoot = path
//     .normalize(path.resolve(filePath))
//     .startsWith(root);

//   if (!isPathUnderRoot) {
//     res.writeHead(404, { 'Content-Type': 'text/html' });
//     res.end('404: File not found');
//     return;
//   }

//   fs.readFile(filePath, (err, data) => {
//     if (err) {
//       res.writeHead(404, { 'Content-Type': 'text/html' });
//       res.end('404: File not found');
//     } else {
//       res.writeHead(200, { 'Content-Type': "test" });
//       res.end(data);
//     }

// });

// }


