process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { after, before, test } = require("node:test");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const { loadConfig } = require("../src/config/env");
const { closePool, getPool } = require("../src/config/db");
const { createApp } = require("../src/app");
const { COOKIE_NAME } = require("../src/middleware/auth");
const authService = require("../src/services/authService");

const config = loadConfig();
if (config.DB_NAME_TEST !== "news_cms_test") {
  throw new Error(
    "Integration tests refuse to run unless DB_NAME_TEST is news_cms_test",
  );
}

const app = createApp({ enableRateLimits: false });
const roles = ["writer", "editor", "admin", "super_admin"];
const emailPrefix = `cmsit${randomUUID().replaceAll("-", "")}`;
const password = "Integration-Password-47";
const users = {};
let pool;
let userCounter = 0;

function nextEmail() {
  userCounter += 1;
  return `${emailPrefix}${userCounter}@example.com`;
}

function cookieFor(user) {
  const token = jwt.sign(
    { sub: String(user.id), tv: Number(user.token_version ?? 0) },
    config.JWT_SECRET,
    { expiresIn: "2h" },
  );
  return `${COOKIE_NAME}=${token}`;
}

function as(user, action, url, body) {
  const client = request(action.app || app);
  let call = client[action.method](url).set("Cookie", cookieFor(user));
  if (body !== undefined) call = call.send(body);
  return call;
}

async function addUser(role, name = `${role} fixture`) {
  const email = nextEmail();
  const passwordHash = await bcrypt.hash(password, 12);
  const [result] = await pool.query(
    `INSERT INTO users
      (name, email, password_hash, role, is_active, must_change_password)
     VALUES (?, ?, ?, ?, TRUE, FALSE)`,
    [name, email, passwordHash, role],
  );
  return { id: result.insertId, email, role, name, token_version: 0 };
}

async function addPost(author, status = "draft", title = "Integration post") {
  const slug = `${emailPrefix}-${randomUUID().slice(0, 8)}`;
  const [result] = await pool.query(
    `INSERT INTO posts (author_id, title, slug, content, status, published_at)
     VALUES (?, ?, ?, ?, ?, IF(? = 'published', UTC_TIMESTAMP(), NULL))`,
    [author.id, title, slug, `Content for ${title}`, status, status],
  );
  return { id: result.insertId, slug, authorId: author.id, status, title };
}

before(async () => {
  pool = getPool();
  const [databaseRows] = await pool.query("SELECT DATABASE() AS database_name");
  if (databaseRows[0].database_name !== "news_cms_test") {
    pool = null;
    await closePool();
    throw new Error(
      "Integration tests refuse to write unless connected to news_cms_test",
    );
  }

  users.writer = await addUser("writer", "Writer One");
  users.writer2 = await addUser("writer", "Writer Two");
  users.editor = await addUser("editor", "Editor One");
  users.admin = await addUser("admin", "Admin One");
  users.super_admin = await addUser("super_admin", "Super Admin One");
  users.super_admin2 = await addUser("super_admin", "Super Admin Two");
});

after(async () => {
  if (!pool) return;
  try {
    const pattern = `${emailPrefix}%`;
    const [rows] = await pool.query("SELECT id FROM users WHERE email LIKE ?", [
      pattern,
    ]);
    const ids = rows.map((row) => row.id);
    if (ids.length) {
      const marks = ids.map(() => "?").join(", ");
      await pool.query(
        `DELETE FROM posts WHERE author_id IN (${marks}) OR reviewed_by IN (${marks})`,
        [...ids, ...ids],
      );
      await pool.query(
        `DELETE FROM audit_logs WHERE user_id IN (${marks})`,
        ids,
      );
      await pool.query(`DELETE FROM categories WHERE name LIKE ?`, [pattern]);
      await pool.query(
        "UPDATE users SET created_by = NULL WHERE email LIKE ?",
        [pattern],
      );
      await pool.query("DELETE FROM users WHERE email LIKE ?", [pattern]);
    }
    const [remaining] = await pool.query(
      "SELECT COUNT(*) AS count FROM users WHERE email LIKE ?",
      [pattern],
    );
    assert.equal(
      Number(remaining[0].count),
      0,
      "all integration users are deleted",
    );
  } finally {
    await closePool();
    pool = null;
  }
});

