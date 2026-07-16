/**
 * Coverage for the SSRF IP-range guard behind the "import guideline PDF by
 * URL" feature — the one thing here worth unit testing without a live network
 * call is that private/loopback/reserved addresses are actually rejected
 * (the part of `fetchUrlSafely` a bad range check would silently defeat).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateOrReservedIp } from "./safeUrlFetch.js";

test("isPrivateOrReservedIp rejects loopback and private IPv4 ranges", () => {
  assert.equal(isPrivateOrReservedIp("127.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("10.0.0.5"), true);
  assert.equal(isPrivateOrReservedIp("172.16.0.1"), true);
  assert.equal(isPrivateOrReservedIp("172.31.255.255"), true);
  assert.equal(isPrivateOrReservedIp("192.168.1.1"), true);
  assert.equal(isPrivateOrReservedIp("169.254.169.254"), true); // cloud metadata endpoint
  assert.equal(isPrivateOrReservedIp("0.0.0.0"), true);
});

test("isPrivateOrReservedIp accepts public IPv4 addresses", () => {
  assert.equal(isPrivateOrReservedIp("8.8.8.8"), false);
  assert.equal(isPrivateOrReservedIp("1.1.1.1"), false);
  // just outside the 172.16.0.0/12 private block
  assert.equal(isPrivateOrReservedIp("172.32.0.1"), false);
});

test("isPrivateOrReservedIp rejects loopback and link-local/unique-local IPv6", () => {
  assert.equal(isPrivateOrReservedIp("::1"), true);
  assert.equal(isPrivateOrReservedIp("::"), true);
  assert.equal(isPrivateOrReservedIp("fe80::1"), true);
  assert.equal(isPrivateOrReservedIp("fc00::1"), true);
  assert.equal(isPrivateOrReservedIp("fd12:3456:789a::1"), true);
});

test("isPrivateOrReservedIp accepts public IPv6 and rejects IPv4-mapped private addresses", () => {
  assert.equal(isPrivateOrReservedIp("2606:4700:4700::1111"), false); // public (Cloudflare DNS)
  assert.equal(isPrivateOrReservedIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("::ffff:8.8.8.8"), false);
});

test("isPrivateOrReservedIp treats non-IP input as unsafe", () => {
  assert.equal(isPrivateOrReservedIp("not-an-ip"), true);
  assert.equal(isPrivateOrReservedIp(""), true);
});
