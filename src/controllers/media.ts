import crypto from "crypto";
import { Request, Response } from "express";

import app from "../app.js";
import { connect, dbSelectUsername } from "../lib/database.js";
import { logger } from "../lib/logger.js";
import { ParseAuthEvent } from "../lib/nostr/NIP98.js";
import { ParseMediaType, ParseFileType } from "../lib/media.js"
import { requestQueue } from "../lib/media.js";
import {
	asyncTask,
	ProcessingFileData,
	MediaExtraDataResultMessage,
	mediaTypes,
	MediaVisibilityResultMessage,
	mime_transform,
	UploadStatus,
	FileData,
} from "../interfaces/media.js";

import { ResultMessage } from "../interfaces/server.js";

import fs from "fs";
import config from "config";
import path from "path";
import { NIP94_event } from "../interfaces/nostr.js";
import { PrepareNIP94_event } from "../lib/nostr/NIP94.js";
import { generateBlurhash } from "../lib/blurhash.js";

const Uploadmedia = async (req: Request, res: Response): Promise<Response> => {
	logger.info("POST /api/v1/media", "|", req.socket.remoteAddress);

	//Check if event authorization header is valid (NIP98) or if apikey is valid (v0)
	const EventHeader = await ParseAuthEvent(req);
	if (!EventHeader.result) {return res.status(401).send({"result": EventHeader.result, "description" : EventHeader.description});}

	const servername = "https://" + req.hostname;
	let pubkey : string = EventHeader.pubkey;
	let username : string = await dbSelectUsername(pubkey);
	let description = "";

	//If username is not on the db the upload will be public and a warning will be logged.
	if (username === "") {
		username = "public";
		pubkey = app.get("pubkey");
		logger.warn("pubkey not registered, switching to public upload | ", req.socket.remoteAddress);
	}
	logger.info("username ->", username, "|", req.socket.remoteAddress);
	logger.info("pubkey ->", pubkey, "|", req.socket.remoteAddress);

	//Parse upload type. If not defined, default is "media"
	let media_type : string = ParseMediaType(req, pubkey);
	logger.info("type ->", media_type, "|", req.socket.remoteAddress);

	//Check if file exist on request body
	const files : any | Express.Multer.File[] = req.files;
	let file: Express.Multer.File = req.file? req.file : files[0];
	req.file = file;

	if (!file) {
		logger.warn(`RES -> 400 Bad request - Empty file`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "Empty file",
		};

		return res.status(400).send(result);
	}

	//Parse file type. If not defined or not allowed, reject upload.
	file.mimetype = await ParseFileType(req, file);
	if (file.mimetype === "") {
		logger.error(`RES -> 400 Bad request - `, file.mimetype, ` filetype not detected`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "file type not detected or not allowed",
		};
		return res.status(400).send(result);
	}
	logger.info("mime ->", file.mimetype, "|", req.socket.remoteAddress);

	//Uploaded file SHA256 hash
	const filehash = crypto
					.createHash("sha256")
					.update(file.buffer)
					.digest("hex");
	logger.info("hash ->", filehash, "|", req.socket.remoteAddress);

	//Filedata generation
	const filedata: ProcessingFileData = {
		filename: filehash +  "." + mime_transform[file.mimetype],
		fileid: "",
		username: username,
		pubkey: pubkey,
		width: config.get("media.transform.media.undefined.width"),
		height: config.get("media.transform.media.undefined.height"),
		media_type: media_type,
		originalmime: file.mimetype,
		outputoptions: "",
		originalhash: filehash,
		hash: "",
		url: "",
		magnet: "",
		torrent_infohash: "",
		blurhash: ""
	};

	//URL
	filedata.url = servername + "/media/" + username + "/" + filedata.filename;

	//Video or image conversion options
	if (file.mimetype.toString().startsWith("video")) {
		filedata.width = config.get("media.transform.media.video.width");
		filedata.height = config.get("media.transform.media.video.height");
		filedata.outputoptions = '-preset veryfast';
	}
	if (file.mimetype.toString().startsWith("image")) {
		filedata.width = config.get("media.transform.media.image.width");
		filedata.height = config.get("media.transform.media.image.height");
	}

	//Avatar conversion options
	if (filedata.media_type.toString() === "avatar"){
		filedata.width = config.get("media.transform.avatar.width");
		filedata.height = config.get("media.transform.avatar.height");
		filedata.filename = "avatar.webp";
	}

	//Banner conversion options
	if (filedata.media_type.toString() === "banner"){
		filedata.width = config.get("media.transform.banner.width");
		filedata.height = config.get("media.transform.banner.height");
		filedata.filename = "banner.webp";
	}

	let status: typeof UploadStatus = JSON.parse(JSON.stringify(UploadStatus[0]));
	let convert = true;
	let insertfiledb = true;

	//Check if the (file SHA256 hash and pubkey) is already on the database, if exist (and the upload is media type) we return the existing file URL
	const dbHash = await connect("Uploadmedia");
	const [dbHashResult] = await dbHash.query("SELECT id, hash, magnet, blurhash filename FROM mediafiles WHERE original_hash = ? and pubkey = ? and filename not like 'avatar%' and filename not like 'banner%' ", [filehash, pubkey]);	
	const rowstempHash = JSON.parse(JSON.stringify(dbHashResult));
	if (rowstempHash[0] !== undefined && media_type == "media") {
		logger.info(`RES ->  File already in database, returning existing URL`, "|", req.socket.remoteAddress);

		status = JSON.parse(JSON.stringify(UploadStatus[2]));
		description = description + "File exist in database, returning existing URL";
		filedata.filename = rowstempHash[0].filename;
		filedata.magnet = rowstempHash[0].magnet;
		filedata.fileid = rowstempHash[0].id;
		filedata.hash = rowstempHash[0].hash;
		filedata.blurhash = rowstempHash[0].blurhash;
		convert = false; 
		insertfiledb = false;

	}
	dbHash.end();

	logger.debug(filedata);

	//Add file to mediafiles table
	if (insertfiledb) {

		// //Generate blurhash
		// filedata.blurhash = await generateBlurhash(file);

		const dbFile = await connect("Uploadmedia");
		try{
			const createdate = new Date(Math.floor(Date.now())).toISOString().slice(0, 19).replace("T", " ");

			await dbFile.query(
				"INSERT INTO mediafiles (pubkey, filename, original_hash, hash, status, visibility, date, ip_address, magnet, blurhash, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					pubkey,
					filedata.filename,
					filedata.originalhash,
					filedata.hash,
					status,
					1,
					createdate,
					req.socket.remoteAddress,
					filedata.magnet,
					filedata.blurhash,
					"comments",
				]
			);
			
			dbFile.end();
			
			}
			catch (error) {
				logger.error("Error inserting file to database", error);
				const result: ResultMessage = {
					result: false,
					description: "Error inserting file to database",
				};
				dbFile.end();
				return res.status(500).send(result);
			}
		
			//Get file ID
			const dbFileID = await connect("Uploadmedia");
			const [IDdbResult] = await dbFileID.query("SELECT id FROM mediafiles WHERE filename = ? and pubkey = ? ORDER BY ID DESC", [filedata.filename, pubkey]);
			const IDrowstemp = JSON.parse(JSON.stringify(IDdbResult));
			if (IDrowstemp[0] == undefined) {
				logger.error("File not found in database:", filedata.filename);
				const result: ResultMessage = {
					result: false,
					description: "The requested file was not found in database",
				};
		
				dbFileID.end();
				return res.status(404).send(result);
			}
			dbFileID.end();
			filedata.fileid = IDrowstemp[0].id;
	}

	//If not exist create username folder
	const mediaPath = config.get("media.mediaPath") + username;
	if (!fs.existsSync(mediaPath)){
		fs.mkdirSync(mediaPath);
	}

	if (convert) {
		//Send request to transform queue
		const t: asyncTask = {
			req,
			filedata,
		};
		logger.info(`${requestQueue.length() +1} items in queue`);
		requestQueue.push(t).catch((err) => {
			logger.error("Error pushing file to queue", err);
			const result: ResultMessage = {
				result: false,
				description: "Error queueing file",

			};
			description = description + "File queued for conversion";
			return result;
		});
	}

	//Return standard message with "file queued for conversion", status pending, URL and file ID
	const returnmessage: MediaExtraDataResultMessage = {
		result: true,
		description: description,
	    status: status,
		id: filedata.fileid,
		pubkey: filedata.pubkey,
		url: filedata.url,
		hash: filedata.hash,
		magnet: filedata.magnet,
		tags: await GetFileTags(filedata.fileid)
	};

	//TEST NIP94 event response. TODO, remove this
	const returnMessageNIP94Test : NIP94_event = await PrepareNIP94_event(filedata);
	logger.debug(returnMessageNIP94Test);

	return res.status(200).send(returnmessage);
};

