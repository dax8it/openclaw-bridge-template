#!/usr/bin/env node
"use strict";

const crypto = require("crypto");

const value = process.argv[2];
if (!value) {
  console.error("Usage: node bridge/hash-key.js <plain-api-key>");
  process.exit(1);
}

const hash = crypto.createHash("sha256").update(value).digest("hex");
console.log(hash);
