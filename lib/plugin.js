/*!
 * plugin.js - hstratum plugin for HSD
 * Copyright (c) 2019, Handshake Alliance (MIT License).
 * https://github.com/handshakealliance/hstratum
 */

"use strict";

const EventEmitter = require("events");
const Stratum = require("./stratum.js");
const { Network } = require("hsd");

/**
 * @exports hindex/plugin
 */

const plugin = exports;

/**
 * Plugin
 * @extends EventEmitter
 */

class Plugin extends EventEmitter {
  constructor(node) {
    super();

    // XXX will be broken until issue is merged on bcfg
    this.config = node.config.filter("stratum");

    this.config.open("stratum.conf");

    this.network = Network.get(node.network.type);
    this.logger = node.logger;

    console.log("connecting to: %s", node.network);

    this.stratum = new Stratum({
      network: this.network,
      node: node,
      prefix: this.config.prefix,
      logger: this.logger,
      host: this.config.str("host"),
      port: this.config.uint("port"),
      publicHost: this.config.str("public-host"),
      publicPort: this.config.uint("public-port"),
      maxInbound: this.config.uint("max-inbound"),
      difficulty: this.config.uint("difficulty"),
      dynamic: this.config.bool("dynamic"),
      password: this.config.str("password")
    });
    this.init();
  }

  // placeholder init function
  init() {}

  // Open stratum
  async open() {
    await this.stratum.open();
  }

  // Close stratum.
  async close() {}
}

/**
 * Plugin name.
 * @const {String}
 */

plugin.id = "hstratum";

/**
 * Plugin initialization.
 * @param {Node} node
 * @returns {hstratum}
 */

plugin.init = function init(node) {
  return new Plugin(node);
};