const GetMediaStatusbyID = async (req: Request, res: Response) => {

	logger.info("GET /api/v1/media", "|", req.socket.remoteAddress);

	//Check if event authorization header is valid (NIP98) or if apikey is valid (v0)
	const EventHeader = await ParseAuthEvent(req);
	if (!EventHeader.result) {return res.status(401).send({"result": EventHeader.result, "description" : EventHeader.description});}

	const servername = "https://" + req.hostname;

	let id = req.params.id || req.query.id || "";
	if (!id) {
		logger.warn(`RES -> 400 Bad request - missing id`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "missing id",

		};

		return res.status(400).send(result);
	}

	logger.info(`GET /api/v1/media?id=${id}`, "|", req.socket.remoteAddress);

	const db = await connect("GetMediaStatusbyID");
	const [dbResult] = await db.query("SELECT mediafiles.id, mediafiles.filename, registered.username, mediafiles.pubkey, mediafiles.status, mediafiles.magnet, mediafiles.original_hash, mediafiles.hash, mediafiles.blurhash, mediafiles.dimensions FROM mediafiles INNER JOIN registered on mediafiles.pubkey = registered.hex WHERE (mediafiles.id = ? and mediafiles.pubkey = ?)", [id , EventHeader.pubkey]);
	let rowstemp = JSON.parse(JSON.stringify(dbResult));
	if (rowstemp[0] == undefined) {
		logger.warn(`File not found in database: ${id}, trying public server pubkey`, "|", req.socket.remoteAddress);
		const [dbResult] = await db.query("SELECT mediafiles.id, mediafiles.filename, registered.username, mediafiles.pubkey, mediafiles.status, mediafiles.magnet, mediafiles.original_hash, mediafiles.hash, mediafiles.blurhash, mediafiles.dimensions FROM mediafiles INNER JOIN registered on mediafiles.pubkey = registered.hex WHERE (mediafiles.id = ? and mediafiles.pubkey = ?)", [id , app.get("pubkey")]);
		rowstemp = JSON.parse(JSON.stringify(dbResult));
		if (rowstemp[0] == undefined) {
			logger.error(`File not found in database: ${id}`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "The requested file was not found",

		};
		db.end();
		return res.status(404).send(result);
		}
	}

	db.end();

	//Generate filedata
	let filedata : FileData = {
		filename: rowstemp[0].filename,
		width: rowstemp[0].dimensions?.split("x")[0],
		height: rowstemp[0].dimensions?.split("x")[1],
		fileid: rowstemp[0].id,
		username: rowstemp[0].username,
		pubkey: rowstemp[0].pubkey,
		originalhash: rowstemp[0].original_hash,
		hash: rowstemp[0].hash,
		url: servername + "/media/" + rowstemp[0].username + "/" + rowstemp[0].filename,
		magnet: rowstemp[0].magnet,
		torrent_infohash: "",
		blurhash: rowstemp[0].blurhash
	};


	let description = "";
	let resultstatus = false;
	let response = 200;

	if (rowstemp[0].status == "completed") {
		description = "The requested file was found";
		resultstatus = true;
		response = 200;
		logger.info(`RES -> ${response} - ${description}`, "|", req.socket.remoteAddress);
	}else if (rowstemp[0].status == "failed") {
		description = "It was a problem processing this file";
		resultstatus = false;
		response = 500;
		logger.info(`RES -> ${response} - ${description}`, "|", req.socket.remoteAddress);
	}else if (rowstemp[0].status == "pending") {
		description = "The requested file is still pending";
		resultstatus = false;
		response = 202;
		logger.info(`RES -> ${response} - ${description}`, "|", req.socket.remoteAddress);
	}else if (rowstemp[0].status == "processing") {
		description = "The requested file is processing";
		resultstatus = false;
		response = 202;
		logger.info(`RES -> ${response} - ${description}`, "|", req.socket.remoteAddress);
	}

	let tags = await GetFileTags(rowstemp[0].id);

	const result: MediaExtraDataResultMessage = {
		result: resultstatus,
		description: description,
		url: filedata.url,
		status: rowstemp[0].status,
		id: rowstemp[0].id,
		pubkey: rowstemp[0].pubkey,
		hash: filedata.hash,
		magnet: rowstemp[0].magnet,
		tags: tags,

	};

	//TEST NIP94 event response. TODO, remove this
	const returnMessageNIP94Test : NIP94_event = await PrepareNIP94_event(filedata);
	logger.debug(returnMessageNIP94Test);

	return res.status(response).send(result);
	


};

