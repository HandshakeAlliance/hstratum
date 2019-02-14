/*!
 * util.js - util functions for hstratum server
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * Copyright (c) 2019, Handshake Alliance (MIT License).
 * https://github.com/handshake-org/hsd
 */

"use strict";

const assert = require("bsert");

/**
 * @exports util
 */

const util = exports;

util.now = function now() {
  return Math.floor(Date.now() / 1000);
};

util.isUsername = function isUsername(username) {
  if (typeof username !== "string") return false;

  return username.length > 0 && username.length <= 100;
};

util.isJob = function isJob(id) {
  if (typeof id !== "string") return false;

  return id.length >= 12 && id.length <= 21;
};

util.isSID = function isSID(sid) {
  if (typeof sid !== "string") return false;

  return sid.length === 8 && util.isHex(sid);
};

util.isPassword = function isPassword(password) {
  if (typeof password !== "string") return false;

  return password.length > 0 && password.length <= 255;
};

util.isAgent = function isAgent(agent) {
  if (typeof agent !== "string") return false;

  return agent.length > 0 && agent.length <= 255;
};

util.isHex = function isHex(str) {
  return (
    typeof str === "string" && str.length % 2 === 0 && /^[0-9a-f]$/i.test(str)
  );
};

util.hex32 = function hex32(num) {
  assert(num >>> 0 === num);
  num = num.toString(16);
  switch (num.length) {
    case 1:
      return `0000000${num}`;
    case 2:
      return `000000${num}`;
    case 3:
      return `00000${num}`;
    case 4:
      return `0000${num}`;
    case 5:
      return `000${num}`;
    case 6:
      return `00${num}`;
    case 7:
      return `0${num}`;
    case 8:
      return `${num}`;
    default:
      throw new Error();
  }
};