test("permission matrix: every role against each protected action", async () => {
  const expected = {
    createDraft: { writer: 201, editor: 201, admin: 201, super_admin: 201 },
    editOwnDraft: { writer: 200, editor: 200, admin: 200, super_admin: 200 },
    editOtherDraft: { writer: 404, editor: 200, admin: 200, super_admin: 200 },
    submitOwnDraft: { writer: 200, editor: 200, admin: 200, super_admin: 200 },
    approveOther: { writer: 403, editor: 200, admin: 200, super_admin: 200 },
    rejectOther: { writer: 403, editor: 200, admin: 200, super_admin: 200 },
    publishApproved: { writer: 403, editor: 200, admin: 200, super_admin: 200 },
    archivePublished: {
      writer: 403,
      editor: 200,
      admin: 200,
      super_admin: 200,
    },
    deleteOwnDraft: { writer: 200, editor: 200, admin: 200, super_admin: 200 },
    deleteAny: { writer: 404, editor: 404, admin: 200, super_admin: 200 },
    restoreAny: { writer: 403, editor: 403, admin: 200, super_admin: 200 },
    manageCategories: {
      writer: 403,
      editor: 403,
      admin: 201,
      super_admin: 201,
    },
    createWriter: { writer: 403, editor: 403, admin: 201, super_admin: 201 },
    createAdmin: { writer: 403, editor: 403, admin: 403, super_admin: 201 },
    changeWriterRole: {
      writer: 403,
      editor: 403,
      admin: 200,
      super_admin: 200,
    },
    deactivateWriter: {
      writer: 403,
      editor: 403,
      admin: 200,
      super_admin: 200,
    },
    viewAudit: { writer: 403, editor: 403, admin: 403, super_admin: 200 },
  };

  for (const role of roles) {
    const actor = users[role];
    let post;
    let target;
    let response;

    response = await as(actor, { method: "post" }, "/api/posts", {
      title: `Matrix created ${role}`,
      content: "A new draft",
    });
    assert.equal(
      response.status,
      expected.createDraft[role],
      `${role}: create draft`,
    );

    post = await addPost(actor, "draft", `edit-own-${role}`);
    response = await as(actor, { method: "put" }, `/api/posts/${post.id}`, {
      title: `Edited own ${role}`,
      content: "Edited content",
    });
    assert.equal(
      response.status,
      expected.editOwnDraft[role],
      `${role}: edit own draft`,
    );

    post = await addPost(users.writer, "draft", `edit-other-${role}`);
    if (role === "writer") {
      post = await addPost(users.writer2, "draft", `edit-other-${role}`);
    }
    response = await as(actor, { method: "put" }, `/api/posts/${post.id}`, {
      content: "Editing another author's story",
    });
    assert.equal(
      response.status,
      expected.editOtherDraft[role],
      `${role}: edit other draft`,
    );

    post = await addPost(actor, "draft", `submit-${role}`);
    response = await as(
      actor,
      { method: "patch" },
      `/api/posts/${post.id}/submit`,
    );
    assert.equal(
      response.status,
      expected.submitOwnDraft[role],
      `${role}: submit own draft`,
    );

    post = await addPost(users.writer, "pending_review", `approve-${role}`);
    response = await as(
      actor,
      { method: "patch" },
      `/api/posts/${post.id}/approve`,
    );
    assert.equal(
      response.status,
      expected.approveOther[role],
      `${role}: approve another post`,
    );

    post = await addPost(users.writer, "pending_review", `reject-${role}`);
    response = await as(
      actor,
      { method: "patch" },
      `/api/posts/${post.id}/reject`,
      { review_comment: "Needs clearer sourcing" },
    );
    assert.equal(
      response.status,
      expected.rejectOther[role],
      `${role}: reject another post`,
    );

    post = await addPost(users.writer, "approved", `publish-${role}`);
    response = await as(
      actor,
      { method: "patch" },
      `/api/posts/${post.id}/publish`,
      {},
    );
    assert.equal(
      response.status,
      expected.publishApproved[role],
      `${role}: publish approved post`,
    );

    post = await addPost(users.writer, "published", `archive-${role}`);
    response = await as(
      actor,
      { method: "patch" },
      `/api/posts/${post.id}/archive`,
    );
    assert.equal(
      response.status,
      expected.archivePublished[role],
      `${role}: archive published post`,
    );

    post = await addPost(actor, "draft", `delete-own-${role}`);
    response = await as(actor, { method: "delete" }, `/api/posts/${post.id}`);
    assert.equal(
      response.status,
      expected.deleteOwnDraft[role],
      `${role}: delete own draft`,
    );

    post = await addPost(users.writer, "approved", `delete-any-${role}`);
    if (role === "writer") {
      post = await addPost(users.writer2, "approved", `delete-any-${role}`);
    }
    response = await as(actor, { method: "delete" }, `/api/posts/${post.id}`);
    assert.equal(
      response.status,
      expected.deleteAny[role],
      `${role}: delete any post`,
    );

    post = await addPost(users.writer, "draft", `restore-${role}`);
    await pool.query(
      "UPDATE posts SET deleted_at = UTC_TIMESTAMP() WHERE id = ?",
      [post.id],
    );
    response = await as(
      actor,
      { method: "post" },
      `/api/posts/${post.id}/restore`,
    );
    assert.equal(
      response.status,
      expected.restoreAny[role],
      `${role}: restore any post`,
    );

    const categoryName = `${emailPrefix}-${role}-category`;
    response = await as(actor, { method: "post" }, "/api/categories", {
      name: categoryName,
    });
    assert.equal(
      response.status,
      expected.manageCategories[role],
      `${role}: manage categories`,
    );

    response = await as(actor, { method: "post" }, "/api/users", {
      name: `Matrix writer ${role}`,
      email: nextEmail(),
      role: "writer",
    });
    assert.equal(
      response.status,
      expected.createWriter[role],
      `${role}: create writer`,
    );

    response = await as(actor, { method: "post" }, "/api/users", {
      name: `Matrix admin ${role}`,
      email: nextEmail(),
      role: "admin",
    });
    assert.equal(
      response.status,
      expected.createAdmin[role],
      `${role}: create admin`,
    );

    target = await addUser("writer", `Role target ${role}`);
    response = await as(
      actor,
      { method: "patch" },
      `/api/users/${target.id}/role`,
      {
        role: "editor",
      },
    );
    assert.equal(
      response.status,
      expected.changeWriterRole[role],
      `${role}: change writer role`,
    );

    target = await addUser("writer", `Status target ${role}`);
    response = await as(
      actor,
      { method: "patch" },
      `/api/users/${target.id}/status`,
      {
        isActive: false,
      },
    );
    assert.equal(
      response.status,
      expected.deactivateWriter[role],
      `${role}: deactivate writer`,
    );

    response = await as(actor, { method: "get" }, "/api/audit-logs");
    assert.equal(
      response.status,
      expected.viewAudit[role],
      `${role}: view audit log`,
    );
  }
});