const GetMediabyURL = async (req: Request, res: Response) => {

	//Allow CORS
	res.set("access-control-allow-origin", "*");
	res.set("access-control-allow-methods", "GET");
	res.set("Cross-Origin-Opener-Policy", "*");
	res.set("Cross-Origin-Resource-Policy", "*");
	res.set("X-frame-options", "*")

	//Check if username is not empty
	if (!req.params.username) {
		logger.warn(`RES Media URL -> 400 Bad request - missing username`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "missing username",
			
		};
		return res.status(400).send(result);
	}

	//Check if username is no longer than 50
	if (req.params.username.length > 50) {
		logger.warn(`RES Media URL -> 400 Bad request - username too long`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "username too long",
		};
		return res.status(400).send(result);
	}

	//Check if filename is not empty
	if (!req.params.filename) {
		logger.warn(`RES Media URL -> 400 Bad request - missing filename`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "missing filename",

		};
		return res.status(400).send(result);
	}

	//Check if filename is no longer than 128
	if (req.params.filename.length > 128) {
		logger.warn(`RES Media URL -> 400 Bad request - filename too long`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "filename too long",
		};
		return res.status(400).send(result);
	}
	
	const mediaPath = path.normalize(path.resolve(config.get("media.mediaPath")));

	//Check if mediaPath is not empty
	if (!mediaPath) {
		logger.warn(`RES Media URL -> 500 Internal Server Error - mediaPath not set`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "mediaPath not set",
		};
		return res.status(500).send(result);
	}
	
	let fileName = path.normalize(path.resolve(mediaPath + "/" + req.params.username + "/" + req.params.filename));

	logger.info(`RES Media URL -> username: ${req.params.username} | filename: ${fileName}`, "|", req.socket.remoteAddress);

	const isPathUnderRoot = path
		.normalize(path.resolve(fileName))
		.startsWith(mediaPath);

	if (!isPathUnderRoot) {
		logger.warn(`RES -> 403 Forbidden - ${req.url}`, "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "File not found",
		};
		return res.status(404).send(result);
	}

	const ext = path.extname(fileName)
	let mediaType :string = 'text/html'
	if (ext.length > 0 && mediaTypes.hasOwnProperty(ext.slice(1))) {
	mediaType = mediaTypes[ext.slice(1)]
	}

	fs.readFile(fileName, (err, data) => {
		if (err) {

			// If file not found, return not found media file
			logger.warn(`RES -> 404 Not Found - ${req.url}`, "| Returning not found media file.", req.socket.remoteAddress);

			const NotFoundFilePath = path.normalize(path.resolve(config.get("media.notFoudFilePath")));

			res.setHeader('Content-Type', mediaType);
			fs.readFile(NotFoundFilePath, (err, data) => {
				if (err) {
					logger.warn(`RES -> 404 Not Found - ${req.url}`, "| Returning not found media file.", req.socket.remoteAddress);
					res.status(404).send("File not found");
				} else {
				res.setHeader('Content-Type', 'image/webp');
				res.end(data);
				}
			});

		} else {
		res.setHeader('Content-Type', mediaType);
		res.end(data);
		}

	});

};

