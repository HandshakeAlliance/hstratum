/*!
 * primitives.js - primitives for hstratum
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * Copyright (c) 2019, Handshake Alliance (MIT License).
 * https://github.com/handshake-org/hsd
 */

"use strict";

const { StringDecoder } = require("string_decoder");
const { Lock } = require("bmutex");
const IP = require("binet");
const EventEmitter = require("events");
const { format } = require("util");
const assert = require("bsert");
const { BufferSet } = require("buffer-map");
const { consensus } = require("hsd");
const common = require("hsd/lib/mining/common");
const {BAN_SCORE,SHARES_PER_MINUTE} = require('./stratum.js');
const merkle = require('hsd/lib/protocol/merkle.js');
const BLAKE2b256 = require('bcrypto/lib/blake2b256');

const util = require("./util.js");
const constants = require("./constants.js");

/**
 * Stratum Connection
 */

class Connection extends EventEmitter {
  /**
   * Create a stratum connection.
   * @constructor
   * @param {Stratum} stratum
   * @param {net.Socket} socket
   */

  constructor(stratum, socket) {
    super();

    this.locker = new Lock();
    this.stratum = stratum;
    this.logger = stratum.logger;
    this.socket = socket;
    this.host = IP.normalize(socket.remoteAddress);
    this.port = socket.remotePort;
    this.hostname = IP.toHostname(this.host, this.port);
    this.decoder = new StringDecoder("utf8");
    this.agent = "";
    this.recv = "";
    this.admin = false;
    this.users = new Set();
    this.sid = -1;
    this.difficulty = -1;
    this.nextDifficulty = -1;
    this.banScore = 0;
    this.lastBan = 0;
    this.drainSize = 0;
    this.destroyed = false;
    this.lastRetarget = -1;
    this.submissions = 0;
    this.prev = null;
    this.next = null;

    this._init();
  }

  _init() {
    this.on("packet", async msg => {
      try {
        await this.readPacket(msg);
      } catch (e) {
        this.error(e);
      }
    });

    this.socket.on("data", data => {
      this.feed(data);
    });

    this.socket.on("error", err => {
      this.emit("error", err);
    });

    this.socket.on("close", () => {
      this.logger.info("miner socket hung up.");
      //this.error("Socket hangup."); // this kills server?
      this.destroy();
    });

    this.socket.on("drain", () => {
      this.drainSize = 0;
    });
  }

  destroy() {
    if (this.destroyed) return;

    this.destroyed = true;

    this.locker.destroy();
    this.socket.destroy();
    this.socket = null;

    this.emit("close");
  }

  send(json) {
    if (this.destroyed) return;

    json = JSON.stringify(json);
    json += "\n";

    this.write(json);
  }

  write(text) {
    if (this.destroyed) return;

    if (this.socket.write(text, "utf8") === false) {
      this.drainSize += Buffer.byteLength(text, "utf8");
      if (this.drainSize > 5 << 20) {
        this.logger.warning("Client is not reading (%s).", this.id());
        this.destroy();
      }
    }
  }

  error(err) {
    if (this.destroyed) return;

    if (err instanceof Error) {
      err.message += ` (${this.id()})`;
      this.emit("error", err);
      return;
    }

    let msg = format.apply(null, arguments);

    msg += ` (${this.id()})`;

    this.emit("error", new Error(msg));
  }

  redirect() {
    const host = this.stratum.options.publicHost;
    const port = this.stratum.options.publicPort;

    const res = [
      "HTTP/1.1 200 OK",
      `X-Stratum: stratum+tcp://${host}:${port}`,
      "Connection: Close",
      "Content-Type: application/json; charset=utf-8",
      "Content-Length: 38",
      "",
      "",
      '{"error":null,"result":false,"id":0}'
    ];

    this.write(res.join("\r\n"));

    this.logger.debug("Redirecting client (%s).", this.id());

    this.destroy();
  }

  feed(data) {
    this.recv += this.decoder.write(data);

    if (this.recv.length >= 100000) {
      this.error("Too much data buffered (%s).", this.id());
      this.destroy();
      return;
    }

    if (/HTTP\/1\.1/i.test(this.recv)) {
      this.redirect();
      return;
    }

    const lines = this.recv.replace(/\r+/g, "").split(/\n+/);

    this.recv = lines.pop();

    for (const line of lines) {
      if (line.length === 0) continue;

      let msg;
      try {
        msg = ClientPacket.fromRaw(line);
      } catch (e) {
        this.error(e);
        continue;
      }

      this.emit("packet", msg);
    }
  }