test("workflow accepts valid transitions and rejects invalid ones", async () => {
  const invalid = await addPost(users.writer, "draft", "invalid-approve");
  let response = await as(
    users.editor,
    { method: "patch" },
    `/api/posts/${invalid.id}/approve`,
  );
  assert.equal(response.status, 409);

  const missingComment = await addPost(
    users.writer,
    "pending_review",
    "missing-comment",
  );
  response = await as(
    users.editor,
    { method: "patch" },
    `/api/posts/${missingComment.id}/reject`,
    {},
  );
  assert.equal(response.status, 400);

  const post = await addPost(users.writer, "draft", "valid-workflow");
  response = await as(
    users.writer,
    { method: "patch" },
    `/api/posts/${post.id}/submit`,
  );
  assert.equal(response.status, 200);
  response = await as(
    users.editor,
    { method: "patch" },
    `/api/posts/${post.id}/approve`,
  );
  assert.equal(response.status, 200);
  response = await as(
    users.editor,
    { method: "patch" },
    `/api/posts/${post.id}/publish`,
  );
  assert.equal(response.status, 200);
  response = await as(
    users.editor,
    { method: "patch" },
    `/api/posts/${post.id}/archive`,
  );
  assert.equal(response.status, 200);
  response = await as(
    users.editor,
    { method: "patch" },
    `/api/posts/${post.id}/archive`,
  );
  assert.equal(response.status, 409);
});