const GetMediaTagsbyID = async (req: Request, res: Response): Promise<Response> => {

	//Get available tags for a specific media file
	logger.info("REQ -> Media file tag list", "|", req.socket.remoteAddress);

	//Check if event authorization header is valid
	const EventHeader = await ParseAuthEvent(req);
	if (!EventHeader.result) {return res.status(401).send({"result": EventHeader.result, "description" : EventHeader.description});}

	logger.info("REQ -> Media tag list -> pubkey:", EventHeader.pubkey, "-> id:", req.params.fileId, "|", req.socket.remoteAddress);

	//Query database for media tags
	try {
		const conn = await connect("GetMediaTagsbyID");
		const [rows] = await conn.execute("SELECT tag FROM mediatags INNER JOIN mediafiles ON mediatags.fileid = mediafiles.id where fileid = ? and pubkey = ? ", [req.params.fileId, EventHeader.pubkey]);
		let rowstemp = JSON.parse(JSON.stringify(rows));

		if (rowstemp[0] !== undefined) {
			conn.end();
			logger.info("RES -> Media tag list ", "|", req.socket.remoteAddress);
			return res.status(200).send( JSON.parse(JSON.stringify(rows)));
		}else{
			//If not found, try with public server pubkey
			logger.info("Media tag list not found, trying with public server pubkey", "|", req.socket.remoteAddress);
			const [Publicrows] = await conn.execute("SELECT tag FROM mediatags INNER JOIN mediafiles ON mediatags.fileid = mediafiles.id where fileid = ? and pubkey = ?", [req.params.fileId, app.get("pubkey")]);
			let Publicrowstemp = JSON.parse(JSON.stringify(Publicrows));
			if (Publicrowstemp[0] !== undefined) {
				conn.end();
				logger.info("RES -> Media tag list ", "|", req.socket.remoteAddress);
				return res.status(200).send( JSON.parse(JSON.stringify(Publicrows)));
			}
		}

		conn.end();
		logger.warn("RES -> Empty media tag list ", "|", req.socket.remoteAddress);
		return res.status(404).send( JSON.parse(JSON.stringify({ "media tags": "No media tags found" })));
	} catch (error) {
		logger.error(error);

		return res.status(500).send({ description: "Internal server error" });
	}

};