  async readPacket(msg) {
    const unlock = await this.locker.lock();
    try {
      this.socket.pause();
      await this.handlePacket(msg);
    } finally {
      if (!this.destroyed) this.socket.resume();
      unlock();
    }
  }

  async handlePacket(msg) {
    return await this.stratum.handlePacket(this, msg);
  }

  addUser(username) {
    if (this.users.has(username)) return false;

    this.users.add(username);

    return true;
  }

  hasUser(username) {
    return this.users.has(username);
  }

  increaseBan(score) {
    const now = Date.now();

    this.banScore *= Math.pow(1 - 1 / 60000, now - this.lastBan);
    this.banScore += score;
    this.lastBan = now;

    if (this.banScore >= BAN_SCORE) {
      this.logger.debug(
        "Ban score exceeds threshold %d (%s).",
        this.banScore,
        this.id()
      );
      this.ban();
    }
  }

  ban() {
    this.emit("ban");
  }

  sendError(msg, code, reason) {
    this.logger.spam("Sending error %s (%s).", reason, this.id());

    this.send({
      id: msg.id,
      result: null,
      error: [code, reason, false]
    });
  }

  sendResponse(msg, result) {
    this.logger.spam("Sending response %s (%s).", msg.id, this.id());

    this.send({
      id: msg.id,
      result: result,
      error: null
    });
  }

  sendMethod(method, params) {
    this.logger.spam("Sending method %s (%s).", method, this.id());

    this.send({
      id: null,
      method: method,
      params: params
    });
  }

  sendDifficulty(difficulty) {
    assert(difficulty > 0, "Difficulty must be at least 1.");

    this.logger.debug(
      "Setting difficulty=%d for client (%s).",
      difficulty,
      this.id()
    );

    this.sendMethod("mining.set_difficulty", [difficulty]);
  }

  setDifficulty(difficulty) {
    this.nextDifficulty = difficulty;
  }

  sendJob(job) {
    this.logger.debug("Sending job %s to client (%s).", job.id, this.id());

    if (this.nextDifficulty !== -1) {
      this.submissions = 0;
      this.lastRetarget = Date.now();
      this.sendDifficulty(this.nextDifficulty);
      this.difficulty = this.nextDifficulty;
      this.nextDifficulty = -1;
    }

    this.sendMethod("mining.notify", job.toJSON());
  }

  retarget(max) {
    const now = Date.now();
    const pm = SHARES_PER_MINUTE;

    assert(this.difficulty > 0);
    assert(this.lastRetarget !== -1);

    this.submissions += 1;

    if (this.submissions % pm === 0) {
      const target = (this.submissions / pm) * 60000;
      let actual = now - this.lastRetarget;
      let difficulty = 0x100000000 / this.difficulty;

      if (max > -1 >>> 0) max = -1 >>> 0;

      if (Math.abs(target - actual) <= 5000) return false;

      if (actual < target / 4) actual = target / 4;

      if (actual > target * 4) actual = target * 4;

      difficulty *= actual;
      difficulty /= target;
      difficulty = 0x100000000 / difficulty;
      difficulty >>>= 0;
      difficulty = Math.min(max, difficulty);
      difficulty = Math.max(1, difficulty);

      this.setDifficulty(difficulty);

      return true;
    }

    return false;
  }

  id() {
    let id = this.host;

    if (this.agent) id += "/" + this.agent;

    return id;
  }
}

/**
 * ClientPacket
 */

class ClientPacket {
  /**
   * Create a packet.
   */

  constructor() {
    this.id = null;
    this.method = "unknown";
    this.params = [];
  }

  static fromRaw(json) {
    const packet = new ClientPacket();
    const msg = JSON.parse(json);

    if (msg.id != null) {
      assert(typeof msg.id === "string" || typeof msg.id === "number");
      packet.id = msg.id;
    }

    assert(typeof msg.method === "string");
    assert(msg.method.length <= 50);
    packet.method = msg.method;

    if (msg.params) {
      assert(Array.isArray(msg.params));
      packet.params = msg.params;
    }

    return packet;
  }
}

/**
 * Submission Packet
 */

class Submission {
  /**
   * Create a submission packet.
   */

  constructor() {
    this.username = "";
    this.job = "";
    this.nonce2 = 0;
    this.ts = 0;
    this.nonce = 0;
  }

