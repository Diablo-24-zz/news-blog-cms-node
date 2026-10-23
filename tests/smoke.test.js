process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-with-at-least-32-characters";

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");

const app = createApp({ enableRateLimits: false });

test("health endpoint returns the documented envelope", async () => {
  const response = await request(app).get("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { data: { status: "ok" } });
});

test("unknown routes use the documented error envelope", async () => {
  const response = await request(app).get("/not-a-route");
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "NOT_FOUND");
});