const GetMediabyTags = async (req: Request, res: Response): Promise<Response> => {

	//Get media files by defined tags
	logger.info("REQ -> Media files for specified tag", "|", req.socket.remoteAddress);

	//Check if event authorization header is valid
	const EventHeader = await ParseAuthEvent(req);
	if (!EventHeader.result) {return res.status(401).send({"result": EventHeader.result, "description" : EventHeader.description});}

	logger.info("REQ -> Media files for specified tag -> pubkey:", EventHeader.pubkey, "-> tag:", req.params.tags, "|", req.socket.remoteAddress);

	//Check database for media files by tags
	try {
		const conn = await connect("GetMediabyTags");
		const [rows] = await conn.execute("SELECT mediafiles.id, mediafiles.filename, registered.username, mediafiles.pubkey, mediafiles.status FROM mediatags INNER JOIN mediafiles ON mediatags.fileid = mediafiles.id INNER JOIN registered ON mediafiles.pubkey = registered.hex where tag = ? and mediafiles.pubkey = ? ", [req.params.tag, EventHeader.pubkey]);
		let rowstemp = JSON.parse(JSON.stringify(rows));

		if (rowstemp[0] !== undefined) {
			conn.end();
			logger.info("RES -> Media files for specified tag ", "|", req.socket.remoteAddress);
			const result = {
				result: true,
				description: "Media files found",
				mediafiles: rows,
			};
	
			return res.status(200).send(result);
		}else{
			//If not found, try with public server pubkey
			logger.info("Media files for specified tag not found, trying with public server pubkey", "|", req.socket.remoteAddress);
			const [Publicrows] = await conn.execute("SELECT mediafiles.id, mediafiles.filename, registered.username, mediafiles.pubkey, mediafiles.status FROM mediatags INNER JOIN mediafiles ON mediatags.fileid = mediafiles.id INNER JOIN registered ON mediafiles.pubkey = registered.hex where tag = ? and mediafiles.pubkey = ?", [req.params.tag, app.get("pubkey")]);
			let Publicrowstemp = JSON.parse(JSON.stringify(Publicrows));
			if (Publicrowstemp[0] !== undefined) {
				conn.end();
				logger.info("RES -> Media files for specified tag ", "|", req.socket.remoteAddress);
				const result = {
					result: true,
					description: "Media files found",
					mediafiles: Publicrows,
				};

				return res.status(200).send(result);
			}
		}

		conn.end();
		logger.warn("RES -> Empty media files for specified tag ", "|", req.socket.remoteAddress);
		return res.status(404).send( JSON.parse(JSON.stringify({ "media files": "No media files found" })));
	} catch (error) {
		logger.error(error);
		
		return res.status(500).send({ description: "Internal server error" });
	}

};