  static fromPacket(msg) {
    const subm = new Submission();

    assert(msg.params.length >= 5, "Invalid parameters.");

    assert(util.isUsername(msg.params[0]), "Name must be a string.");
    assert(util.isJob(msg.params[1]), "Job ID must be a string.");

    assert(typeof msg.params[2] === "string", "Nonce2 must be a string.");
    assert(
      msg.params[2].length === constants.NONCE_SIZE * 2,
      "Nonce2 must be a string."
    );
    assert(util.isHex(msg.params[2]), "Nonce2 must be a string.");

    assert(typeof msg.params[3] === "string", "Time must be a string.");
    assert(msg.params[3].length === 8, "Time must be a string.");
    assert(util.isHex(msg.params[3]), "Time must be a string.");

    assert(typeof msg.params[4] === "string", "Nonce must be a string.");
    //alex note: removing this validation.
    /*
    //this assert stmt removed heyo
    assert(msg.params[4].length === 8, "Nonce must be a string.");
    */ 
    //.verify freaks the fuck out if we pass in a string nonce
    //in addition, it wants it to be 32 bytes long (64 chars)
    //so since the client passes 32-byte nonces around we'll just submit the extra 0's for now..
    
    //we could technically re-implement this, 
    //and to do sowe'll need to construct an empty 32-byte buffer, fill it with nonce etc.
    //so yeah i'm ok with some extra 0's and consider we have room to grow into nonce space (badpokerface)

    assert(util.isHex(msg.params[4]), "Nonce must be a string.");

    subm.username = msg.params[0];
    subm.job = msg.params[1];
    subm.nonce2 = parseInt(msg.params[2], 16);
    subm.ts = parseInt(msg.params[3], 16);
    subm.nonce = msg.params[4];

    return subm;
  }
}

/**
 * Job
 */

class Job {
  /**
   * Create a job.
   * @constructor
   */

  constructor(id) {
    assert(typeof id === "string");

    this.id = id;
    this.attempt = null;
    this.target = consensus.ZERO_HASH;
    this.difficulty = 0;
    this.submissions = new BufferSet();
    this.committed = false;
    this.prev = null;
    this.next = null;
  }

  fromTemplate(attempt) {
    this.attempt = attempt;
    this.attempt.refresh();
    this.target = attempt.target;
    this.difficulty = attempt.getDifficulty();
    return this;
  }

  static fromTemplate(id, attempt) {
    return new this(id).fromTemplate(attempt);
  }

  insert(hash) {
    if (this.submissions.has(hash)) return false;

    this.submissions.add(hash);
    return true;
  }

  check(nonce1, subm) {
    const nonce2 = subm.nonce2;
    const ts = subm.ts;
    const nonce = Buffer.from(subm.nonce,'hex');
    const proof = this.attempt.getProof(nonce1, nonce2, ts, nonce);
    return proof;
  }

  commit(share) {
    assert(!this.committed, "Already committed.");
    this.committed = true;
    return this.attempt.commit(share);
  }

  toJSON() {
    let itemTx = [];
    this.attempt.items.map((d)=>{
      /*
      ALEX NOTE:: attempt.tree.toJSON() returns the steps of that merkle tree
      however the steps are calculated from tx.witnessHash() and the actual leaves
      in createRoot (mining/template.js) are created from the tx.hash()
      so we hash the leaves into the state they'd get merged into the merkle tree.
      Then on the client end we have the RE-CREATED coinbase tx from left+nonce1+nonce2+right
      so that we can match the merkleRoot and generate a crapton of nonces without talking to the stratum.
      
      ...also just noticed mining:get_transactions in the stratum which would get you the same tx.hashes with a 2nd call..
      so def better to bundle them here anyway and save an extra call..
      */
      if(typeof d.tx != "undefined"){
        itemTx.push(merkle.hashLeaf(BLAKE2b256,d.tx.hash()).toString('hex'))
      }
    })

    return [
      this.id,
      // common.swap32(this.attempt.prevBlock).toString("hex"),
      this.attempt.prevBlock.toString("hex"),
      this.attempt.left.toString("hex"),
      this.attempt.right.toString("hex"),
      itemTx,
      this.attempt.tree.toJSON(),
      this.attempt.treeRoot.toString("hex"),
      this.attempt.filterRoot.toString("hex"),
      this.attempt.reservedRoot.toString("hex"),
      util.hex32(this.attempt.version),
      util.hex32(this.attempt.bits),
      //Double check this is correct
      util.hex32(this.attempt.time),
      false
      
    ];
  }
}

module.exports.Connection = Connection;
module.exports.ClientPacket = ClientPacket;
module.exports.Submission = Submission;
module.exports.Job = Job;