test("concurrent approve has exactly one success and one conflict", async () => {
  const post = await addPost(
    users.writer,
    "pending_review",
    "concurrent-approve",
  );
  const responses = await Promise.all([
    as(users.editor, { method: "patch" }, `/api/posts/${post.id}/approve`),
    as(users.admin, { method: "patch" }, `/api/posts/${post.id}/approve`),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  );
});

test("reviewing an own post is forbidden except for super admin", async () => {
  const editorPost = await addPost(
    users.editor,
    "pending_review",
    "editor-own-review",
  );
  let response = await as(
    users.editor,
    { method: "patch" },
    `/api/posts/${editorPost.id}/approve`,
  );
  assert.equal(response.status, 403);

  const superPost = await addPost(
    users.super_admin,
    "pending_review",
    "super-admin-own-review",
  );
  response = await as(
    users.super_admin,
    { method: "patch" },
    `/api/posts/${superPost.id}/approve`,
  );
  assert.equal(response.status, 200);
  const [auditRows] = await pool.query(
    "SELECT id FROM audit_logs WHERE user_id = ? AND action = 'post_approve' AND entity_id = ?",
    [users.super_admin.id, superPost.id],
  );
  assert.equal(auditRows.length, 1);
});

test("deactivated users' previously issued tokens immediately return 401", async () => {
  const deactivated = await addUser("writer", "Deactivated token user");
  const cookie = cookieFor(deactivated);
  await pool.query("UPDATE users SET is_active = FALSE WHERE id = ?", [
    deactivated.id,
  ]);
  const response = await request(app).get("/api/auth/me").set("Cookie", cookie);
  assert.equal(response.status, 401);
});

test("tokens without a token version are invalid", async () => {
  const legacyToken = jwt.sign(
    { sub: String(users.writer.id) },
    config.JWT_SECRET,
    { expiresIn: "2h" },
  );
  const response = await request(app)
    .get("/api/auth/me")
    .set("Cookie", `${COOKIE_NAME}=${legacyToken}`);
  assert.equal(response.status, 401);
});

test("login rejects passwords longer than 72 UTF-8 bytes", async () => {
  const tooLongAscii = await request(app)
    .post("/api/auth/login")
    .send({
      email: nextEmail(),
      password: "a".repeat(73),
    });
  assert.equal(tooLongAscii.status, 400);

  const tooLongUnicode = await request(app)
    .post("/api/auth/login")
    .send({
      email: nextEmail(),
      password: "😀".repeat(19),
    });
  assert.equal(tooLongUnicode.status, 400);

  const withinByteLimit = await request(app)
    .post("/api/auth/login")
    .send({
      email: nextEmail(),
      password: "😀".repeat(18),
    });
  assert.equal(withinByteLimit.status, 401);
});

test("logout always returns 200 and expires the auth cookie", async () => {
  const revoked = await addUser("writer", "Revoked logout token user");
  const revokedCookie = cookieFor(revoked);
  await pool.query(
    "UPDATE users SET token_version = token_version + 1 WHERE id = ?",
    [revoked.id],
  );

  const deactivated = await addUser("writer", "Inactive logout token user");
  const deactivatedCookie = cookieFor(deactivated);
  await pool.query("UPDATE users SET is_active = FALSE WHERE id = ?", [
    deactivated.id,
  ]);

  const expiredToken = jwt.sign(
    { sub: String(users.writer.id), tv: users.writer.token_version },
    config.JWT_SECRET,
    { expiresIn: -10 },
  );
  const cookies = [
    cookieFor(users.writer),
    `${COOKIE_NAME}=${expiredToken}`,
    revokedCookie,
    deactivatedCookie,
    `${COOKIE_NAME}=garbage`,
    undefined,
  ];

  for (const cookie of cookies) {
    let call = request(app).post("/api/auth/logout");
    if (cookie) call = call.set("Cookie", cookie);
    const response = await call;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { data: { loggedOut: true } });
    const header = response.headers["set-cookie"]?.find((value) =>
      value.startsWith(`${COOKIE_NAME}=`),
    );
    assert.ok(header, "logout always sends a replacement cookie header");
    assert.match(header, new RegExp(`^${COOKIE_NAME}=;`));
    assert.match(header, /Path=\//i);
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Strict/i);
    const expiry = header.match(/Expires=([^;]+)/i);
    assert.ok(expiry);
    assert.ok(Date.parse(expiry[1]) < Date.now());
    assert.equal(/;\s*Secure/i.test(header), config.COOKIE_SECURE);
  }
});

test("deactivation revokes tokens permanently across reactivation", async () => {
  const target = await addUser("writer", "Deactivation revocation user");
  const oldCookie = cookieFor(target);
  const deactivated = await as(
    users.admin,
    { method: "patch" },
    `/api/users/${target.id}/status`,
    { isActive: false },
  );
  assert.equal(deactivated.status, 200);
  const [versionRows] = await pool.query(
    "SELECT token_version FROM users WHERE id = ?",
    [target.id],
  );
  assert.equal(Number(versionRows[0].token_version), 1);

  let oldSession = await request(app)
    .get("/api/auth/me")
    .set("Cookie", oldCookie);
  assert.equal(oldSession.status, 401);

  const reactivated = await as(
    users.admin,
    { method: "patch" },
    `/api/users/${target.id}/status`,
    { isActive: true },
  );
  assert.equal(reactivated.status, 200);
  oldSession = await request(app).get("/api/auth/me").set("Cookie", oldCookie);
  assert.equal(oldSession.status, 401);

  const freshLogin = await request(app).post("/api/auth/login").send({
    email: target.email,
    password,
  });
  assert.equal(freshLogin.status, 200);
  const freshCookie = freshLogin.headers["set-cookie"][0].split(";")[0];
  const freshSession = await request(app)
    .get("/api/auth/me")
    .set("Cookie", freshCookie);
  assert.equal(freshSession.status, 200);
});

test("a role change applies to an already-issued token on the next request", async () => {
  const promoted = await addUser("writer", "Immediately promoted");
  const cookie = cookieFor(promoted);
  const post = await addPost(
    users.writer,
    "pending_review",
    "role-change-review",
  );
  let response = await request(app)
    .patch(`/api/posts/${post.id}/approve`)
    .set("Cookie", cookie);
  assert.equal(response.status, 403);
  response = await as(
    users.admin,
    { method: "patch" },
    `/api/users/${promoted.id}/role`,
    { role: "editor" },
  );
  assert.equal(response.status, 200);
  response = await request(app)
    .patch(`/api/posts/${post.id}/approve`)
    .set("Cookie", cookie);
  assert.equal(response.status, 200);
});

test("an admin cannot create admin accounts", async () => {
  const response = await as(users.admin, { method: "post" }, "/api/users", {
    name: "Forbidden admin",
    email: nextEmail(),
    role: "admin",
  });
  assert.equal(response.status, 403);
});