const UpdateMediaVisibility = async (req: Request, res: Response): Promise<Response> => {

	//Update media visibility
	logger.info("REQ -> Update media visibility", "|", req.socket.remoteAddress);

	//Check if event authorization header is valid
	const EventHeader = await ParseAuthEvent(req);
	if (!EventHeader.result) {return res.status(401).send({"result": EventHeader.result, "description" : EventHeader.description});}

	logger.info("REQ -> Update media visibility -> pubkey:", EventHeader.pubkey, "-> id:", req.params.fileId, "-> visibility:", req.params.visibility, "|", req.socket.remoteAddress);

	//Check if fileId is not empty
	if (!req.params.fileId) {
		logger.warn("RES -> 400 Bad request - missing fileId", "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "missing fileId",
		};
		return res.status(400).send(result);
	}

	//Check if visibility is valid
	if (req.params.visibility != "1" && req.params.visibility != "0") {
		logger.warn("RES -> Invalid visibility value", "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "Invalid visibility value",
		};
		return res.status(400).send(result);
	}

	//Update table mediafiles whith new visibility
	try {
		const conn = await connect("UpdateMediaVisibility");
		const [rows] = await conn.execute("UPDATE mediafiles SET visibility = ? WHERE id = ? and pubkey = ?", [req.params.visibility, req.params.fileId, EventHeader.pubkey]);
		let rowstemp = JSON.parse(JSON.stringify(rows));
		conn.end();
		if (rowstemp.affectedRows !== 0) {
			logger.info("RES -> Media visibility updated:", req.params.visibility, "|", req.socket.remoteAddress);
			const result: MediaVisibilityResultMessage = {
				result: true,
				description: "Media visibility has changed",
				id: req.params.fileId,
				visibility: req.params.visibility,
			};
			return res.status(200).send(result);
		}

		logger.warn("RES -> Media visibility not updated, media file not found ", "|", req.socket.remoteAddress);
		const result = {
			result: false,
			description: "Media visibility not updated, media file not found",
		};
		return res.status(404).send(result);

	} catch (error) {
		logger.error(error);
		const result = {
			result: false,
			description: "Internal server error",
		};
		return res.status(500).send(result);
	}

};


