const test = require("node:test");
const assert = require("node:assert/strict");
const { authorize, isAtLeast } = require("../src/utils/roles");
const { TRANSITIONS } = require("../src/services/postService");

test("role ranks are ordered from writer to super admin", () => {
  assert.equal(isAtLeast("writer", "writer"), true);
  assert.equal(isAtLeast("writer", "editor"), false);
  assert.equal(isAtLeast("admin", "editor"), true);
  assert.equal(isAtLeast("super_admin", "super_admin"), true);
});

test("permission matrix is table-driven", () => {
  const cases = [
    ["writer", "writer", null],
    ["writer", "editor", 403],
    ["editor", "editor", null],
    ["editor", "admin", 403],
    ["admin", "admin", null],
    ["admin", "super_admin", 403],
    ["super_admin", "super_admin", null],
  ];
  for (const [role, minimum, expectedStatus] of cases) {
    const req = { user: { role } };
    let nextError;
    authorize(minimum)(req, {}, (error) => {
      nextError = error;
    });
    assert.equal(
      nextError?.status || null,
      expectedStatus,
      `${role} vs ${minimum}`,
    );
  }
});

test("workflow transitions are centralized and explicit", () => {
  assert.deepEqual(TRANSITIONS, {
    submit: { from: "draft", to: "pending_review" },
    approve: { from: "pending_review", to: "approved" },
    reject: { from: "pending_review", to: "rejected" },
    publish: { from: "approved", to: "published" },
    archive: { from: "published", to: "archived" },
  });
});