test("all user detail routes reject invalid ids with 400", async () => {
  const cases = [
    as(users.admin, { method: "patch" }, "/api/users/not-an-id/role", {
      role: "editor",
    }),
    as(users.admin, { method: "patch" }, "/api/users/not-an-id/status", {
      isActive: false,
    }),
    as(users.admin, { method: "post" }, "/api/users/not-an-id/reset-password"),
  ];
  const responses = await Promise.all(cases);
  assert.deepEqual(
    responses.map((response) => response.status),
    [400, 400, 400],
  );
});

test("the last active super admin cannot be demoted or deactivated", async () => {
  let response = await as(
    users.super_admin,
    { method: "patch" },
    `/api/users/${users.super_admin.id}/role`,
    { role: "admin" },
  );
  assert.equal(response.status, 403, "users cannot change their own role");
  response = await as(
    users.super_admin,
    { method: "patch" },
    `/api/users/${users.super_admin.id}/status`,
    { isActive: false },
  );
  assert.equal(response.status, 403, "users cannot deactivate themselves");

  const concurrent = await Promise.all([
    as(
      users.super_admin,
      { method: "patch" },
      `/api/users/${users.super_admin2.id}/status`,
      { isActive: false },
    ),
    as(
      users.super_admin2,
      { method: "patch" },
      `/api/users/${users.super_admin.id}/status`,
      { isActive: false },
    ),
  ]);
  assert.deepEqual(concurrent.map((item) => item.status).sort(), [200, 409]);
  const [activeRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'super_admin' AND is_active = TRUE",
  );
  assert.equal(Number(activeRows[0].total), 1);
  await pool.query("UPDATE users SET is_active = TRUE WHERE id IN (?, ?)", [
    users.super_admin.id,
    users.super_admin2.id,
  ]);
});

test("writers cannot view another writer's post and receive 404", async () => {
  const post = await addPost(users.writer2, "draft", "private-to-writer-two");
  const response = await as(
    users.writer,
    { method: "get" },
    `/api/posts/${post.id}`,
  );
  assert.equal(response.status, 404);
});