const DeleteMedia = async (req: Request, res: Response): Promise<any> => {
	

	const servername = req.hostname;
	let fileId = req.params.fileId;
	let filehash = "";
	let mediafiles = [];
	let username = "";

	logger.info("REQ Delete mediafile ->", servername, "|", req.socket.remoteAddress);

	//Check if fileId is not empty
	if (!fileId) {
		logger.warn("RES -> 400 Bad request - missing fileId", "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "missing fileId",
		};
		return res.status(400).send(result);
	}

	//Check if fileId is a number
	if (isNaN(fileId as any)) {
		logger.warn("RES -> 400 Bad request - fileId is not a number", "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "fileId must be a number",
		};
		return res.status(400).send(result);
	}

	//Check if fileId length is > 10
	if (fileId.length > 10) {
		logger.warn("RES -> 400 Bad request - fileId too long > 10", "|", req.socket.remoteAddress);
		const result: ResultMessage = {
			result: false,
			description: "fileId too long",
		};
		return res.status(400).send(result);
	}

	//We don't allow deletions from server apikey for security reasons
	if (req.query.apikey || req.body.apikey) {

		try {
			const conn = await connect("DeleteMedia");
			const [rows] = await conn.execute("SELECT hex FROM registered WHERE apikey = ?", [req.query.apikey || req.body.apikey]);
			let rowstemp = JSON.parse(JSON.stringify(rows));
			conn.end();
			if (rowstemp.length !== 0) {
				let pubkey = rowstemp[0].hex;
				if (pubkey == config.get("server.pubkey")){
					//We don't authorize server apikey for deletion
					logger.warn("RES -> 400 Bad request - apikey not allowed for deletion", "|", req.socket.remoteAddress);
					const result: ResultMessage = {
						result: false,
						description: "apikey not allowed for deletion",
					};
					return res.status(400).send(result);
				}
			}
		} catch (error) {
			logger.error(error);
			const result = {
				result: false,
				description: "Internal server error",
			};
			return res.status(500).send(result);
		}
	}
	
	//Check if event authorization header is valid (NIP98) or if apikey is valid (v0)
	const EventHeader = await ParseAuthEvent(req);
	if (!EventHeader.result) {return res.status(401).send({"result": EventHeader.result, "description" : EventHeader.description});}

	//Check if mediafile exist on database
	try{
		const conn = await connect("DeleteMedia");
		const [rows] = await conn.execute(
			"SELECT mediafiles.id, mediafiles.filename, mediafiles.hash, registered.username FROM mediafiles LEFT JOIN registered on mediafiles.pubkey = registered.hex WHERE mediafiles.pubkey = ? and mediafiles.id = ?",
			[EventHeader.pubkey, fileId]
		);
		let rowstemp = JSON.parse(JSON.stringify(rows));
		conn.end();
		if (rowstemp[0] == undefined) {
			logger.warn("RES Delete Mediafile -> 404 Not found", "|", req.socket.remoteAddress);
			const result: ResultMessage = {
				result: false,
				description: `Mediafile deletion for id: ${fileId} and pubkey ${EventHeader.pubkey} not found`,
			};
			return res.status(404).send(result);
		}

		//We store filehash for delete all files with same hash
		if (rowstemp[0].hash !== undefined){
		filehash = rowstemp[0].hash;
		}else{
			logger.error("Error getting file hash from database");
			const result: ResultMessage = {
				result: false,
				description: "Error getting file hash from database",
			};
			return res.status(500).send(result);
		}

		//We store filenames for delete all files with same hash
		if (rowstemp[0].filename !== undefined && rowstemp.length > 0){
			for (let i = 0; i < rowstemp.length; i++) {
				mediafiles.push(rowstemp[i].filename);
			}
		}else{
			logger.error("Error getting filenames from database");
			const result: ResultMessage = {
				result: false,
				description: "Error getting filenames from database",
			};
			return res.status(500).send(result);
		}

		//We store username for delete folder
		if (rowstemp[0].username !== undefined){
			username = rowstemp[0].username;
		}else{
			logger.error("Error getting username from database");
			const result: ResultMessage = {
				result: false,
				description: "Error getting username from database",
			};
			return res.status(500).send(result);
		}
		
	}catch (error) {
		logger.error(error);
		const result: ResultMessage = {
			result: false,
			description: "Internal server error",
		};
		return res.status(500).send(result);
	}

	logger.info("REQ Delete mediafile ->", servername, " | pubkey:",  EventHeader.pubkey, " | fileId:",  fileId, "|", req.socket.remoteAddress);

	try {
		const conn = await connect("DeleteMedia");
		const [rows] = await conn.execute(
			"DELETE FROM mediafiles WHERE hash = ? and pubkey = ?", [filehash, EventHeader.pubkey]
		);
		let rowstemp = JSON.parse(JSON.stringify(rows));
		conn.end();
		if (rowstemp.affectedRows == 0) {
			logger.warn("RES Delete Mediafile -> 404 Not found", "|", req.socket.remoteAddress);
			const result: ResultMessage = {
				result: false,
				description: `Mediafile deletion for id: ${fileId} and pubkey ${EventHeader.pubkey} not found`,
			};
			return res.status(404).send(result);
		}

		logger.info("Deleting files from database:", rowstemp.affectedRows, "|", req.socket.remoteAddress);

		//Delete file from disk
		for (let i = 0; i < mediafiles.length; i++) {
			const mediaPath = config.get("media.mediaPath") + username + "/" + mediafiles[i];
			if (fs.existsSync(mediaPath)){
				logger.info("Deleting file from disk:", mediaPath);
				fs.unlinkSync(mediaPath);
			}
		}
	}
	catch (error) {
		logger.error(error);
		const result: ResultMessage = {
			result: false,
			description: "Internal server error",
		};
		return res.status(500).send(result);
	}

	logger.info("RES Delete mediafile ->", servername, " | pubkey:",  EventHeader.pubkey, " | fileId:",  fileId, "|", "mediafile(s) deleted", "|", req.socket.remoteAddress);
	const result: ResultMessage = {
		result: true,
		description: `Mediafile deletion for id: ${fileId} and pubkey ${EventHeader.pubkey} successful`,
	};
	return res.status(200).send(result);

};

export { GetMediaStatusbyID, GetMediabyURL, Uploadmedia, DeleteMedia, UpdateMediaVisibility, GetMediaTagsbyID, GetMediabyTags };


const GetFileTags = async (fileid: string): Promise<string[]> => {

	let tags = [];
	const dbTags = await connect("GetFileTags");
	try{
		const [dbTagsResult] = await dbTags.query("SELECT tag FROM mediatags WHERE fileid = ?", [fileid]);
		const tagsrowstemp = JSON.parse(JSON.stringify(dbTagsResult));
		if (tagsrowstemp[0] !== undefined) {
			for (let i = 0; i < tagsrowstemp.length; i++) {
				tags.push(tagsrowstemp[i].tag);
			}
		}
		dbTags.end();
	}
	catch (error) {
		logger.error("Error getting file tags from database", error);
		dbTags.end();
	}
	
	return tags;
}