test("public endpoints hide unpublished, deleted, and future-scheduled posts", async () => {
  const draft = await addPost(users.writer, "draft", "hidden-unpublished");
  const deleted = await addPost(users.writer, "published", "hidden-deleted");
  const future = await addPost(users.writer, "published", "hidden-future");
  await pool.query(
    "UPDATE posts SET deleted_at = UTC_TIMESTAMP() WHERE id = ?",
    [deleted.id],
  );
  await pool.query(
    "UPDATE posts SET published_at = '2099-01-01 00:00:00' WHERE id = ?",
    [future.id],
  );

  for (const post of [draft, deleted, future]) {
    const response = await request(app).get(`/api/posts/public/${post.slug}`);
    assert.equal(response.status, 404, post.title);
  }
  const list = await request(app).get("/api/posts/public").query({
    search: "hidden-",
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 0);
  const [viewRows] = await pool.query(
    "SELECT post_id FROM post_views WHERE post_id IN (?, ?, ?)",
    [draft.id, deleted.id, future.id],
  );
  assert.equal(viewRows.length, 0);
});

test("public views count once per visitor and post per UTC day", async () => {
  const post = await addPost(users.writer, "published", "daily-view-count");
  const sameVisitor = () =>
    request(app)
      .get(`/api/posts/public/${post.slug}`)
      .set("User-Agent", "daily-view-test-agent");
  const concurrent = await Promise.all([sameVisitor(), sameVisitor()]);
  assert.deepEqual(
    concurrent.map((response) => response.status),
    [200, 200],
  );
  assert.deepEqual(
    concurrent.map((response) => response.body.data.views),
    [1, 1],
  );

  const repeat = await sameVisitor();
  assert.equal(repeat.body.data.views, 1);
  const otherVisitor = await request(app)
    .get(`/api/posts/public/${post.slug}`)
    .set("User-Agent", "different-view-test-agent");
  assert.equal(otherVisitor.body.data.views, 2);

  const [views] = await pool.query(
    "SELECT visitor_hash, view_date FROM post_views WHERE post_id = ?",
    [post.id],
  );
  assert.equal(views.length, 2);
  for (const view of views) {
    assert.match(view.visitor_hash, /^[a-f0-9]{64}$/);
    assert.equal(view.visitor_hash.includes("daily-view-test-agent"), false);
  }
  const [postRows] = await pool.query("SELECT views FROM posts WHERE id = ?", [
    post.id,
  ]);
  assert.equal(Number(postRows[0].views), 2);

  const expectedHashes = ["::ffff:127.0.0.1", "127.0.0.1"].map((ip) =>
    createHash("sha256")
      .update(`${ip}daily-view-test-agent${config.JWT_SECRET}`)
      .digest("hex"),
  );
  assert.ok(views.some((view) => expectedHashes.includes(view.visitor_hash)));
});

test("restoring a soft-deleted post preserves its prior workflow status", async () => {
  const post = await addPost(
    users.writer,
    "approved",
    "restore-preserves-status",
  );
  let response = await as(
    users.admin,
    { method: "delete" },
    `/api/posts/${post.id}`,
  );
  assert.equal(response.status, 200);
  response = await as(
    users.admin,
    { method: "post" },
    `/api/posts/${post.id}/restore`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, "approved");
  assert.equal(response.body.data.deleted_at, null);
});

test("slug collisions get suffixes and a published post keeps its slug", async () => {
  const title = `Collision story ${emailPrefix}`;
  const first = await as(users.writer, { method: "post" }, "/api/posts", {
    title,
    content: "First copy",
  });
  const second = await as(users.writer, { method: "post" }, "/api/posts", {
    title,
    content: "Second copy",
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.data.slug, `${first.body.data.slug}-2`);

  const postId = first.body.data.id;
  await as(users.writer, { method: "patch" }, `/api/posts/${postId}/submit`);
  await as(users.editor, { method: "patch" }, `/api/posts/${postId}/approve`);
  const published = await as(
    users.editor,
    { method: "patch" },
    `/api/posts/${postId}/publish`,
    {},
  );
  assert.equal(published.status, 200);
  const slug = published.body.data.slug;
  const edited = await as(
    users.admin,
    { method: "put" },
    `/api/posts/${postId}`,
    {
      title: `${title} updated after publication`,
    },
  );
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.slug, slug);
});

test("scheduled publication requires a timezone and stores the instant in UTC", async () => {
  const post = await addPost(users.writer, "draft", "scheduled-utc");
  await as(users.writer, { method: "patch" }, `/api/posts/${post.id}/submit`);
  await as(users.editor, { method: "patch" }, `/api/posts/${post.id}/approve`);

  let response = await as(
    users.editor,
    { method: "patch" },
    `/api/posts/${post.id}/publish`,
    { publish_at: "2099-01-01T00:00:00" },
  );
  assert.equal(response.status, 400);

  response = await as(
    users.editor,
    { method: "patch" },
    `/api/posts/${post.id}/publish`,
    { publish_at: "2099-01-01T00:00:00+05:30" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.data.published_at, "2098-12-31T18:30:00.000Z");
  response = await request(app).get(`/api/posts/public/${post.slug}`);
  assert.equal(response.status, 404);
});

test("content edits save revisions and restoring a revision creates another revision", async () => {
  const post = await addPost(users.writer, "draft", "revision-original");
  const oldContent = `Content for ${post.title}`;
  const update = await as(
    users.writer,
    { method: "put" },
    `/api/posts/${post.id}`,
    {
      title: "revision-updated",
      content: "Updated text",
    },
  );
  assert.equal(update.status, 200);
  let revisions = await as(
    users.writer,
    { method: "get" },
    `/api/posts/${post.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.equal(revisions.body.data.length, 1);
  const oldRevisionId = revisions.body.data[0].id;
  assert.equal(revisions.body.data[0].content, oldContent);

  const restored = await as(
    users.admin,
    { method: "post" },
    `/api/posts/${post.id}/revisions/${oldRevisionId}/restore`,
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.title, post.title);
  assert.equal(restored.body.data.content, oldContent);
  revisions = await as(
    users.writer,
    { method: "get" },
    `/api/posts/${post.id}/revisions`,
  );
  assert.equal(revisions.body.data.length, 2);
});

test("a category in use by a post cannot be deleted", async () => {
  const categoryResponse = await as(
    users.admin,
    { method: "post" },
    "/api/categories",
    { name: `${emailPrefix}-protected-category` },
  );
  assert.equal(categoryResponse.status, 201);
  const postResponse = await as(
    users.writer,
    { method: "post" },
    "/api/posts",
    {
      title: "category-in-use",
      content: "Uses a category",
      category_id: categoryResponse.body.data.id,
    },
  );
  assert.equal(postResponse.status, 201);
  const deleted = await as(
    users.admin,
    { method: "delete" },
    `/api/categories/${categoryResponse.body.data.id}`,
  );
  assert.equal(deleted.status, 409);
});

test("temporary passwords force a change and are not copied into audit details", async () => {
  const email = nextEmail();
  const created = await as(users.admin, { method: "post" }, "/api/users", {
    name: "Temporary account",
    email,
    role: "writer",
  });
  assert.equal(created.status, 201);
  const temporaryPassword = created.body.data.temporaryPassword;
  assert.ok(temporaryPassword);
  const [newUsers] = await pool.query("SELECT id FROM users WHERE email = ?", [
    email,
  ]);
  const temporaryUser = {
    id: newUsers[0].id,
    email,
    role: "writer",
    token_version: 0,
  };
  const cookie = cookieFor(temporaryUser);

  let response = await request(app)
    .post("/api/posts")
    .set("Cookie", cookie)
    .send({ title: "Blocked until changed", content: "Temporary password" });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "PASSWORD_CHANGE_REQUIRED");

  const [auditRows] = await pool.query(
    "SELECT details FROM audit_logs WHERE entity = 'user' AND entity_id = ? AND action = 'user_create'",
    [temporaryUser.id],
  );
  assert.equal(
    JSON.stringify(auditRows[0].details).includes(temporaryPassword),
    false,
  );

  response = await request(app)
    .post("/api/auth/change-password")
    .set("Cookie", cookie)
    .send({
      currentPassword: temporaryPassword,
      newPassword: "😀".repeat(19),
    });
  assert.equal(response.status, 400);
  response = await request(app)
    .post("/api/auth/change-password")
    .set("Cookie", cookie)
    .send({
      currentPassword: "😀".repeat(19),
      newPassword: "Permanent-Password-53",
    });
  assert.equal(response.status, 400);

  response = await request(app)
    .post("/api/auth/change-password")
    .set("Cookie", cookie)
    .send({
      currentPassword: temporaryPassword,
      newPassword: "Permanent-Password-53",
    });
  assert.equal(response.status, 200);
  const freshCookie = response.headers["set-cookie"][0].split(";")[0];
  const oldSession = await request(app)
    .get("/api/auth/me")
    .set("Cookie", cookie);
  assert.equal(oldSession.status, 401);
  const continuedSession = await request(app)
    .get("/api/auth/me")
    .set("Cookie", freshCookie);
  assert.equal(continuedSession.status, 200);
  response = await request(app)
    .post("/api/posts")
    .set("Cookie", freshCookie)
    .send({ title: "Allowed after change", content: "Password changed" });
  assert.equal(response.status, 201);
});

test("temporary passwords from password reset also require a change", async () => {
  const target = await addUser("writer", "Reset target");
  const oldCookie = cookieFor(target);
  const reset = await as(
    users.admin,
    { method: "post" },
    `/api/users/${target.id}/reset-password`,
  );
  assert.equal(reset.status, 200);
  const oldSession = await request(app)
    .get("/api/auth/me")
    .set("Cookie", oldCookie);
  assert.equal(oldSession.status, 401);
  const login = await request(app).post("/api/auth/login").send({
    email: target.email,
    password: reset.body.data.temporaryPassword,
  });
  assert.equal(login.status, 200);
  const freshCookie = login.headers["set-cookie"][0].split(";")[0];
  const blocked = await request(app)
    .get("/api/posts")
    .set("Cookie", freshCookie);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, "PASSWORD_CHANGE_REQUIRED");
});

test("audit rows are persisted for user creation and post transitions", async () => {
  const post = await addPost(users.writer, "draft", "audit-transition");
  const transition = await as(
    users.writer,
    { method: "patch" },
    `/api/posts/${post.id}/submit`,
  );
  assert.equal(transition.status, 200);
  const created = await as(users.admin, { method: "post" }, "/api/users", {
    name: "Audited writer",
    email: nextEmail(),
    role: "writer",
  });
  assert.equal(created.status, 201);
  const [rows] = await pool.query(
    "SELECT action FROM audit_logs WHERE entity_id = ? ORDER BY id",
    [post.id],
  );
  assert.ok(rows.some((row) => row.action === "post_submit"));
});

test("SQL injection strings are parameterized and sort columns are allowlisted", async () => {
  const injection = "' OR 1=1 --";
  const search = await as(users.editor, { method: "get" }, "/api/posts").query({
    search: injection,
  });
  assert.equal(search.status, 200);

  const unsafeSort = await as(
    users.editor,
    { method: "get" },
    "/api/posts",
  ).query({ sort: "title DESC, (SELECT SLEEP(1))" });
  assert.equal(unsafeSort.status, 400);

  const publicSearch = await request(app)
    .get("/api/posts/public")
    .query({ search: injection });
  assert.equal(publicSearch.status, 200);
  const [tableRows] = await pool.query(
    "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'",
  );
  assert.equal(Number(tableRows[0].count), 1);
});

test("search treats LIKE metacharacters as literal text in posts and users", async () => {
  const literal = `${emailPrefix}-100%_\\-literal`;
  const post = await addPost(users.writer, "published", `Story ${literal}`);
  const searchableUser = await addUser("writer", `Writer ${literal}`);

  const postSearch = await as(
    users.admin,
    { method: "get" },
    "/api/posts",
  ).query({ search: literal });
  assert.equal(postSearch.status, 200);
  assert.deepEqual(
    postSearch.body.data.map((item) => item.id),
    [post.id],
  );

  const publicSearch = await request(app)
    .get("/api/posts/public")
    .query({ search: literal });
  assert.equal(publicSearch.status, 200);
  assert.deepEqual(
    publicSearch.body.data.map((item) => item.id),
    [post.id],
  );

  const userSearch = await as(
    users.admin,
    { method: "get" },
    "/api/users",
  ).query({ search: literal });
  assert.equal(userSearch.status, 200);
  assert.deepEqual(
    userSearch.body.data.map((item) => item.id),
    [searchableUser.id],
  );
});

test("XSS-looking post content is returned as plain text", async () => {
  const content = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const post = await addPost(users.writer, "published", "xss-plain-text");
  await pool.query("UPDATE posts SET content = ? WHERE id = ?", [
    content,
    post.id,
  ]);
  const response = await request(app).get(`/api/posts/public/${post.slug}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.content, content);
});

test("write rate limiter returns 429 when limiters are enabled in test mode", async () => {
  const limitedApp = createApp({ enableRateLimits: true });
  for (let index = 0; index < 60; index += 1) {
    const response = await request(limitedApp).post("/api/posts").send({});
    assert.equal(response.status, 401, `write request ${index + 1}`);
  }
  const limited = await request(limitedApp).post("/api/posts").send({});
  assert.equal(limited.status, 429);
});

test("five failed logins throttle a normalized email whether it exists or not", async () => {
  const unknownEmail = nextEmail();
  let response;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    response = await request(app).post("/api/auth/login").send({
      email: unknownEmail,
      password: "Wrong-Password-53",
    });
    assert.equal(response.status, 401);
  }
  const unknownBlocked = await request(app)
    .post("/api/auth/login")
    .send({ email: unknownEmail.toUpperCase(), password: "Wrong-Password-53" });
  assert.equal(unknownBlocked.status, 429);

  const knownUser = await addUser("writer", "Account throttle user");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    response = await request(app).post("/api/auth/login").send({
      email: knownUser.email,
      password: "Wrong-Password-53",
    });
    assert.equal(response.status, 401);
  }
  const knownBlocked = await request(app)
    .post("/api/auth/login")
    .send({ email: knownUser.email, password: "Wrong-Password-53" });
  assert.equal(knownBlocked.status, 429);
  assert.equal(
    unknownBlocked.body.error.message,
    knownBlocked.body.error.message,
  );
  assert.equal(
    knownBlocked.body.error.message,
    authService.LOGIN_THROTTLE_MESSAGE,
  );
});

test("successful login clears the per-account failure counter", async () => {
  const account = await addUser("writer", "Throttle reset user");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const failed = await request(app).post("/api/auth/login").send({
      email: account.email,
      password: "Wrong-Password-53",
    });
    assert.equal(failed.status, 401);
  }
  const success = await request(app).post("/api/auth/login").send({
    email: account.email,
    password,
  });
  assert.equal(success.status, 200);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await request(app).post("/api/auth/login").send({
      email: account.email,
      password: "Wrong-Password-53",
    });
    assert.equal(failed.status, 401);
  }
  const blocked = await request(app).post("/api/auth/login").send({
    email: account.email,
    password: "Wrong-Password-53",
  });
  assert.equal(blocked.status, 429);
});

test("the existing per-IP login limit remains enabled", async () => {
  const ipLimitedApp = createApp({ enableRateLimits: true });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await request(ipLimitedApp)
      .post("/api/auth/login")
      .send({ email: nextEmail(), password: "Wrong-Password-53" });
    assert.equal(response.status, 401, `IP login request ${attempt + 1}`);
  }
  const limited = await request(ipLimitedApp)
    .post("/api/auth/login")
    .send({ email: nextEmail(), password: "Wrong-Password-53" });
  assert.equal(limited.status, 429);
});

test("dummy bcrypt hash is valid and unknown-email timing matches wrong-password timing", async () => {
  const dummyHash = authService.DUMMY_PASSWORD_HASH;
  assert.equal(dummyHash.length, 60);
  assert.match(dummyHash, /^\$2[aby]\$12\$/);
  assert.equal(
    await bcrypt.compare("not-the-dummy-password", dummyHash),
    false,
  );

  async function measure(email) {
    const started = performance.now();
    await assert.rejects(
      authService.login(email, "Wrong-Password-53"),
      (error) => error.status === 401,
    );
    return performance.now() - started;
  }

  const known = [];
  const unknown = [];
  for (let index = 0; index < 5; index += 1) {
    known.push(await measure(users.writer.email));
    unknown.push(await measure(`${emailPrefix}-absent-${index}@example.com`));
  }
  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const knownMedian = median(known);
  const unknownMedian = median(unknown);
  const toleranceMs = Math.max(300, knownMedian * 0.75);
  assert.ok(
    Math.abs(knownMedian - unknownMedian) <= toleranceMs,
    `timing medians differ too much: known=${knownMedian.toFixed(1)}ms, unknown=${unknownMedian.toFixed(1)}ms, tolerance=${toleranceMs.toFixed(1)}ms`,
  );
  process.stdout.write(
    `login timing medians: wrong-password=${knownMedian.toFixed(1)}ms, unknown-email=${unknownMedian.toFixed(1)}ms, tolerance=${toleranceMs.toFixed(1)}ms\n`,
  );
});
